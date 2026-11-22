export const currentRuleSchema = 2;

type Fields = Record<string, unknown>;
const isMapping = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Each step upgrades one revision. Unversioned releases used revision 1.
const migrations: Record<number, (fields: Fields) => Fields> = {
  1(fields) {
    const run = fields.run;
    if (
      isMapping(run) &&
      Object.hasOwn(run, "agent") &&
      !Object.hasOwn(run, "worktree")
    )
      return { ...fields, run: { ...run, worktree: false } };
    return fields;
  },
};

export function migrateRule(input: unknown): Fields {
  if (!isMapping(input)) throw Error("Expected a YAML mapping for the rule");
  const version = Object.hasOwn(input, "schemaVersion")
    ? input.schemaVersion
    : 1;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw Error("schemaVersion must be a positive integer");
  if (version > currentRuleSchema)
    throw Error(
      `Rule schemaVersion ${version} requires a newer Triggerbase. This runner supports up to ${currentRuleSchema}.`,
    );
  let fields = input;
  for (let from = version; from < currentRuleSchema; from++) {
    const step = migrations[from];
    if (!step) throw Error(`Missing rule migration from schemaVersion ${from}`);
    fields = { ...step(fields), schemaVersion: from + 1 };
  }
  return fields;
}
