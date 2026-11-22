// Exercise the same installed plugin entry point used by both hosts.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync, gunzipSync } from "node:zlib";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "tb onboarding "));
const state = join(dir, "state");
const env = { ...process.env, TRIGGERBASE_HOME: state, PATH: "/usr/bin:/bin" };
const source = resolve(process.argv[2] || "plugins/triggerbase");
const secondHost = resolve(process.argv[3] || source);
const launcher = join(state, "install/bin/triggerbase");
const label =
  "gui/" +
  process.getuid!() +
  "/dev.triggerbase.runner." +
  createHash("sha256").update(state).digest("hex").slice(0, 12);
const pid = () =>
  execFileSync("/bin/launchctl", ["print", label], { encoding: "utf8" }).match(
    /\bpid = (\d+)/,
  )?.[1];
const setup = (root: string) =>
  run("/bin/sh", [join(root, "setup.sh")], { env, timeout: 100_000 });
const cli = (...args: string[]) =>
  execFileSync(launcher, args, { env, encoding: "utf8" });
const fixture = join(dir, "candidate");
cpSync(source, fixture, { recursive: true });
try {
  const bootstrap = join(fixture, "setup.sh");
  const original = readFileSync(bootstrap, "utf8");
  writeFileSync(
    bootstrap,
    original.replace(/digest=[a-f0-9]{64}/g, "digest=" + "0".repeat(64)),
  );
  await assert.rejects(setup(fixture), /checksum|FAILED/i);
  writeFileSync(bootstrap, original);
  await Promise.all([setup(source), setup(secondHost)]);
  const first = pid();
  assert.ok(first);
  assert.equal(JSON.parse(cli("jobs")).length, 0);
  assert.equal(JSON.parse(cli("rules")).rules.length, 0);
  await setup(secondHost);
  assert.equal(pid(), first);
  const db = new DatabaseSync(join(state, "state.sqlite"));
  try {
    // Run the weekly rule with a due check and a local command to keep CI model-free.
    const rule = join(state, "rules", "weekly-report.trigger.yaml");
    const spec = {
      id: "weekly-report",
      cron: "0 16 * * 5",
      timezone: "UTC",
      run: { command: ["/bin/echo", "weekly report"] },
    };
    db.prepare("INSERT INTO checks(rule,slot) VALUES(?,?)").run(
      spec.id,
      new Date(Date.now() - 8 * 86400000).toISOString(),
    );
    writeFileSync(rule, JSON.stringify(spec));
    for (
      let i = 0;
      i < 50 &&
      !db.prepare("SELECT 1 FROM jobs WHERE status='completed'").get();
      i++
    )
      await sleep(250);
    assert.equal(JSON.parse(cli("jobs"))[0]?.status, "completed");
    writeFileSync(rule, JSON.stringify({ ...spec, enabled: false }));
    assert.equal(JSON.parse(cli("rules")).rules[0].enabled, false);

    const manifest = join(fixture, "plugin.json");
    const changeVersion = (version: string) =>
      writeFileSync(
        manifest,
        JSON.stringify({
          ...JSON.parse(readFileSync(manifest, "utf8")),
          version,
        }),
      );
    changeVersion("2.0.0");
    await setup(fixture);
    changeVersion("1.0.0");
    await assert.rejects(setup(fixture), /newer shared runner/);
    changeVersion("1.1.0");
    await setup(fixture);
    assert.equal(JSON.parse(cli("jobs")).length, 1);
    const custom = join(dir, "project rules");
    mkdirSync(custom);
    const legacy = join(custom, "meeting.trigger.yaml");
    const originalRule = readFileSync(
      new URL(
        "../tests/fixtures/circleback-v1.0.0.trigger.yaml",
        import.meta.url,
      ),
      "utf8",
    );
    writeFileSync(legacy, originalRule, { mode: 0o444 });
    writeFileSync(
      join(custom, "future.trigger.yaml"),
      "schemaVersion: 999\nid: future\n",
    );
    cli("paths", "add", custom);
    await setup(source);
    const catalog = JSON.parse(cli("rules"));
    assert.deepEqual(
      catalog.rules.map((r: { id: string }) => r.id).sort(),
      ["meeting-notes", spec.id].sort(),
    );
    const meeting = catalog.rules.find(
      (r: { id: string }) => r.id === "meeting-notes",
    );
    assert.equal(meeting.enabled, false);
    assert.equal(meeting.run.worktree, false);
    assert.match(
      String(Object.values(catalog.errors)),
      /schemaVersion 999 requires a newer Triggerbase/,
    );
    const event = join(custom, "preview.json");
    writeFileSync(
      event,
      JSON.stringify({
        id: "m1",
        data: { id: "m1", actionItems: [], transcript: "test transcript" },
      }),
    );
    const preview = JSON.parse(cli("preview", legacy, event));
    assert.equal(preview.worktree, false);
    assert.match(preview.prompt, /test transcript/);
    assert.equal(readFileSync(legacy, "utf8"), originalRule);
    assert.equal(JSON.parse(cli("jobs")).length, 1);
    const beforeUpgrade = pid();
    changeVersion("9998.0.0");
    const busy = db
      .prepare(
        "INSERT INTO jobs(rule,event_id,spec,data,status) VALUES('busy','test','{}','{}','running')",
      )
      .run().lastInsertRowid;
    const updating = setup(fixture);
    await sleep(2000);
    assert.equal(pid(), beforeUpgrade);
    db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(busy);
    await updating;
    assert.ok(pid() && pid() !== beforeUpgrade);
    const working = readlinkSync(launcher);
    changeVersion("9999.0.0");
    // Preflight passes but the candidate daemon fails to start. Restore the prior service.
    const packed = join(fixture, "bin/cli.js.gz");
    writeFileSync(
      packed,
      gzipSync(
        gunzipSync(readFileSync(packed))
          .toString()
          .replace(
            "#!/usr/bin/env node\n",
            "#!/usr/bin/env node\nif (process.argv[2] === 'start') process.exit(1);\n",
          ),
      ),
    );
    await assert.rejects(setup(fixture), /did not start the local journal/);
    assert.equal(readlinkSync(launcher), working);
    assert.ok(pid());
    assert.equal(JSON.parse(cli("jobs")).length, 2);
  } finally {
    db.close();
  }
  console.log(
    "Verified checksum rejection, concurrent install, login service, cron, legacy rule migration, repeat setup, busy upgrade and rollback.",
  );
} finally {
  try {
    if (existsSync(launcher)) cli("service", "uninstall");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
