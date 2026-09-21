import crossSpawn from "cross-spawn";

const args = process.argv.slice(2);

function run(script, scriptArgs = []) {
  const commandArgs = ["run", script];
  if (scriptArgs.length > 0) commandArgs.push("--", ...scriptArgs);
  // Spawning npm.cmd directly fails with EINVAL on Windows (Node refuses
  // .cmd/.bat spawns without a shell since the CVE-2024-27980 fix), which
  // broke `npm test` on every Windows checkout. cross-spawn wraps the call
  // the way the rest of this repo already does for npx (see npx-resolver.ts).
  const result = crossSpawn.sync("npm", commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

if (args.length > 0) {
  run("test:vitest", args);
} else if (
  run("test:vitest", ["--exclude", "__tests__/ui-server-browser.test.ts"]) &&
  run("test:vitest", ["__tests__/ui-server-browser.test.ts"])
) {
  run("test:public-exports");
}
