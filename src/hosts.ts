import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import pkg from "../package.json" with { type: "json" };
import { execute } from "./process.js";
import { type Store, type Job } from "./store.js";
import { plan, type Rule } from "./rules.js";

export async function codexRpc<T>(
  cwd: string,
  fn: (call: (method: string, params: unknown) => Promise<any>) => Promise<T>,
) {
  const proc = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<
    number,
    { ok: (v: unknown) => void; no: (e: Error) => void }
  >();
  let id = 0,
    ended = false;
  const fail = (e: Error) => {
    ended = true;
    for (const p of pending.values()) p.no(e);
    pending.clear();
  };
  proc.on("error", fail);
  proc.on("exit", () => fail(Error("Codex App Server stopped")));
  proc.stdin.on("error", fail);
  const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + "\n");
  const lines = createInterface({ input: proc.stdout });
  lines.on("line", (s) => {
    let m;
    try {
      m = JSON.parse(s);
    } catch {
      return;
    }
    if (m.method && m.id != null) {
      send({
        id: m.id,
        error: {
          code: -32000,
          message: "Interactive authorization required in Codex",
        },
      });
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.no(Error(m.error.message));
    else p.ok(m.result);
  });
  async function call(method: string, params: unknown) {
    if (ended) throw Error("Codex App Server unavailable");
    const key = ++id;
    return new Promise<any>((ok, no) => {
      pending.set(key, { ok, no });
      send({ method, params, id: key });
    });
  }
  const timer = setTimeout(() => {
    fail(Error("MCP request timed out"));
    proc.kill();
  }, 90_000);
  try {
    await call("initialize", {
      clientInfo: {
        name: "triggerbase",
        title: "Triggerbase",
        version: pkg.version,
      },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    return await fn(call);
  } finally {
    clearTimeout(timer);
    lines.close();
    proc.stdin.end();
    proc.kill();
  }
}
export async function mcp(
  host: string,
  server: string,
  tool: string,
  args: unknown,
) {
  if (host === "codex")
    return codexRpc(process.cwd(), async (call) => {
      const { thread } = await call("thread/start", {
        cwd: process.cwd(),
        ephemeral: true,
      });
      const result = await call("mcpServer/tool/call", {
        threadId: thread.id,
        server,
        tool,
        arguments: args,
      });
      if (result.isError) throw Error("MCP tool returned an error");
      return result;
    });
  if (host !== "claude") throw Error("Select codex or claude as the MCP host");
  const id = randomUUID(),
    request = {
      type: "control_request",
      request_id: id,
      request: {
        subtype: "mcp_call",
        tool: "mcp__" + server + "__" + tool,
        arguments: args,
        check_permissions: true,
      },
    };
  const proc = spawn(
    "claude",
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  return new Promise((ok, no) => {
    const timer = setTimeout(() => {
      proc.kill();
      no(Error("Claude MCP call timed out or needs interaction"));
    }, 90_000);
    const lines = createInterface({ input: proc.stdout });
    proc.on("error", no);
    proc.stdin.on("error", no);
    proc.on("close", () => {
      clearTimeout(timer);
      no(Error("Claude exited before MCP response"));
    });
    lines.on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "control_request") {
        proc.stdin.write(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: m.request_id,
              error: "Interactive authorization required",
            },
          }) + "\n",
        );
        return;
      }
      if (m.type === "control_response" && m.response.request_id === id) {
        if (m.response.subtype === "error" || m.response.response?.isError)
          no(Error("Claude MCP: " + (m.response.error || "tool failed")));
        else ok(m.response.response);
        proc.stdin.end();
        proc.kill();
      }
    });
    proc.stdin.write(JSON.stringify(request) + "\n");
  });
}
export async function dispatch(db: Store, job: Job) {
  const rule: Rule = JSON.parse(job.spec),
    data = JSON.parse(job.data),
    p = plan(rule, { id: job.event_id, data });
  const result = (text: string) =>
    db.db
      .prepare("UPDATE jobs SET result=? WHERE id=?")
      .run(text.slice(-16000), job.id);
  if (p.command) {
    db.mark(job.id, "running");
    const output = await execute(
      p.command,
      p.cwd,
      JSON.stringify(data),
      600_000,
    );
    result(output.stdout);
    db.mark(job.id, "completed");
    return;
  }
  let session =
    p.existing ||
    (db.db.prepare("SELECT id FROM sessions WHERE k=?").get(p.key!)?.id as
      string | undefined);
  const save = (id: string) => {
    db.transaction(() => {
      db.db
        .prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)")
        .run(p.key!, id);
      db.db.prepare("UPDATE jobs SET session=? WHERE id=?").run(id, job.id);
    });
    session = id;
  };
  if (session) save(session);
  if (p.agent === "claude") {
    const auth = JSON.parse(
      (await execute(["claude", "auth", "status", "--json"], p.cwd, "")).stdout,
    );
    if (!auth.loggedIn || auth.authMethod !== "claude.ai")
      throw Error(
        "Sign in to Claude Code with a subscription account before running this rule",
      );
    const args = session
      ? ["--resume", session]
      : ["--session-id", randomUUID()];
    let done = false;
    await execute(
      ["claude", "-p", "--verbose", "--output-format", "stream-json", ...args],
      p.cwd,
      p.prompt!,
      1800_000,
      (s) => {
        const m = JSON.parse(s);
        if (m.session_id && !session) save(m.session_id);
        if (m.type === "assistant") db.mark(job.id, "running");
        if (m.type === "result") {
          if (m.is_error) throw Error("Claude turn failed");
          if (!session) save(args[1]);
          if (typeof m.result === "string") result(m.result);
          done = true;
        }
      },
    );
    if (!done) throw Error("Missing Claude completion");
    db.mark(job.id, "completed");
    return;
  }
  const auth = await execute(["codex", "login", "status"], p.cwd, "");
  if (!/using ChatGPT/i.test(auth.stdout + auth.stderr))
    throw Error("Sign in to Codex using ChatGPT before running this rule");
  let completed = false,
    alreadyStarted = false,
    hostError = "";
  try {
    const args = session ? ["resume", session] : [];
    await execute(
      ["codex", "exec", ...args, "--skip-git-repo-check", "--json", "-"],
      p.cwd,
      p.prompt!,
      1800_000,
      (s) => {
        const m = JSON.parse(s);
        if (m.type === "error" || m.type === "turn.failed")
          hostError = String(m.message || m.error?.message || "");
        if (m.type === "item.completed" && m.item?.type === "agent_message")
          result(m.item.text);
        if (m.type === "thread.started") save(m.thread_id);
        if (m.type === "turn.started") {
          alreadyStarted = true;
          db.mark(job.id, "running");
        }
        if (m.type === "turn.completed") completed = true;
      },
    );
    if (!completed) throw Error("Missing Codex completion");
    db.mark(job.id, "completed");
  } catch (e) {
    if (
      !session ||
      alreadyStarted ||
      !/active writer/i.test(String(e) + hostError)
    )
      throw e;
    await execute(
      [
        "codex",
        "queue",
        "--thread",
        session,
        "--message",
        "[Triggerbase job " + job.id + "]\n" + p.prompt!,
        "--resume",
      ],
      p.cwd,
      "",
    );
    db.mark(job.id, "delivered");
  }
}
