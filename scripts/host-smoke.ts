import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const host = process.argv[2],
  mode = process.argv[3] || "mcp";
if (!["codex", "claude"].includes(host) || !["mcp", "session"].includes(mode))
  throw Error("Usage: host-smoke.ts codex|claude mcp|session");
const dir = mkdtempSync(join(tmpdir(), "triggerbase-smoke-"));
process.env.TRIGGERBASE_HOME = dir;
try {
  if (mode === "mcp") {
    const fixture = resolve("tests/fixtures/mcp.mjs"),
      profile = join(dir, "profile");
    mkdirSync(profile);
    if (host === "codex") {
      process.env.CODEX_HOME = profile;
      writeFileSync(
        join(profile, "config.toml"),
        '[mcp_servers.fixture]\ncommand="node"\nargs=[' +
          JSON.stringify(fixture) +
          "]\n",
      );
    } else {
      process.env.CLAUDE_CONFIG_DIR = profile;
      writeFileSync(
        join(profile, "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__fixture__ping"] } }),
      );
      execFileSync("claude", [
        "mcp",
        "add",
        "--scope",
        "user",
        "fixture",
        "--",
        "node",
        fixture,
      ]);
    }
    const { mcp } = await import("../dist/hosts.js"),
      response = await mcp(host, "fixture", "ping", {});
    assert.match(JSON.stringify(response), /pong-from-triggerbase-fixture/);
    console.log(host + " MCP check passed (fixture connection).");
  } else {
    const { Store } = await import("../dist/store.js"),
      { Runner } = await import("../dist/runner.js"),
      { readRule } = await import("../dist/rules.js");
    const store = new Store(),
      runner = new Runner(store),
      file = join(dir, "rules", "smoke.trigger.yaml");
    const marker = randomUUID();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: "smoke",
        webhook: "sample",
        run: {
          worktree: false,
          agent: host,
          cwd: process.cwd(),
          chat: "shared",
          prompt: "{{instruction}}",
        },
      }),
    );
    const rule = readRule(file);
    store.put(rule, [
      {
        id: "first",
        data: {
          instruction:
            "Remember this test marker: " +
            marker +
            ". Reply OK. Use no tools.",
        },
      },
      {
        id: "second",
        data: {
          instruction:
            "What was the test marker in the previous message? Reply with the marker. Use no tools.",
        },
      },
    ]);
    await runner.work();
    const jobs = store.db
      .prepare("SELECT status,session,result,error FROM jobs ORDER BY id")
      .all();
    for (const job of jobs)
      assert.equal(job.status, "completed", String(job.error));
    assert.ok(jobs[0].session);
    assert.equal(jobs[0].session, jobs[1].session);
    assert.ok(String(jobs[1].result).includes(marker));
    console.log(host + " shared session verified: " + jobs[0].session);
    store.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
