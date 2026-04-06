#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const packageJson = require("../package.json");

const cwd = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const registryHost = "registry.npmjs.org";
const npmToken = process.env.NPM_TOKEN;

main();

function main() {
  ensureNpmInstalled();
  withAuthConfig((auth) => {
    ensureAuthenticated(auth);
    ensurePackageNameLooksAvailable(auth);
    runNpm(["pack", "--dry-run"], auth);

    const publishArgs = ["publish", "--access", "public"];
    if (isDryRun) {
      publishArgs.push("--dry-run");
    }

    runNpm(publishArgs, auth, true);
  });
}

function ensureNpmInstalled() {
  const result = spawnSync("which", ["npm"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail("npm is not installed or not on PATH.");
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

function ensurePackageNameLooksAvailable(auth) {
  const result = runNpm(["view", packageJson.name, "name"], auth, false, true);

  if (result.status === 0) {
    // Package exists — check if we own it by seeing if this version is already published
    const versionResult = runNpm(
      ["view", `${packageJson.name}@${packageJson.version}`, "version"],
      auth, false, true
    );
    if (versionResult.status === 0) {
      fail([
        `Version ${packageJson.version} of "${packageJson.name}" is already published.`,
        "Bump the version in package.json before publishing."
      ].join("\n"));
    }
    // Package exists but this version is new — that's fine, proceed
  }
  // If status !== 0, package doesn't exist yet — also fine
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
