import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { currentRuleSchema, migrateRule } from "../src/rule-migrations.js";
import { readRule, readRuleSnapshot } from "../src/rules.js";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/circleback-v1.0.0.trigger.yaml", import.meta.url),
);
test("the shipped 1.0.0 rule preserves its source hash, disabled state and keyed chat", () => {
  const rule = readRule(fixture);
  expect(rule).toMatchObject({
    schemaVersion: currentRuleSchema,
    enabled: false,
    id: "meeting-notes",
    check: ["node", "./meeting.ts"],
    version: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
    run: { agent: "claude", worktree: false, chat: { key: "{{id}}" } },
  });
  expect(readRuleSnapshot(JSON.stringify(rule))).toEqual(rule);
});
test.each([true, false])(
  "preserves a 1.1 worktree choice of %s",
  (worktree) => {
    const input = { run: { agent: "codex", worktree } };
    expect(migrateRule(input)).toEqual({
      ...input,
      schemaVersion: currentRuleSchema,
    });
  },
);
test("ordered migration is repeatable and leaves the input untouched", () => {
  const input = { schemaVersion: 1, run: { agent: "codex" } };
  const migrated = migrateRule(input);
  expect(migrated).toEqual({
    schemaVersion: currentRuleSchema,
    run: { agent: "codex", worktree: false },
  });
  expect(migrateRule(migrated)).toEqual(migrated);
  expect(input).toEqual({ schemaVersion: 1, run: { agent: "codex" } });
  expect(migrateRule({ run: { command: ["true"] } }).run).toEqual({
    command: ["true"],
  });
});
test.each([0, -1, 1.5, null, "2"])(
  "rejects invalid schemaVersion %s",
  (schemaVersion) => {
    expect(() => migrateRule({ schemaVersion })).toThrow("positive integer");
  },
);
test.each([null, "false"])(
  "rejects malformed legacy worktree %s",
  (worktree) => {
    const rule = readRule(fixture);
    expect(() =>
      readRuleSnapshot(
        JSON.stringify({
          ...rule,
          schemaVersion: 1,
          run: { ...rule.run, worktree },
        }),
      ),
    ).toThrow();
  },
);
