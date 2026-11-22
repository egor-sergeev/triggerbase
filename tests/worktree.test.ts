import { afterAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyLinkedCheckout, worktreeSource } from "../src/worktree.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tb-workspace-")));
const repo = join(root, "source repo"),
  nested = join(repo, "pkg"),
  linked = join(root, "another tree");
mkdirSync(nested, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const oldPath = process.env.PATH;
process.env.TRIGGERBASE_HOME = root;
const { Store } = await import("../src/store.js"),
  { Runner } = await import("../src/runner.js"),
  { readRule } = await import("../src/rules.js");
const store = new Store();
git("init", "-q");
git(
  "-c",
  "user.name=fixture",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "--allow-empty",
  "-qm",
  "fixture",
);
git("worktree", "add", "-q", "--detach", linked);
const log = join(root, "calls");
for (const host of ["claude", "codex"])
  writeFileSync(
    join(root, host),
    `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2), json=m=>console.log(JSON.stringify(m));
if(args[0]==='app-server') require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.id)json({id:m.id,result:m.method==='thread/read'?{thread:{cwd:${JSON.stringify(linked)}}}:{}})});
else if(args[0]==='login') console.log('Logged in using ChatGPT');
else if(args[0]==='auth') json({loggedIn:true,authMethod:'claude.ai'});
else {
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(args[0]==='exec'){json({type:'thread.started',thread_id:args[1]==='resume'?args[2]:require('crypto').randomUUID()});json({type:'turn.completed'})}
else json({type:'result',is_error:false});
}`,
    { mode: 0o700 },
  );
process.env.PATH = root + ":" + oldPath;
afterAll(() => {
  store.close();
  process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
});
const file = join(root, "rules", "fixture.trigger.yaml");
const rule = (id: string, run: object) => {
  writeFileSync(file, JSON.stringify({ id, webhook: "fixture", run }));
  return readRule(file);
};
test("worktree is an explicit boolean for agent rules", () => {
  const run = { agent: "codex", cwd: nested, prompt: "hello" };
  expect(() => rule("test", run)).toThrow();
  expect(() => rule("test", { ...run, worktree: "false" })).toThrow();
  expect(() => rule("test", { command: ["true"] })).not.toThrow();
});
test("git discovers nested and linked checkouts and handles plain or unborn directories", async () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  expect(await worktreeSource(empty)).toMatchObject({
    cwd: empty,
    reason: expect.any(String),
  });
  execFileSync("git", ["init", "-q", empty]);
  expect(await worktreeSource(empty)).toMatchObject({
    cwd: empty,
    reason: "repository has no commit",
  });
  for (const [dir, top] of [
    [repo, repo],
    [nested, repo],
    [linked, linked],
  ])
    expect(await worktreeSource(dir)).toEqual({ cwd: top });
});
test("only a separate checkout of the same repository can restore isolation", async () => {
  await expect(verifyLinkedCheckout(repo, nested)).rejects.toThrow(
    "separate worktree",
  );
  await expect(verifyLinkedCheckout(repo, root)).rejects.toThrow(
    "separate worktree",
  );
  await expect(verifyLinkedCheckout(repo, linked)).resolves.toBeUndefined();
});
test.each(["codex", "claude"])(
  "%s creates once and resumes the same checkout",
  async (agent) => {
    writeFileSync(log, "");
    const r = rule(agent, {
      agent,
      cwd: nested,
      worktree: true,
      chat: "shared",
      prompt: "test",
    });
    for (const id of ["first", "next", "third"]) {
      store.put(r, [{ id, data: {} }]);
      await new Runner(store).work();
    }
    expect(
      store
        .list()
        .filter((j) => j.rule === agent)
        .map((j) => j.status),
    ).toEqual(["completed", "completed", "completed"]);
    const [first, ...resumes] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(first.cwd).toBe(repo);
    expect(first.args).toContain("--worktree");
    for (const resume of resumes) {
      expect(resume.args).not.toContain("--worktree");
      expect(resume.args).toContain(agent === "codex" ? "resume" : "--resume");
      expect(resume.cwd).toBe(agent === "codex" ? linked : repo);
    }
  },
);
test.each([
  [false, nested],
  [true, root],
] as const)(
  "in-place execution when worktree=%s in %s",
  async (worktree, cwd) => {
    const r = rule("local-" + worktree, {
      agent: "codex",
      cwd,
      worktree,
      prompt: "test",
    });
    writeFileSync(log, "");
    store.put(r, [{ id: "first", data: {} }]);
    await new Runner(store).work();
    const call = JSON.parse(readFileSync(log, "utf8"));
    expect(call.cwd).toBe(cwd);
    expect(call.args).not.toContain("--worktree");
    if (worktree)
      expect(
        store.db
          .prepare(
            "select state from history where job=? and state like 'Using configured directory:%'",
          )
          .get(store.list()[0].id),
      ).toBeTruthy();
  },
);
