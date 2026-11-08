// Runs `tsc --noEmit` and ignores only the two known module-format diagnostics
// (TS1295 / TS1287, caused by the missing "type" field); any other error fails the run.
import { spawnSync } from "node:child_process";

const IGNORED = /error TS(1295|1287):/;
const run = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8", shell: true });
const errors = `${run.stdout}${run.stderr}`
  .split(/\r?\n/)
  .filter((line) => /error TS\d+:/.test(line) && !IGNORED.test(line));

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("typecheck ok (TS1295/TS1287 ignored)");
