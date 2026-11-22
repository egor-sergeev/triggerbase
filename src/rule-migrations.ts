// Only plugin setup imports these migrations. The runner reads the current schema.
import {
  accessSync,
  constants,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { Document, parseDocument, isMap } from "yaml";
import {
  currentRuleSchema,
  readRuleSnapshot,
  rulePaths,
  validateRule,
} from "./rules.js";
import type { Store } from "./store.js";

const steps: Record<number, (doc: Document) => void> = {
  1(doc) {
    const run = doc.get("run", true);
    if (isMap(run) && run.has("agent") && !run.has("worktree"))
      run.set("worktree", false);
  },
};

function upgrade(doc: Document) {
  if (doc.errors.length) throw doc.errors[0];
  if (!isMap(doc.contents)) throw Error("Expected a YAML mapping");
  const version = doc.has("schemaVersion") ? doc.get("schemaVersion") : 1;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw Error("schemaVersion must be a positive integer");
  if (version > currentRuleSchema)
    throw Error(`schemaVersion ${version} requires a newer Triggerbase`);
  for (let from = version; from < currentRuleSchema; from++) {
    steps[from](doc);
    doc.set("schemaVersion", from + 1);
  }
  return version !== currentRuleSchema;
}

type Edit = { path: string; before: string; after: string };
function replace(path: string, expected: string, next: string) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    const mode = statSync(path).mode & 0o777;
    writeFileSync(temp, next, { flag: "wx", mode: 0o600, flush: true });
    chmodSync(temp, mode);
    if (readFileSync(path, "utf8") !== expected)
      throw Error("Rule changed during setup: " + path);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function migrateInstalledRules(store: Store) {
  const { paths, errors } = rulePaths(store.roots());
  if (Object.keys(errors).length) throw Error(Object.values(errors).join("\n"));
  const files: Edit[] = [];
  for (const path of paths) {
    try {
      const before = readFileSync(path, "utf8"),
        doc = parseDocument(before);
      if (!upgrade(doc)) continue;
      const after = doc.toString({ lineWidth: 0 });
      validateRule(doc.toJS());
      accessSync(path, constants.W_OK);
      files.push({ path, before, after });
    } catch (e) {
      throw Error(`Cannot migrate ${path}: ${e}`);
    }
  }

  const jobs: { id: number; before: string; after: string }[] = [];
  const update = store.db.prepare(
    "UPDATE jobs SET spec=? WHERE id=? AND spec=? AND status='queued'",
  );
  const written: Edit[] = [];
  function restoreFiles() {
    for (const { path, before, after } of written.reverse())
      replace(path, after, before);
  }
  try {
    store.transaction(() => {
      for (const row of store.db
        .prepare("SELECT id,spec FROM jobs WHERE status='queued'")
        .all()) {
        const before = String(row.spec);
        try {
          const doc = new Document(JSON.parse(before));
          if (!upgrade(doc)) continue;
          const after = JSON.stringify(doc.toJS());
          readRuleSnapshot(after);
          update.run(after, row.id, before);
          jobs.push({ id: Number(row.id), before, after });
        } catch (e) {
          throw Error(`Cannot migrate queued job ${row.id}: ${e}`);
        }
      }
      for (const file of files) {
        replace(file.path, file.before, file.after);
        written.push(file);
      }
    });
  } catch (e) {
    restoreFiles();
    throw e;
  }

  return () => {
    store.transaction(() => {
      for (const { id, before, after } of jobs) update.run(before, id, after);
    });
    restoreFiles();
  };
}
