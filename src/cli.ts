#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "./store.js";
import { Runner } from "./runner.js";
import { home, absolute, eventSchema, plan, readRule } from "./rules.js";
import { execute } from "./process.js";
import { mcp } from "./hosts.js";
import { api, login } from "./cloud.js";
import { service } from "./service.js";
import { startRelayFeed } from "./relay-feed.js";
import { startUI } from "./ui.js";

const help =
  "triggerbase start | service install|stop|uninstall | paths [add|remove PATH] | rules | preview FILE EVENT.json | sample [codex|claude] | jobs | ui [--url] | login HTTPS_ORIGIN | hook add SOURCE github|circleback|bearer | hook remove SOURCE | devices [revoke ID] | mcp call HOST SERVER TOOL";
function print(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}
async function daemon(store: Store) {
  // The OS releases this separate SQLite transaction even after SIGKILL.
  const lock = new DatabaseSync(join(home, "runner-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw Error("Runner already active");
  }
  const runner = new Runner(store);
  runner.recover();
  const { server, url } = await startUI(runner);
  writeFileSync(join(home, "journal.url"), url, { mode: 0o600 });
  const stopFeed = startRelayFeed(store);
  const stop = () => {
    stopFeed();
    server.close();
    lock.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let working = false;
  for (;;) {
    try {
      await runner.tick();
      if (!working) {
        working = true;
        void runner
          .work()
          .then(() => runner.reconcile())
          .catch((e) => store.set("runnerError", { error: String(e) }))
          .finally(() => {
            working = false;
          });
      }
    } catch (e) {
      store.set("runnerError", { error: String(e) });
    }
    await sleep(3000);
  }
}
async function main() {
  process.umask(0o077);
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "--help") {
    console.log(help);
    return;
  }
  if (cmd === "mcp") {
    if (args.length !== 4 || args[0] !== "call")
      throw Error(
        "Usage: triggerbase mcp call HOST SERVER TOOL < arguments.json",
      );
    print(
      await mcp(
        args[1],
        args[2],
        args[3],
        JSON.parse(readFileSync(0, "utf8") || "{}"),
      ),
    );
    return;
  }
  const store = new Store(),
    runner = new Runner(store);
  try {
    switch (cmd) {
      case "start":
        await daemon(store);
        break;
      case "service":
        await service(args[0], store);
        break;
      case "paths": {
        if (args.length) {
          if (!args[1] || !["add", "remove"].includes(args[0]))
            throw Error(help);
          const path = absolute(args[1]);
          if (args[0] === "add") realpathSync(path);
          store.transaction(() => {
            const list = store.get<string[]>("paths", []);
            store.set(
              "paths",
              args[0] === "add"
                ? [...new Set([...list, path])]
                : list.filter((p) => p !== path),
            );
          });
        }
        print(store.roots());
        break;
      }
      case "rules": {
        const { rules, errors } = runner.reload();
        print({ rules: [...rules.values()], errors });
        break;
      }
      case "jobs":
        print(store.list());
        break;
      case "preview": {
        const rule = readRule(absolute(args[0])),
          event = eventSchema.parse(JSON.parse(readFileSync(args[1], "utf8")));
        print(plan(rule, event));
        break;
      }
      case "sample": {
        const agent = args[0] || "codex";
        if (!["claude", "codex"].includes(agent)) throw Error(help);
        const id = "welcome-" + agent;
        const file = join(home, "rules", id + ".trigger.yaml");
        const yaml =
          "id: " +
          id +
          "\nenabled: true\nwebhook: local-sample\nrun:\n  agent: " +
          agent +
          "\n  cwd: " +
          JSON.stringify(process.cwd()) +
          '\n  chat: shared\n  prompt: "Reply with the words: Triggerbase is connected. No tools needed."\n';
        if (!existsSync(file)) writeFileSync(file, yaml, { flag: "wx" });
        const rule = readRule(file);
        if (!rule.enabled || rule.id !== id)
          throw Error("Sample rule is disabled or replaced");
        store.put(rule, [{ id: "installation-check", data: {} }]);
        print({ rule: id, event: "installation-check" });
        break;
      }
      case "ui": {
        const url = readFileSync(join(home, "journal.url"), "utf8");
        if (args[0] === "--url") console.log(url);
        else await execute(["open", url], home, "");
        break;
      }
      case "login":
        await login(store, args[0]);
        break;
      case "devices":
        print(
          args[0] === "revoke"
            ? await api(
                store,
                "/v1/devices/" + encodeURIComponent(args[1]),
                "DELETE",
              )
            : await api(store, "/v1/devices"),
        );
        break;
      case "hook": {
        if (args[0] === "add")
          print(
            await api(store, "/v1/hooks", "POST", {
              source: args[1],
              kind: args[2],
            }),
          );
        else if (args[0] === "remove")
          print(
            await api(
              store,
              "/v1/hooks/" + encodeURIComponent(args[1]),
              "DELETE",
            ),
          );
        else throw Error(help);
        break;
      }
      default:
        throw Error(help);
    }
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
