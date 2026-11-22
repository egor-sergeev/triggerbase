// Executed by the plugin's pinned Node runtime.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const base = resolve(process.argv[2]);
const plugin = new URL("../", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("plugin.json", plugin), "utf8"),
);
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version))
  throw Error("Invalid plugin version");
const dir = join(base, "v" + version, process.arch + "-" + process.version);
const cli = join(dir, "cli.js");
const entry = join(dir, "triggerbase");
const link = process.env.TRIGGERBASE_HOME
  ? join(base, "bin/triggerbase")
  : join(homedir(), ".local/bin/triggerbase");
const lock = new DatabaseSync(join(base, "setup.sqlite"));
const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
try {
  lock.exec("PRAGMA busy_timeout=30000; BEGIN IMMEDIATE");
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isSymbolicLink() ||
      !resolve(dirname(link), readlinkSync(link)).startsWith(base + "/v"))
  ) {
    throw Error(
      "Another command owns " +
        link +
        ". Move it before installing Triggerbase.",
    );
  }
  const oldVersion =
    stat &&
    resolve(dirname(link), readlinkSync(link))
      .slice(base.length + 2)
      .split("/")[0];
  const [oldCore, oldPreview] = (oldVersion || "0.0.0").split("-");
  const [core, preview] = version.split("-");
  const compare = (a: string, b: string) =>
    a.localeCompare(b, "en", { numeric: true });
  if (
    compare(oldCore, core) > 0 ||
    (oldCore === core &&
      preview &&
      (!oldPreview || compare(oldPreview, preview) > 0))
  ) {
    throw Error(
      "A newer shared runner is installed. Update this host's Triggerbase plugin.",
    );
  }
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  const bundle = gunzipSync(readFileSync(new URL("bin/cli.js.gz", plugin)));
  if (!existsSync(cli)) {
    writeFileSync(cli + ".tmp", bundle);
    renameSync(cli + ".tmp", cli);
  } else if (!readFileSync(cli).equals(bundle))
    throw Error("Installed runner differs from this plugin version");
  const script =
    "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(cli) + ' "$@"\n';
  writeFileSync(entry + ".tmp", script, { mode: 0o700 });
  renameSync(entry + ".tmp", entry);
  execFileSync(process.execPath, [cli, "--help"], { stdio: "ignore" });
  const tempLink = link + "." + process.pid;
  symlinkSync(entry, tempLink);
  try {
    execFileSync(process.execPath, [cli, "service", "install"], {
      stdio: "inherit",
    });
    renameSync(tempLink, link);
  } finally {
    if (lstatSync(tempLink, { throwIfNoEntry: false })) unlinkSync(tempLink);
  }
  console.log(
    "Triggerbase " +
      version +
      " ready. Starts at login. Local journal is responding.",
  );
} finally {
  lock.close();
}
