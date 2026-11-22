import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { Cron } from "croner";
export const currentRuleSchema = 2;

const command = z.array(z.string().min(1)).min(1);
const chat = z.union([
  z.enum(["new", "shared"]),
  z.strictObject({ key: z.string().min(1) }),
  z.strictObject({ id: z.uuid() }),
]);
const run = z.union([
  z.strictObject({
    agent: z.enum(["codex", "claude"]),
    worktree: z.boolean({ error: "Set run.worktree to true or false" }),
    cwd: z.string().min(1),
    chat: chat.default("new"),
    prompt: z.string().min(1),
  }),
  z.strictObject({ command, cwd: z.string().optional() }),
]);
const schema = z.strictObject({
  schemaVersion: z.literal(currentRuleSchema, {
    error: `Expected schemaVersion: ${currentRuleSchema}. Run plugin setup to migrate older rules.`,
  }),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  enabled: z.boolean().default(true),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  webhook: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  check: command.optional(),
  run,
});
const snapshotSchema = schema.extend({ path: z.string(), version: z.string() });
export type Rule = z.infer<typeof snapshotSchema>;
export function readRuleSnapshot(json: string): Rule {
  return snapshotSchema.parse(JSON.parse(json));
}
export const home =
  process.env.TRIGGERBASE_HOME || join(homedir(), ".config", "triggerbase");
export const absolute = (p: string, base = process.cwd()) =>
  resolve(base, p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export function readRule(path: string): Rule {
  const raw = readFileSync(path, "utf8");
  const r = validateRule(parse(raw));
  return {
    ...r,
    path: realpathSync(path),
    version: createHash("sha256").update(raw).digest("hex"),
  };
}
export function validateRule(input: unknown) {
  const r = schema.parse(input);
  if (Boolean(r.cron) === Boolean(r.webhook))
    throw Error("Choose one source: cron or webhook");
  if (r.cron) {
    if (r.cron.trim().split(/\s+/).length !== 5)
      throw Error("Use a five-field cron expression");
    new Cron(r.cron, { timezone: r.timezone }).nextRun();
  }
  return r;
}
export function rulePaths(roots: string[]) {
  const paths = new Set<string>(),
    errors: Record<string, string> = {};
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) {
        for (const ent of readdirSync(root, { withFileTypes: true }))
          if (ent.isFile() && ent.name.endsWith(".trigger.yaml"))
            paths.add(realpathSync(join(root, ent.name)));
      } else paths.add(realpathSync(root));
    } catch (e) {
      errors[root] = String(e);
    }
  }
  return { paths, errors };
}
export function scan(roots: string[]) {
  const { paths, errors } = rulePaths(roots);
  const rules = new Map<string, Rule>(),
    conflicts = new Set<string>();
  for (const path of paths)
    try {
      const rule = readRule(path),
        previous = rules.get(rule.id);
      if (previous || conflicts.has(rule.id)) {
        if (previous) errors[previous.path] = "Duplicate rule ID " + rule.id;
        errors[path] = "Duplicate rule ID " + rule.id;
        conflicts.add(rule.id);
        rules.delete(rule.id);
      } else rules.set(rule.id, rule);
    } catch (e) {
      errors[path] = String(e);
    }
  return { rules, errors };
}
export const eventSchema = z.strictObject({
  id: z.string().min(1).max(512),
  data: z.record(z.string(), z.unknown()),
});
export const checkSchema = z.strictObject({
  events: z.array(eventSchema).max(10000),
  cursor: z.unknown().optional(),
});
export type Event = z.infer<typeof eventSchema>;
export function render(pattern: string, data: Event["data"]) {
  return pattern.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    let value: unknown = data;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
        throw Error("Missing template field " + key);
      value = (value as Record<string, unknown>)[part];
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
export function plan(rule: Rule, event: Event) {
  const cwd = absolute(rule.run.cwd || ".", dirname(rule.path));
  if ("command" in rule.run) return { cwd, command: rule.run.command };
  const mode = rule.run.chat;
  const key =
    mode === "new"
      ? ["event", rule.id, event.id]
      : mode === "shared"
        ? ["rule", rule.id]
        : "key" in mode
          ? ["key", rule.id, render(mode.key, event.data)]
          : ["existing", mode.id];
  return {
    cwd,
    agent: rule.run.agent,
    worktree: rule.run.worktree === true,
    key: JSON.stringify([rule.run.agent, ...key]),
    existing: typeof mode === "object" && "id" in mode ? mode.id : undefined,
    prompt: render(rule.run.prompt, event.data),
  };
}
