import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = process.argv.slice(2);

function run(script, scriptArgs = []) {
  const commandArgs = ["run", script];
  if (scriptArgs.length > 0) commandArgs.push("--", ...scriptArgs);
  const result = spawnSync(npm, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

if (args.length > 0) {
  run("test:vitest", args);
} else if (run("test:vitest")) {
  run("test:public-exports");
}
