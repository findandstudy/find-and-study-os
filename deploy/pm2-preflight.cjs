#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ecosystem = require("./ecosystem.config.cjs");

const LEGACY_NAMES = new Set([
  "edconsult-os-api",
  "findandstudy-api",
  "portal-automation-worker",
]);

function fail(message) {
  throw new Error(`[pm2-preflight] ${message}`);
}

function readProcessList(inputPath) {
  const raw = inputPath
    ? fs.readFileSync(path.resolve(inputPath), "utf8")
    : execFileSync("pm2", ["jlist"], { encoding: "utf8" });
  const processes = JSON.parse(raw);
  if (!Array.isArray(processes)) fail("PM2 process list is not an array");
  return processes;
}

function processName(process) {
  return process.name || process.pm2_env?.name || "";
}

function processScript(process) {
  return String(process.pm2_env?.pm_exec_path || process.pm_exec_path || "");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validate(processes, options = {}) {
  const {
    api,
    portalWorker,
    portalStatusWorker,
    portalLifecycleWorker,
  } = ecosystem.processNames;
  const expected = new Set([api, portalWorker]);
  const optionalWorkers = new Set([portalStatusWorker, portalLifecycleWorker]);
  const legacy = processes.map(processName).filter((name) => LEGACY_NAMES.has(name));
  if (legacy.length) fail(`legacy process name(s) detected: ${[...new Set(legacy)].join(", ")}`);

  for (const name of expected) {
    const matches = processes.filter((process) => processName(process) === name);
    const count = matches.length;
    if (count !== 1) fail(`expected exactly one existing ${name} process; found ${count}`);
    if (matches[0].pm2_env?.exec_mode !== "fork_mode") {
      fail(`${name} must already use PM2 fork mode`);
    }
  }
  for (const name of optionalWorkers) {
    const matches = processes.filter((process) => processName(process) === name);
    if (matches.length > 1) fail(`expected at most one existing ${name} process; found ${matches.length}`);
    if (matches[0] && matches[0].pm2_env?.exec_mode !== "fork_mode") {
      fail(`${name} must already use PM2 fork mode`);
    }
  }

  const apiProcess = processes.find((process) => processName(process) === api);
  const apiPort = String(apiProcess?.pm2_env?.PORT ?? apiProcess?.pm2_env?.env?.PORT ?? "");
  if (!/^\d{2,5}$/.test(apiPort)) fail(`${api} has no valid PM2 PORT value`);
  const portOwners = processes.filter((process) => {
    const port = process.pm2_env?.PORT ?? process.pm2_env?.env?.PORT;
    return String(port ?? "") === apiPort;
  });
  const unexpectedPortOwners = portOwners.filter((process) => processName(process) !== api);
  if (unexpectedPortOwners.length) {
    fail(`API port ${apiPort} is also assigned to: ${unexpectedPortOwners.map(processName).join(", ")}`);
  }

  const workerLike = processes.filter((process) =>
    /portal-automation-worker\/.*worker\.(?:ts|js)$/.test(processScript(process)),
  );
  const unexpectedWorkers = workerLike.filter((process) => processName(process) !== portalWorker);
  if (unexpectedWorkers.length || workerLike.length !== 1) {
    fail(`expected one canonical portal worker; found ${workerLike.length}`);
  }

  const statusWorkerLike = processes.filter((process) =>
    /api-server\/.*portalStatusWorker\.(?:ts|js)$/.test(processScript(process)),
  );
  if (
    statusWorkerLike.length > 1 ||
    statusWorkerLike.some((process) => processName(process) !== portalStatusWorker)
  ) {
    fail(`expected at most one canonical portal status worker; found ${statusWorkerLike.length}`);
  }
  const lifecycleWorkerLike = processes.filter((process) =>
    /api-server\/.*portalLifecycleWorker\.(?:ts|js)$/.test(processScript(process)),
  );
  if (
    lifecycleWorkerLike.length > 1 ||
    lifecycleWorkerLike.some((process) => processName(process) !== portalLifecycleWorker)
  ) {
    fail(`expected at most one canonical portal lifecycle worker; found ${lifecycleWorkerLike.length}`);
  }

  if (options.releaseLink) {
    const releaseLink = path.resolve(options.releaseLink);
    for (const process of [apiProcess, workerLike[0], ...statusWorkerLike, ...lifecycleWorkerLike]) {
      const script = path.resolve(processScript(process));
      if (!isWithin(releaseLink, script)) {
        fail(
          `${processName(process)} script must be owned by CURRENT_RELEASE_LINK; ` +
          "refusing a restart that could keep running an old release",
        );
      }
    }
  }

  return {
    api,
    portalWorker,
    portalStatusWorker,
    portalLifecycleWorker,
    statusWorkerPresent: statusWorkerLike.length === 1,
    lifecycleWorkerPresent: lifecycleWorkerLike.length === 1,
    apiPort,
  };
}

try {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex === -1 ? undefined : process.argv[inputIndex + 1];
  if (inputIndex !== -1 && !inputPath) fail("--input requires a JSON file");
  const releaseLinkIndex = process.argv.indexOf("--release-link");
  const releaseLink = releaseLinkIndex === -1 ? undefined : process.argv[releaseLinkIndex + 1];
  if (releaseLinkIndex !== -1 && !releaseLink) fail("--release-link requires a path");
  const result = validate(readProcessList(inputPath), { releaseLink });
  console.log(
    `[pm2-preflight] OK: ${result.api} (fork/1, port ${result.apiPort}); ` +
    `${result.portalWorker} (fork/1); ` +
    `${result.portalStatusWorker} (${result.statusWorkerPresent ? "fork/1" : "not adopted"}); ` +
    `${result.portalLifecycleWorker} (${result.lifecycleWorkerPresent ? "fork/1" : "not adopted"})`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

module.exports = { validate };
