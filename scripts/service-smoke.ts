import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "triggerbase-service-")),
  state = join(dir, "state");
const env = { ...process.env, TRIGGERBASE_HOME: state };
const cli = (folder: string, ...args: string[]) =>
  execFileSync(process.execPath, [join(dir, folder, "cli.js"), ...args], {
    env,
    encoding: "utf8",
  });
async function ready() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const url = readFileSync(join(state, "journal.url"), "utf8");
      assert.equal((await fetch(url, { redirect: "manual" })).status, 303);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw Error("LaunchAgent failed to serve the journal");
}
try {
  for (const version of ["first", "upgrade"]) {
    mkdirSync(join(dir, version));
    copyFileSync("release/cli.js", join(dir, version, "cli.js"));
    cli(version, "service", "install");
    await ready();
    cli(version, "service", "install");
    await ready();
  }
  console.log("Verified launchd install, repeat install and upgrade.");
} finally {
  try {
    cli("first", "service", "uninstall");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
