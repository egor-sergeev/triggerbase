import {
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execute } from "./process.js";
import { home } from "./rules.js";
import { migrateInstalledRules } from "./rule-migrations.js";
import type { Store } from "./store.js";

const suffix = process.env.TRIGGERBASE_HOME
  ? "." + createHash("sha256").update(home).digest("hex").slice(0, 12)
  : "";
const label = "dev.triggerbase.runner" + suffix,
  dir = join(homedir(), "Library", "LaunchAgents"),
  plist = join(dir, label + ".plist");
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const journalFile = join(home, "journal.url");
async function waitForJournal(previous?: string) {
  for (let i = 0; i < 75; i++) {
    try {
      const url = readFileSync(journalFile, "utf8");
      if (
        url !== previous &&
        /^http:\/\/127\.0\.0\.1:\d+\/login\?key=[0-9a-f]{64}$/.test(url)
      ) {
        const res = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(800),
        });
        if (res.status === 303 && res.headers.get("location") === "/jobs")
          return;
      }
    } catch {
      /* launchd may still be starting the runner */
    }
    await sleep(200);
  }
  throw Error("LaunchAgent did not start the local journal");
}
export async function service(cmd: string, store: Store) {
  if (process.platform !== "darwin")
    throw Error("The background service requires macOS");
  const domain = "gui/" + process.getuid!(),
    cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (cmd === "stop") {
    await execute(["launchctl", "bootout", domain + "/" + label], home, "");
    return;
  }
  if (cmd === "uninstall") {
    if (existsSync(plist)) {
      await execute(
        ["launchctl", "bootout", domain + "/" + label],
        home,
        "",
      ).catch(() => {});
      unlinkSync(plist);
    }
    return;
  }
  if (cmd !== "install") throw Error("Unknown service action");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Homebrew replaces versioned Cellar paths during Node upgrades.
  const node =
    ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(
      (candidate) =>
        existsSync(candidate) && realpathSync(candidate) === process.execPath,
    ) || process.execPath;
  const path = [
    dirname(node),
    process.env.PATH || "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
  ].join(":");
  const contents =
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>' +
    label +
    "</string><key>ProgramArguments</key><array>" +
    [node, cli, "start"]
      .map((s) => "<string>" + xml(s) + "</string>")
      .join("") +
    "</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>" +
    xml(path) +
    "</string><key>TRIGGERBASE_HOME</key><string>" +
    xml(home) +
    "</string></dict></dict></plist>";
  const previous = existsSync(plist) ? readFileSync(plist, "utf8") : undefined;
  const target = domain + "/" + label;
  const loaded = await execute(["launchctl", "print", target], home, "").then(
    () => true,
    () => false,
  );
  if (loaded && previous === contents) {
    await waitForJournal();
    migrateInstalledRules(store);
    return;
  }
  const previousUrl = existsSync(journalFile)
    ? readFileSync(journalFile, "utf8")
    : undefined;
  const bootout = () => execute(["launchctl", "bootout", target], home, "");
  async function bootstrap() {
    for (let attempt = 0; ; attempt++) {
      try {
        await execute(["launchctl", "bootstrap", domain, plist], home, "");
        return;
      } catch (e) {
        if (attempt >= 8 || !String(e).includes("Bootstrap failed: 5")) throw e;
        await sleep(250 * (attempt + 1));
      }
    }
  }
  function writePlist(value: string) {
    const temp = plist + "." + process.pid;
    writeFileSync(temp, value, { mode: 0o600 });
    renameSync(temp, plist);
  }

  if (loaded) {
    // Hold the write lock between checking active jobs and unloading. Even an
    // alpha.2 runner must commit its 'starting' claim before it can dispatch.
    for (let attempt = 0; ; attempt++) {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !store.db
            .prepare(
              "SELECT 1 FROM jobs WHERE status IN ('starting','running') LIMIT 1",
            )
            .get()
        ) {
          await bootout();
          break;
        }
      } finally {
        store.db.exec("ROLLBACK");
      }
      if (attempt >= 60)
        throw Error(
          "A job is still running. Retry the update after it completes.",
        );
      await sleep(1000);
    }
  }
  let started = false;
  let restoreRules: (() => void) | undefined;
  try {
    restoreRules = migrateInstalledRules(store);
    writePlist(contents);
    await bootstrap();
    started = true;
    await waitForJournal(previousUrl);
  } catch (error) {
    if (started) await bootout();
    try {
      restoreRules?.();
    } finally {
      if (previous) {
        writePlist(previous);
        if (loaded) {
          await bootstrap();
          await waitForJournal(previousUrl);
        }
      } else if (existsSync(plist)) unlinkSync(plist);
    }
    throw error;
  }
}
