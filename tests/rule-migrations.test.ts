import { afterAll, expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "tb-migrations-")));
process.env.TRIGGERBASE_HOME = home;
const { Store } = await import("../src/store.js");
const { migrateInstalledRules } = await import("../src/rule-migrations.js");
const { readRule } = await import("../src/rules.js");
const store = new Store();
const custom = join(home, "repo");
mkdirSync(custom);
const file = join(custom, "meeting.trigger.yaml");
store.set("paths", [custom, file]);
const original =
  "# Meeting automation\n" +
  readFileSync(
    new URL("./fixtures/circleback-v1.0.0.trigger.yaml", import.meta.url),
    "utf8",
  );
afterAll(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test("setup migrates an actual 1.0 file once, preserving comments, mode and behavior", () => {
  writeFileSync(file, original, { mode: 0o640 });
  expect(() => readRule(file)).toThrow(/schemaVersion/);
  migrateInstalledRules(store);
  expect(readRule(file)).toMatchObject({
    id: "meeting-notes",
    schemaVersion: 2,
    enabled: false,
    run: { worktree: false, chat: { key: "{{id}}" } },
  });
  const after = readFileSync(file, "utf8"),
    stat = statSync(file);
  expect(after).toContain("# Meeting automation");
  expect(stat.mode & 0o777).toBe(0o640);
  migrateInstalledRules(store);
  expect(statSync(file).ino).toBe(stat.ino);
  expect(readFileSync(file, "utf8")).toBe(after);
});
test.each([true, false])("setup preserves explicit worktree=%s", (worktree) => {
  writeFileSync(
    file,
    original.replace("run:\n", `run:\n  worktree: ${worktree}\n`),
  );
  migrateInstalledRules(store);
  expect(readRule(file).run).toMatchObject({ worktree });
});
test("a newer or malformed rule leaves the rest of the batch intact", () => {
  writeFileSync(file, original);
  const other = join(custom, "other.trigger.yaml");
  for (const text of [
    "schemaVersion: 999\n",
    "schemaVersion: null\n",
    original.replace("run:\n", "run:\n  worktree: 'true'\n"),
  ]) {
    writeFileSync(other, text);
    expect(() => migrateInstalledRules(store)).toThrow(other);
    expect(readFileSync(other, "utf8")).toBe(text);
    expect(readFileSync(file, "utf8")).toBe(original);
  }
  rmSync(other);
  migrateInstalledRules(store)();
  expect(readFileSync(file, "utf8")).toBe(original);
});
