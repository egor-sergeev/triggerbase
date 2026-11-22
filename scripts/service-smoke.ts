import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
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
  for (let attempt = 0; attempt < 100; attempt++) {
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
  const label =
    "dev.triggerbase.runner." +
    createHash("sha256").update(state).digest("hex").slice(0, 12);
  const domain = "gui/" + process.getuid!();
  const plist = join(homedir(), "Library", "LaunchAgents", label + ".plist");
  const configuration = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plist], {
      encoding: "utf8",
    }),
  );
  assert.equal(configuration.RunAtLoad, true);
  assert.equal(configuration.KeepAlive, true);
  const control = (...args: string[]) =>
    execFileSync("launchctl", args, { encoding: "utf8" });
  const pid = () =>
    Number(control("print", domain + "/" + label).match(/\bpid = (\d+)/)?.[1]);
  cli("upgrade", "service", "stop");
  const db = new DatabaseSync(join(state, "state.sqlite"));
  try {
    const rule = (id: string, source: object) =>
      writeFileSync(
        join(state, "rules", id + ".trigger.yaml"),
        JSON.stringify({
          schemaVersion: 2,
          id,
          ...source,
          run: { command: [process.execPath, "-e", "process.stdin.resume()"] },
        }),
      );
    rule("daily", { cron: "0 0 * * *", timezone: "UTC" });
    rule("paused", { cron: "0 0 * * *", timezone: "UTC", enabled: false });
    rule("wake", { webhook: "resume" });
    for (const id of ["daily", "paused"])
      db.prepare("INSERT INTO checks(rule,slot) VALUES(?,?)").run(
        id,
        new Date(Date.now() - 2 * 86400000).toISOString(),
      );
    // Load the installed plist directly, as launchd does at user login.
    control("bootstrap", domain, plist);
    async function completed(id: string) {
      for (let i = 0; i < 100; i++) {
        if (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM jobs WHERE rule=? AND status='completed'",
            )
            .get(id)?.n === 1
        )
          return;
        await sleep(250);
      }
      throw Error("Missing completed job: " + id);
    }
    await completed("daily");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE rule='paused'").get()?.n,
      0,
    );
    const firstPid = pid();
    process.kill(firstPid, "SIGSTOP");
    try {
      db.prepare(
        "INSERT INTO inbox(id,source,body) VALUES('wake-test','resume','{}')",
      ).run();
      await sleep(7000);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE rule='wake'").get()?.n,
        0,
      );
    } finally {
      process.kill(firstPid, "SIGCONT");
    }
    await completed("wake");
    control("kill", "SIGKILL", domain + "/" + label);
    await ready();
    for (let i = 0; i < 100 && (!pid() || pid() === firstPid); i++)
      await sleep(200);
    assert.ok(pid() && pid() !== firstPid);
    await ready();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n, 2);
  } finally {
    db.close();
  }
  console.log(
    "Verified launchd install, upgrade, login bootstrap, cron catch-up, process suspension/resume and KeepAlive restart.",
  );
} finally {
  try {
    cli("first", "service", "uninstall");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
