const { spawnSync } = require("node:child_process");

const separator = process.argv.indexOf("--", 2);
if (separator < 3 || separator === process.argv.length - 1) {
  throw new Error("usage: run-with-env KEY=value [KEY=value ...] -- tsx|node [args ...]");
}

const env = { ...process.env };
for (const assignment of process.argv.slice(2, separator)) {
  const equals = assignment.indexOf("=");
  const key = assignment.slice(0, equals);
  const value = assignment.slice(equals + 1);
  if (equals <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(key) || value.includes("\0")) {
    throw new Error("invalid_environment_assignment");
  }
  env[key] = value;
}

const requested = process.argv[separator + 1];
const requestedArgs = process.argv.slice(separator + 2);
let command;
let args;
if (requested === "node") {
  command = process.execPath;
  args = requestedArgs;
} else if (requested === "tsx") {
  command = process.execPath;
  args = [require.resolve("tsx/cli"), ...requestedArgs];
} else {
  throw new Error("unsupported_command");
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
