import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

const runner = readFileSync("release/cli.js");
const target = "plugins/triggerbase/bin/cli.js.gz";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.match(
  manifest.version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  "Public versions must use MAJOR.MINOR.PATCH.",
);
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    "v" + manifest.version,
    "Release tag must match package.json.",
  );
}
for (const file of [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
]) {
  assert.equal(
    JSON.parse(readFileSync("plugins/triggerbase/" + file, "utf8")).version,
    manifest.version,
  );
}
if (process.argv.includes("--check")) {
  assert.ok(
    gunzipSync(readFileSync(target)).equals(runner),
    "Run pnpm package:plugin to refresh the packaged runner.",
  );
} else writeFileSync(target, gzipSync(runner, { level: 9 }));
