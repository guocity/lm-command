#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const packageJson = require("../package.json");

const cwd = path.resolve(__dirname, "..");
const packageJsonPath = path.join(cwd, "package.json");
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const registryHost = "registry.npmjs.org";
const npmToken = process.env.NPM_TOKEN;

main();

function main() {
  ensureNpmInstalled();
  ensureGitInstalled();

  withAuthConfig((auth) => {
    ensureAuthenticated(auth);
    const publishVersion = resolvePublishVersion(auth);
    const gitRelease = isDryRun ? describeGitRelease(publishVersion) : ensureGitReleaseReady(publishVersion);

    withPackageVersion(publishVersion, !isDryRun, () => {
      runNpm(["pack", "--dry-run"], auth);

      if (isDryRun) {
        printDryRunGitPlan(gitRelease);
      } else {
        createGitReleaseCommit(gitRelease);
      }

      const publishArgs = ["publish", "--access", "public"];
      if (isDryRun) {
        publishArgs.push("--dry-run");
      }

      runNpm(publishArgs, auth, true);

      if (!isDryRun) {
        pushGitRelease(gitRelease);
      }
    });
  });
}

function ensureNpmInstalled() {
  const result = spawnSync("which", ["npm"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail("npm is not installed or not on PATH.");
  }
}

function ensureGitInstalled() {
  const result = spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail("git is not installed or not on PATH.");
  }
}

function withAuthConfig(callback) {
  if (!npmToken) {
    callback({});
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-command-npm-"));
  const userConfigPath = path.join(tempDir, ".npmrc");
  const lines = [
    `//${registryHost}/:_authToken=${npmToken}`,
    `registry=https://${registryHost}/`
  ];
  fs.writeFileSync(userConfigPath, lines.join("\n") + "\n");

  try {
    callback({
      userConfigPath
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ensureAuthenticated(auth) {
  const result = runNpm(["whoami"], auth, false, true);

  const username = result.stdout.trim();
  if (!username) {
    if (npmToken) {
      fail("NPM_TOKEN is set, but npm authentication did not return a username.");
    }
    fail([
      "You are not logged in to npm.",
      "Set NPM_TOKEN in your shell profile or run `npm login`, then try again."
    ].join("\n"));
  }

  console.log(`Publishing as npm user: ${username}`);
}

function resolvePublishVersion(auth) {
  const publishedVersion = getPublishedVersion(auth);
  const localVersion = packageJson.version;

  if (!publishedVersion) {
    console.log(`Package is not published yet. Using local version ${localVersion}.`);
    return localVersion;
  }

  if (compareVersions(localVersion, publishedVersion) > 0) {
    console.log(`Using local version ${localVersion} because it is newer than npm's ${publishedVersion}.`);
    return localVersion;
  }

  const nextVersion = bumpPatchVersion(publishedVersion);
  console.log(`Auto-bumping version from ${localVersion} to ${nextVersion} for publish.`);
  return nextVersion;
}

function getPublishedVersion(auth) {
  const result = runNpm(["view", packageJson.name, "version"], auth, false, true);
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function withPackageVersion(version, persist, callback) {
  const originalContents = fs.readFileSync(packageJsonPath, "utf8");
  const originalPackageJson = JSON.parse(originalContents);
  const shouldRewrite = originalPackageJson.version !== version;

  if (shouldRewrite) {
    const nextPackageJson = {
      ...originalPackageJson,
      version
    };
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPackageJson, null, 2)}\n`);
  }

  try {
    callback();
  } finally {
    if (!persist && shouldRewrite) {
      fs.writeFileSync(packageJsonPath, originalContents);
    }
  }
}

function describeGitRelease(version) {
  const branchResult = runGit(["branch", "--show-current"], false, true);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || "main" : "main";

  return {
    branch,
    remote: "origin",
    tag: `v${version}`,
    version,
    commitMessage: `release: v${version}`
  };
}

function ensureGitReleaseReady(version) {
  const insideResult = runGit(["rev-parse", "--is-inside-work-tree"], false, true);
  if (insideResult.status !== 0 || insideResult.stdout.trim() !== "true") {
    fail("Release publishing must be run inside a git repository.");
  }

  const branchResult = runGit(["branch", "--show-current"], false, true);
  const branch = branchResult.stdout.trim();
  if (!branch) {
    fail("Could not determine the current git branch.");
  }

  const remoteResult = runGit(["remote", "get-url", "origin"], false, true);
  if (remoteResult.status !== 0) {
    fail("Could not find git remote 'origin'.");
  }

  const statusResult = runGit(["status", "--porcelain"], false, true);
  if (statusResult.status !== 0) {
    fail("Could not inspect git working tree state.");
  }

  const dirtyFiles = statusResult.stdout.trim();
  if (dirtyFiles) {
    fail([
      "Release publishing requires a clean git working tree.",
      "Commit or stash your changes first, then run the publish script again."
    ].join("\n"));
  }

  const tag = `v${version}`;
  const tagResult = runGit(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], false, true);
  if (tagResult.status === 0) {
    fail(`Git tag ${tag} already exists locally. Remove it or choose a new version.`);
  }

  return {
    branch,
    remote: "origin",
    tag,
    version,
    commitMessage: `release: v${version}`
  };
}

function printDryRunGitPlan(gitRelease) {
  console.log([
    `Dry run: would create git commit "${gitRelease.commitMessage}"`,
    `Dry run: would create tag ${gitRelease.tag}`,
    `Dry run: would push ${gitRelease.remote}/${gitRelease.branch} and tag ${gitRelease.tag}`
  ].join("\n"));
}

function createGitReleaseCommit(gitRelease) {
  runGit(["add", "package.json"], true);
  runGit(["commit", "-m", gitRelease.commitMessage], true);
  runGit(["tag", gitRelease.tag], true);
}

function pushGitRelease(gitRelease) {
  runGit(["push", gitRelease.remote, gitRelease.branch], true);
  runGit(["push", gitRelease.remote, gitRelease.tag], true);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function bumpPatchVersion(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`Unsupported version format "${version}". Expected x.y.z`);
  }

  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function runGit(commandArgs, inherit = false, allowFailure = false) {
  const result = spawnSync("git", commandArgs, {
    cwd,
    stdio: inherit ? "inherit" : "pipe",
    encoding: inherit ? undefined : "utf8"
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    if (allowFailure) {
      return result;
    }

    if (!inherit) {
      const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      fail(message || `git ${commandArgs.join(" ")} failed.`);
    }
    process.exit(result.status ?? 1);
  }

  if (!inherit && result.stdout) {
    process.stdout.write(result.stdout);
  }

  return result;
}

function runNpm(commandArgs, auth = {}, inherit = false, allowFailure = false) {
  const env = {
    ...process.env
  };
  if (auth.userConfigPath) {
    env.npm_config_userconfig = auth.userConfigPath;
  }

  const result = spawnSync("npm", commandArgs, {
    cwd,
    env,
    stdio: inherit ? "inherit" : "pipe",
    encoding: inherit ? undefined : "utf8"
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    if (allowFailure) {
      return result;
    }

    if (!inherit) {
      const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      fail(message || `npm ${commandArgs.join(" ")} failed.`);
    }
    process.exit(result.status ?? 1);
  }

  if (!inherit && result.stdout) {
    process.stdout.write(result.stdout);
  }

  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
