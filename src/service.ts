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

const suffix = process.env.TRIGGERBASE_HOME
  ? "." + createHash("sha256").update(home).digest("hex").slice(0, 12)
  : "";
const label = "dev.triggerbase.runner" + suffix,
  dir = join(homedir(), "Library", "LaunchAgents"),
  plist = join(dir, label + ".plist");
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export async function service(cmd: string) {
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
  if (existsSync(plist) && readFileSync(plist, "utf8") === contents) {
    const loaded = await execute(
      ["launchctl", "print", domain + "/" + label],
      home,
      "",
    ).then(
      () => true,
      () => false,
    );
    if (loaded) return;
  }
  const temp = plist + "." + process.pid;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, plist);
  await execute(["launchctl", "bootout", domain + "/" + label], home, "").catch(
    () => {},
  );
  // launchd may acknowledge bootout before it releases the old registration.
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
