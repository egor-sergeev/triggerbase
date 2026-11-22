import { dirname } from "node:path";
import { Cron } from "croner";
import { checkSchema, scan, plan, type Rule } from "./rules.js";
import { execute } from "./process.js";
import { dispatch, codexRpc } from "./hosts.js";
import { Store, type Job } from "./store.js";

export class Runner {
  catalog: ReturnType<typeof scan>;
  constructor(public store: Store) {
    this.catalog = scan(store.roots());
  }
  reload() {
    this.catalog = scan(this.store.roots());
    return this.catalog;
  }
  recover() {
    this.store.db.exec(
      "UPDATE jobs SET status='unknown',error='Runner stopped during execution; inspect the destination before repeating' WHERE status IN ('starting','running')",
    );
  }
  async check(
    rule: Rule,
    input: {
      time: string;
      cursor: unknown;
      webhook?: unknown;
      deliveryId?: string;
    },
  ) {
    if (!rule.check) {
      const data = input.webhook ?? { time: input.time };
      return checkSchema.parse({
        events: [{ id: input.deliveryId || input.time, data }],
      });
    }
    const result = await execute(
      rule.check,
      dirname(rule.path),
      JSON.stringify({
        ...input,
        timezone:
          rule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
    return checkSchema.parse(JSON.parse(result.stdout));
  }
  async tick(now = new Date()) {
    const db = this.store.db;
    const { rules } = this.reload();
    const minute = new Date(Math.floor(now.getTime() / 60000) * 60000);
    for (const rule of rules.values()) {
      if (!rule.cron) continue;
      const prior = db
        .prepare("SELECT * FROM checks WHERE rule=?")
        .get(rule.id);
      const cron = new Cron(rule.cron, { timezone: rule.timezone });
      const next = cron.nextRun(minute)?.toISOString() || null;
      if (!rule.enabled) {
        db.prepare(
          "INSERT INTO checks(rule,slot,next) VALUES(?,?,?) ON CONFLICT(rule) DO UPDATE SET slot=excluded.slot,next=excluded.next",
        ).run(rule.id, minute.toISOString(), next);
        continue;
      }
      const since = prior?.slot
        ? new Date(String(prior.slot))
        : new Date(minute.getTime() - 60_000);
      const due = cron.nextRun(since);
      if (!due || due > minute) {
        if (!prior)
          db.prepare("INSERT INTO checks(rule,slot,next) VALUES(?,?,?)").run(
            rule.id,
            since.toISOString(),
            next,
          );
        continue;
      }
      try {
        const checked = await this.check(rule, {
          time: minute.toISOString(),
          cursor: JSON.parse(String(prior?.cursor ?? "null")),
        });
        this.store.transaction(() => {
          this.store.put(rule, checked.events);
          db.prepare(
            "INSERT INTO checks(rule,slot,cursor,last_ok,next,error) VALUES(?,?,?,?,?,NULL) ON CONFLICT(rule) DO UPDATE SET slot=excluded.slot,cursor=excluded.cursor,last_ok=excluded.last_ok,next=excluded.next,error=NULL",
          ).run(
            rule.id,
            minute.toISOString(),
            JSON.stringify(
              checked.cursor ?? JSON.parse(String(prior?.cursor ?? "null")),
            ),
            now.toISOString(),
            next,
          );
        });
      } catch (e) {
        db.prepare(
          "INSERT INTO checks(rule,slot,next,error) VALUES(?,?,?,?) ON CONFLICT(rule) DO UPDATE SET slot=excluded.slot,next=excluded.next,error=excluded.error",
        ).run(rule.id, minute.toISOString(), next, String(e));
      }
    }
    for (const item of db
      .prepare(
        "SELECT * FROM inbox WHERE available<=? ORDER BY rowid LIMIT 100",
      )
      .all(Date.now())) {
      const matches = [...rules.values()].filter(
        (r) => r.webhook === item.source,
      );
      let error = matches.length
        ? null
        : "Waiting for a rule subscribed to " + item.source;
      for (const rule of matches) {
        if (
          !rule.enabled ||
          db
            .prepare("SELECT rule FROM receipts WHERE delivery=? AND rule=?")
            .get(item.id, rule.id)
        )
          continue;
        try {
          const checked = await this.check(rule, {
            time: new Date(
              String(item.received).replace(" ", "T") + "Z",
            ).toISOString(),
            cursor: null,
            webhook: JSON.parse(String(item.body)),
            deliveryId: String(item.id),
          });
          this.store.transaction(() => {
            this.store.put(rule, checked.events);
            db.prepare("INSERT INTO receipts VALUES(?,?)").run(
              item.id,
              rule.id,
            );
          });
        } catch (e) {
          error = String(e);
        }
      }
      if (error) {
        db.prepare("UPDATE inbox SET available=?,error=? WHERE id=?").run(
          Date.now() + 60000,
          error,
          item.id,
        );
      } else
        this.store.transaction(() => {
          db.prepare("DELETE FROM inbox WHERE id=?").run(item.id);
          db.prepare("DELETE FROM receipts WHERE delivery=?").run(item.id);
        });
    }
  }
  async reconcile() {
    const rows = this.store.db
      .prepare(
        "SELECT id,session,spec FROM jobs WHERE status IN ('delivered','host_running') ORDER BY id LIMIT 20",
      )
      .all();
    for (const row of rows) {
      const marker = "[Triggerbase job " + row.id + "]";
      try {
        const { thread } = await codexRpc(process.cwd(), (call) =>
          call("thread/read", { threadId: row.session, includeTurns: true }),
        );
        const turn = thread.turns.find((t: any) =>
          t.items.some(
            (i: any) =>
              i.type === "userMessage" &&
              i.content?.some((c: any) => c.text?.startsWith(marker + "\n")),
          ),
        );
        if (turn?.status === "completed")
          this.store.mark(Number(row.id), "completed");
        else if (
          turn?.status === "inProgress" &&
          this.store.db
            .prepare("SELECT status FROM jobs WHERE id=?")
            .get(row.id)?.status !== "host_running"
        )
          this.store.mark(Number(row.id), "host_running");
        else if (turn?.status === "failed" || turn?.status === "interrupted")
          this.store.mark(Number(row.id), "failed", turn.status);
      } catch {
        /* Desktop may be offline; keep the delivery pending. */
      }
    }
  }
  async work() {
    const db = this.store.db;
    const rows = db
      .prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id")
      .all() as unknown as Job[];
    for (const row of rows) {
      const current = this.reload().rules.get(row.rule);
      if (!current?.enabled) continue;
      const rule: Rule = JSON.parse(row.spec);
      if ("agent" in rule.run) {
        try {
          const target = plan(rule, {
            id: row.event_id,
            data: JSON.parse(row.data),
          });
          const session =
            target.existing ||
            db.prepare("SELECT id FROM sessions WHERE k=?").get(target.key!)
              ?.id;
          if (
            session &&
            db
              .prepare(
                "SELECT id FROM jobs WHERE session=? AND status IN ('delivered','host_running') LIMIT 1",
              )
              .get(String(session))
          )
            continue;
        } catch (e) {
          this.store.mark(row.id, "failed", String(e));
          continue;
        }
      }
      if (
        !db
          .prepare(
            "UPDATE jobs SET status='starting',attempt=attempt+1 WHERE id=? AND status='queued'",
          )
          .run(row.id).changes
      )
        continue;
      try {
        await dispatch(this.store, row);
      } catch (e) {
        const state = db
          .prepare("SELECT status FROM jobs WHERE id=?")
          .get(row.id)?.status;
        this.store.mark(
          row.id,
          state === "running" ? "unknown" : "failed",
          String(e),
        );
      }
    }
  }
}
