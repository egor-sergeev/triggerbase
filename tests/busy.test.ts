import { afterAll, expect, test } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "tb-busy-")),
  priorPath = process.env.PATH;
process.env.TRIGGERBASE_HOME = dir;
process.env.PATH = dir + ":" + priorPath;
const { Store } = await import("../src/store.js"),
  { Runner } = await import("../src/runner.js"),
  { readRule } = await import("../src/rules.js");
const store = new Store(),
  runner = new Runner(store),
  thread = "9fe863ca-3031-4890-b9c9-869e20a71dd5";
afterAll(() => {
  store.close();
  process.env.PATH = priorPath;
  rmSync(dir, { recursive: true, force: true });
});
test("busy native chat: queue acknowledgement, observed host start, completion, next message", async () => {
  const state = join(dir, "status"),
    sent = join(dir, "sent"),
    bin = join(dir, "codex");
  writeFileSync(
    bin,
    "#!/usr/bin/env node\n" +
      'const fs=require("node:fs"),args=process.argv.slice(2);' +
      'if(args[0]==="login")console.log("Logged in using ChatGPT");' +
      'else if(args[0]==="exec"){console.error("already has an active writer");process.exitCode=1}' +
      'else if(args[0]==="queue")fs.appendFileSync(' +
      JSON.stringify(sent) +
      ',JSON.stringify(args[args.indexOf("--message")+1])+"\\n");' +
      'else require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(!m.id)return;const turns=fs.readFileSync(' +
      JSON.stringify(sent) +
      ',"utf8").trim().split("\\n").map(text=>({status:fs.readFileSync(' +
      JSON.stringify(state) +
      ',"utf8"),items:[{type:"userMessage",content:[{text:JSON.parse(text)}]}]}));console.log(JSON.stringify({id:m.id,result:m.method==="thread/read"?{thread:{turns}}:{}}))});',
  );
  chmodSync(bin, 0o700);
  const file = join(dir, "rules", "busy.trigger.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      id: "busy",
      webhook: "busy",
      run: {
        worktree: false,
        agent: "codex",
        cwd: dir,
        chat: { id: thread },
        prompt: "{{text}}",
      },
    }),
  );
  store.put(readRule(file), [
    { id: "a", data: { text: "first" } },
    { id: "b", data: { text: "second" } },
  ]);
  await runner.work();
  expect(store.list().map((j) => j.status)).toEqual(["queued", "delivered"]);
  writeFileSync(state, "inProgress");
  await runner.reconcile();
  expect(store.list()[1].status).toBe("host_running");
  await runner.work();
  expect(readFileSync(sent, "utf8").trim().split("\n")).toHaveLength(1);
  writeFileSync(state, "completed");
  await runner.reconcile();
  await runner.work();
  await runner.reconcile();
  expect(store.list().every((j) => j.status === "completed")).toBe(true);
  expect(
    readFileSync(sent, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s).split("\n")[1]),
  ).toEqual(["first", "second"]);
});
