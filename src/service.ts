import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execute } from "./process.js";
import { home } from "./rules.js";

const label = "dev.triggerbase.runner",
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
  const path = [
    dirname(process.execPath),
    process.env.PATH || "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
  ].join(":");
  writeFileSync(
    plist,
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>' +
      label +
      "</string><key>ProgramArguments</key><array>" +
      [process.execPath, cli, "start"]
        .map((s) => "<string>" + xml(s) + "</string>")
        .join("") +
      "</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>" +
      xml(path) +
      "</string><key>TRIGGERBASE_HOME</key><string>" +
      xml(home) +
      "</string></dict></dict></plist>",
    { mode: 0o600 },
  );
  await execute(["launchctl", "bootout", domain + "/" + label], home, "").catch(
    () => {},
  );
  await execute(["launchctl", "bootstrap", domain, plist], home, "");
}
