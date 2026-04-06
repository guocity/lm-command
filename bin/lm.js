#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_REPO = "litert-community/gemma-4-E2B-it-litert-lm";
const DEFAULT_MODEL_NAME = "gemma-4-E2B-it.litertlm";
const DEFAULT_BACKEND = "gpu";
const VALID_BACKENDS = new Set(["cpu", "gpu"]);
const CONFIG_DIR_NAME = "lm-command";
const LEGACY_CONFIG_DIR_NAME = "lm-cli";

function main() {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0) {
      printHelp();
      process.exit(0);
    }

    if (hasFlag(args, "--help", "-h")) {
      printHelp();
      process.exit(0);
    }

    if (hasFlag(args, "--version", "-v")) {
      console.log(require("../package.json").version);
      process.exit(0);
    }

    const command = args[0];

    if (command === "run") {
      runPrompt(args.slice(1));
      return;
    }

    if (command === "backend") {
      setBackend(args[1]);
      return;
    }

    if (command === "model") {
      setModel(args.slice(1));
      return;
    }

    if (command === "status") {
      showStatus();
      return;
    }

    if (command === "find-model") {
      findAndPersistModel({ force: true });
      return;
    }

    if (command === "download") {
      downloadModel(args[1] || DEFAULT_REPO);
      return;
    }

    if (command === "reset") {
      resetConfig();
      return;
    }

    runPrompt(args);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

function runPrompt(rawArgs) {
  const parsed = parseRunArgs(rawArgs);
  const prompt = parsed.promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error("Missing prompt. Try: lm \"hello there\"");
  }

  ensureLiteRTLmReady();

  const config = readConfig();
  const backend = parsed.backend || config.backend || DEFAULT_BACKEND;

  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`Invalid backend "${backend}". Use cpu or gpu.`);
  }

  const modelPath = resolveModelPath(config, {
    explicitPath: parsed.modelPath
  });

  writeConfig({
    ...config,
    backend,
    modelPath
  });

  const result = runLiteRTLmCommand([
    "run",
    "-b",
    backend,
    modelPath,
    "--prompt",
    prompt
  ]);

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

function setBackend(value) {
  if (!value) {
    const config = readConfig();
    console.log(config.backend || DEFAULT_BACKEND);
    return;
  }

  if (!VALID_BACKENDS.has(value)) {
    throw new Error(`Invalid backend "${value}". Use cpu or gpu.`);
  }

  const config = readConfig();
  writeConfig({
    ...config,
    backend: value
  });

  console.log(`Saved backend: ${value}`);
}

function setModel(args) {
  const value = args[0];
  const config = readConfig();

  if (!value) {
    const resolved = safeResolveModelPath(config);
    if (!resolved) {
      printFirstRunModelHint();
      process.exit(1);
    }
    console.log(resolved);
    return;
  }

  if (value === "auto") {
    const found = findAndPersistModel({ force: true });
    console.log(found);
    return;
  }

  const absolutePath = path.resolve(value);

  if (!fileExists(absolutePath)) {
    throw new Error(`Model file not found: ${absolutePath}`);
  }

  writeConfig({
    ...config,
    modelPath: absolutePath
  });

  console.log(`Saved model path: ${absolutePath}`);
}

function showStatus() {
  const config = readConfig();
  const backend = config.backend || DEFAULT_BACKEND;
  const modelPath = safeResolveModelPath(config);

  if (config.backend !== backend || config.modelPath !== modelPath) {
    writeConfig({
      ...config,
      backend,
      modelPath
    });
  }

  console.log(JSON.stringify({
    backend,
    modelPath,
    configPath: getConfigPath(),
    defaultRepo: DEFAULT_REPO,
    needsModelDownload: !modelPath
  }, null, 2));

  if (!modelPath) {
    console.log("");
    printFirstRunModelHint();
  }
}

function findAndPersistModel(options = {}) {
  const config = readConfig();
  const found = findModelPath();

  if (!found) {
    throw new Error([
      "Could not find a .litertlm model in your Hugging Face cache.",
      `Expected something like ${DEFAULT_MODEL_NAME}.`,
      `You can download one with: lm download ${DEFAULT_REPO}`
    ].join("\n"));
  }

  if (options.force || config.modelPath !== found) {
    writeConfig({
      ...config,
      modelPath: found
    });
  }

  console.log(`Resolved model path: ${found}`);
  return found;
}

function downloadModel(repo) {
  ensureLiteRTLmReady();

  const result = runLiteRTLmCommand([
    "download",
    `--from-huggingface-repo=${repo}`
  ]);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const found = findAndPersistModel({ force: true });
  console.log(`Downloaded and saved model: ${found}`);
}

function resetConfig() {
  const configPath = getConfigPath();

  if (fileExists(configPath)) {
    fs.unlinkSync(configPath);
  }

  console.log(`Removed saved config: ${configPath}`);
}

function parseRunArgs(args) {
  const promptParts = [];
  let backend;
  let modelPath;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (current === "--backend" || current === "-b") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("Missing value after --backend");
      }
      backend = next;
      index += 1;
      continue;
    }

    if (current === "--model") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("Missing value after --model");
      }
      modelPath = path.resolve(next);
      index += 1;
      continue;
    }

    promptParts.push(current);
  }

  return {
    backend,
    modelPath,
    promptParts
  };
}

function resolveModelPath(config, options = {}) {
  const explicitPath = options.explicitPath;
  if (explicitPath) {
    if (!fileExists(explicitPath)) {
      throw new Error(`Model file not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  if (config.modelPath && fileExists(config.modelPath)) {
    return config.modelPath;
  }

  const found = findModelPath();
  if (!found) {
    throw new Error(getMissingModelMessage());
  }

  return found;
}

function safeResolveModelPath(config, options = {}) {
  try {
    return resolveModelPath(config, options);
  } catch (error) {
    if (isMissingModelError(error)) {
      return null;
    }
    throw error;
  }
}

function findModelPath() {
  const root = getHuggingFaceHubDir();
  if (!fileExists(root)) {
    return null;
  }

  const matches = [];
  const queue = [root];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    let entries;

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isDirectory() && entry.name.endsWith(".litertlm")) {
        matches.push(fullPath);
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort(compareModelPaths);
  return matches[0];
}

function compareModelPaths(left, right) {
  return scoreModelPath(right) - scoreModelPath(left) || left.localeCompare(right);
}

function scoreModelPath(modelPath) {
  let score = 0;

  if (modelPath.endsWith(DEFAULT_MODEL_NAME)) {
    score += 100;
  }

  if (modelPath.includes("litert-community")) {
    score += 30;
  }

  if (modelPath.includes("gemma-4-E2B-it-litert-lm")) {
    score += 20;
  }

  if (modelPath.includes("/snapshots/")) {
    score += 10;
  }

  return score;
}

function getHuggingFaceHubDir() {
  if (process.env.HUGGINGFACE_HUB_CACHE) {
    return path.resolve(process.env.HUGGINGFACE_HUB_CACHE);
  }

  if (process.env.HF_HOME) {
    return path.join(path.resolve(process.env.HF_HOME), "hub");
  }

  return path.join(os.homedir(), ".cache", "huggingface", "hub");
}

function getConfigPath() {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");

  return path.join(configRoot, CONFIG_DIR_NAME, "config.json");
}

function getLegacyConfigPath() {
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");

  return path.join(configRoot, LEGACY_CONFIG_DIR_NAME, "config.json");
}

function readConfig() {
  const configPath = getConfigPath();
  if (fileExists(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read config file ${configPath}: ${error.message}`);
    }
  }

  const legacyConfigPath = getLegacyConfigPath();
  if (fileExists(legacyConfigPath)) {
    try {
      const legacyConfig = JSON.parse(fs.readFileSync(legacyConfigPath, "utf8"));
      writeConfig(legacyConfig);
      return legacyConfig;
    } catch (error) {
      throw new Error(`Could not read legacy config file ${legacyConfigPath}: ${error.message}`);
    }
  }

  return {};
}

function writeConfig(config) {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function hasFlag(args, ...flags) {
  return args.some((arg) => flags.includes(arg));
}

function ensureLiteRTLmReady() {
  ensureUvInstalled();

  const config = readConfig();
  if (config.litertLmReady) {
    return;
  }

  console.error("Preparing litert-lm with uvx...");

  const result = runLiteRTLmCommand(["--help"], {
    stdio: "pipe"
  });
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Could not prepare litert-lm with uvx.");
  }

  writeConfig({
    ...config,
    litertLmReady: true
  });
}

function ensureUvInstalled() {
  if (findCommand("uv")) {
    prependUvPath();
    return;
  }

  console.error("uv was not found. Installing uv...");
  installUv();
  prependUvPath();

  if (!findCommand("uv")) {
    throw new Error([
      "uv installation did not complete successfully.",
      "Please install uv manually from https://docs.astral.sh/uv/getting-started/installation/ and try again."
    ].join("\n"));
  }
}

function installUv() {
  const brew = findCommand("brew");

  if (brew) {
    const brewResult = spawnSync(brew, ["install", "uv"], {
      stdio: "inherit"
    });

    if (brewResult.status === 0) {
      return;
    }
  }

  const shell = process.env.SHELL || "/bin/sh";
  const script = "curl -LsSf https://astral.sh/uv/install.sh | sh";
  const curlResult = spawnSync(shell, ["-lc", script], {
    stdio: "inherit"
  });

  if (curlResult.status !== 0) {
    throw new Error("Automatic uv installation failed.");
  }
}

function prependUvPath() {
  const candidateDirs = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];

  const existing = new Set((process.env.PATH || "").split(path.delimiter).filter(Boolean));
  for (const dir of candidateDirs) {
    if (fileExists(dir) && !existing.has(dir)) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ""}`;
      existing.add(dir);
    }
  }
}

function runLiteRTLmCommand(args, options = {}) {
  const stdio = options.stdio || "inherit";
  const uvx = findCommand("uvx");
  if (uvx) {
    return spawnSync(uvx, ["--from", "litert-lm", "litert-lm", ...args], {
      stdio
    });
  }

  const uv = findCommand("uv");
  if (uv) {
    return spawnSync(uv, ["tool", "run", "--from", "litert-lm", "litert-lm", ...args], {
      stdio
    });
  }

  throw new Error("uv is installed, but neither uvx nor uv tool run is available.");
}

function findCommand(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function fileExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getMissingModelMessage() {
  return [
    "No LiteRT model was found yet.",
    "First-time setup: download a model with:",
    `  lm download ${DEFAULT_REPO}`,
    `Searched under: ${getHuggingFaceHubDir()}`
  ].join("\n");
}

function isMissingModelError(error) {
  return Boolean(error && error.message === getMissingModelMessage());
}

function printFirstRunModelHint() {
  console.log(getMissingModelMessage());
}

function printHelp() {
  console.log(`
lm-command

Usage:
  lm "your prompt"
  lm run --backend gpu "your prompt"
  lm backend gpu
  lm model auto
  lm model /path/to/model.litertlm
  lm status
  lm download
  lm reset

What it does:
  - Ensures uv is installed before running
  - Prepares litert-lm through uvx on first use
  - Wraps: uvx --from litert-lm litert-lm run
  - Auto-discovers a .litertlm model under your Hugging Face cache
  - Saves backend and model path to disk for later runs

Defaults:
  backend: ${DEFAULT_BACKEND}
  repo:    ${DEFAULT_REPO}
  config:  ${getConfigPath()}
`.trim());
}

main();
