import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { home, type Rule, type Event } from "./rules.js";

export interface Job {
  id: number;
  rule: string;
  event_id: string;
  status: string;
  spec: string;
  data: string;
  created: string;
  session: string | null;
  result: string | null;
  error: string | null;
  attempt: number;
}
export class Store {
  db: DatabaseSync;
  constructor() {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "rules"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "state.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
    );
    this.db.exec(
      [
        "CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,rule TEXT,event_id TEXT,spec TEXT,data TEXT,status TEXT DEFAULT 'queued',attempt INTEGER DEFAULT 0,created TEXT DEFAULT CURRENT_TIMESTAMP,session TEXT,error TEXT,UNIQUE(rule,event_id))",
        "CREATE TABLE IF NOT EXISTS checks(rule TEXT PRIMARY KEY,slot TEXT,cursor TEXT,last_ok TEXT,next TEXT,error TEXT)",
        "CREATE TABLE IF NOT EXISTS sessions(k TEXT PRIMARY KEY,id TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,source TEXT,body TEXT,received TEXT DEFAULT CURRENT_TIMESTAMP,available INTEGER DEFAULT 0,error TEXT)",
        "CREATE TABLE IF NOT EXISTS receipts(delivery TEXT,rule TEXT,PRIMARY KEY(delivery,rule))",
        "CREATE TABLE IF NOT EXISTS history(job INTEGER,state TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TRIGGER IF NOT EXISTS job_insert AFTER INSERT ON jobs BEGIN INSERT INTO history(job,state) VALUES(new.id,new.status); END",
        "CREATE TRIGGER IF NOT EXISTS job_update AFTER UPDATE OF status ON jobs WHEN old.status!=new.status BEGIN INSERT INTO history(job,state) VALUES(new.id,new.status); END",
      ].join(";"),
    );
    // Older local preview installations may already have the base tables.
    for (const [table, column, definition] of [
      ["jobs", "result", "TEXT"],
      ["inbox", "error", "TEXT"],
      ["inbox", "available", "INTEGER DEFAULT 0"],
    ]) {
      if (
        !this.db
          .prepare("PRAGMA table_info(" + table + ")")
          .all()
          .some((row) => row.name === column)
      )
        this.db.exec(
          "ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition,
        );
    }
  }
  get<T>(k: string, fallback: T): T {
    const row = this.db.prepare("SELECT v FROM settings WHERE k=?").get(k);
    return row ? JSON.parse(String(row.v)) : fallback;
  }
  set(k: string, v: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(k, JSON.stringify(v));
  }
  roots() {
    return [join(home, "rules"), ...this.get<string[]>("paths", [])];
  }
  transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  put(rule: Rule, events: Event[]) {
    const stmt = this.db.prepare(
      "INSERT INTO jobs(rule,event_id,spec,data) VALUES(?,?,?,?) ON CONFLICT(rule,event_id) DO NOTHING",
    );
    for (const event of events)
      stmt.run(
        rule.id,
        event.id,
        JSON.stringify(rule),
        JSON.stringify(event.data),
      );
  }
  mark(id: number, status: string, error?: string) {
    this.db
      .prepare("UPDATE jobs SET status=?,error=? WHERE id=?")
      .run(status, error || null, id);
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,rule,event_id,status,attempt,created,session,error FROM jobs ORDER BY id DESC LIMIT 200",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}
