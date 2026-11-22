import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { plan, absolute } from "./rules.js";
import { execute } from "./process.js";
import type { Runner } from "./runner.js";
import type { Job } from "./store.js";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const css =
  '*{box-sizing:border-box}body{margin:0;background:#f7f7f2;color:#192c27;font:15px/1.55 system-ui,sans-serif}header{background:#142f2a;color:white;padding:18px max(6vw,24px);display:flex;align-items:center;gap:38px}header strong{font-size:19px;letter-spacing:-.5px}header strong:before{content:"↳";color:#c7ee83;margin-right:9px}a{color:#14644d;text-underline-offset:3px}header a{color:#c9dbd5;text-decoration:none}header a[aria-current=page]{color:white;border-bottom:2px solid #c7ee83}main{max-width:1080px;margin:56px auto;padding:0 24px}h1{font:500 clamp(32px,5vw,50px)/1.1 Georgia,serif;margin:0 0 28px;letter-spacing:-1.8px}h2{font-size:17px}section{background:white;border:1px solid #d9e0d8;border-radius:12px;padding:20px 24px;margin:16px 0;overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th{font-size:12px;color:#57665e}td,th{padding:13px 8px;border-bottom:1px solid #e4e8e2}tr:last-child td{border:0}.pill{font:12px ui-monospace,monospace;border-radius:20px;padding:4px 9px;display:inline-block;background:#e9efeb}.completed,.enabled{background:#daefcb;color:#24562b}.error,.unknown,.failed{background:#fae4dc;color:#82391f}pre,code{font:13px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:#586a62}details{margin:16px 0}nav{display:flex;gap:20px}article{padding:10px 0}';
const pill = (state: unknown) =>
  '<span class="pill ' + esc(state) + '">' + esc(state) + "</span>";
export async function startUI(r: Runner, port = 0) {
  const access = randomBytes(32).toString("hex"),
    session = randomBytes(32).toString("hex");
  const same = (a: string, b: string) =>
    a.length === b.length &&
    /^[a-f0-9]+$/.test(a) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const server = createServer(async (req, res) => {
    const host = "127.0.0.1:" + port;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      !["GET", "POST"].includes(req.method || "") ||
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== "http://" + host)
    ) {
      res.writeHead(403).end();
      return;
    }
    const u = new URL(req.url!, "http://" + host);
    if (
      u.pathname === "/login" &&
      same(u.searchParams.get("key") || "", access)
    ) {
      res
        .writeHead(303, {
          "set-cookie":
            "tb_session=" + session + "; HttpOnly; SameSite=Strict; Path=/",
          location: "/jobs",
        })
        .end();
      return;
    }
    if (!req.headers.cookie?.split("; ").includes("tb_session=" + session)) {
      res.writeHead(401).end("Open the journal with triggerbase ui.");
      return;
    }
    if (req.method === "POST") {
      const match = u.pathname.match(/^\/jobs\/(\d+)\/open$/);
      if (!match || req.headers.origin !== "http://" + host) {
        res.writeHead(403).end();
        return;
      }
      const job = r.store.db
        .prepare("SELECT spec,session FROM jobs WHERE id=?")
        .get(Number(match[1]));
      if (
        !job?.session ||
        JSON.parse(String(job.spec)).run.agent !== "claude"
      ) {
        res.writeHead(404).end();
        return;
      }
      try {
        await execute(
          ["claude", "--desktop", "--resume", String(job.session)],
          absolute(
            JSON.parse(String(job.spec)).run.cwd,
            dirname(JSON.parse(String(job.spec)).path),
          ),
          "",
        );
        res.writeHead(303, { location: "/jobs/" + match[1] }).end();
      } catch {
        res
          .writeHead(409)
          .end(
            "Claude Desktop could not open the session. Check Claude account sign-in.",
          );
      }
      return;
    }
    let title = "Jobs",
      body = "";
    const rules = u.pathname === "/rules";
    if (rules) {
      title = "Rules";
      const { rules: items, errors } = r.reload();
      for (const [path, error] of Object.entries(errors))
        body +=
          "<section>" +
          pill("error") +
          "<h2>" +
          esc(path) +
          "</h2><p>" +
          esc(error) +
          "</p></section>";
      for (const rule of items.values()) {
        const check = r.store.db
          .prepare("SELECT * FROM checks WHERE rule=?")
          .get(rule.id);
        body +=
          "<section>" +
          pill(rule.enabled ? "enabled" : "disabled") +
          "<h2>" +
          esc(rule.id) +
          "</h2><code>" +
          esc(rule.path) +
          "</code><p>" +
          esc(rule.cron || "Webhook · " + rule.webhook) +
          "</p>" +
          (check
            ? "<div>Last successful check · " +
              esc(check.last_ok || "Pending") +
              "<br>Next check · " +
              esc(check.next) +
              "</div>"
            : "") +
          (check?.error ? "<pre>" + esc(check.error) + "</pre>" : "") +
          "</section>";
      }
      if (!body)
        body =
          "<section>No rules found. Add a .trigger.yaml file to a configured directory.</section>";
    } else if (/^\/jobs\/\d+$/.test(u.pathname)) {
      const id = Number(u.pathname.split("/").pop()),
        job = r.store.db
          .prepare("SELECT * FROM jobs WHERE id=?")
          .get(id) as unknown as Job;
      if (!job) {
        res.writeHead(404).end("Job not found");
        return;
      }
      title = "Job #" + id;
      const rule = JSON.parse(job.spec),
        history = r.store.db
          .prepare("SELECT * FROM history WHERE job=? ORDER BY rowid")
          .all(id);
      body =
        "<section>" +
        pill(job.status) +
        "<h2>" +
        esc(job.rule) +
        "</h2><p>Event · " +
        esc(job.event_id) +
        "<br>Attempt · " +
        job.attempt +
        "<br>Rule version · <code>" +
        esc(rule.version) +
        "</code></p>";
      if (job.session && rule.run.agent === "codex")
        body +=
          '<a href="codex://threads/' +
          encodeURIComponent(job.session) +
          '">Open Codex chat ↗</a>';
      if (job.session && rule.run.agent === "claude")
        body +=
          '<form method="post" action="/jobs/' +
          id +
          '/open"><button>Open Claude Desktop</button></form>';
      try {
        const p = plan(rule, { id: job.event_id, data: JSON.parse(job.data) });
        body +=
          "<details><summary>" +
          (p.prompt ? "Agent prompt" : "Command") +
          "</summary><pre>" +
          esc(p.prompt || JSON.stringify(p.command)) +
          "</pre></details>";
      } catch {}
      if (job.result)
        body +=
          "<details><summary>Result</summary><pre>" +
          esc(job.result) +
          "</pre></details>";
      if (job.error) body += "<pre>" + esc(job.error) + "</pre>";
      body +=
        "</section><section><h2>History</h2>" +
        history
          .map(
            (h) =>
              "<article>" +
              pill(h.state) +
              " · " +
              esc(h.at) +
              " UTC</article>",
          )
          .join("") +
        "</section><section><details><summary>Event data</summary><pre>" +
        esc(JSON.stringify(JSON.parse(job.data), null, 2)) +
        "</pre></details></section>";
    } else if (["/", "/jobs"].includes(u.pathname)) {
      const jobs = r.store.list();
      body = jobs.length
        ? "<section><table><tr><th>Job</th><th>Rule</th><th>Status</th><th>Created (UTC)</th></tr>" +
          jobs
            .map(
              (j) =>
                '<tr><td><a href="/jobs/' +
                j.id +
                '">#' +
                j.id +
                "</a></td><td>" +
                esc(j.rule) +
                "</td><td>" +
                pill(j.status) +
                "</td><td>" +
                esc(j.created) +
                "</td></tr>",
            )
            .join("") +
          "</table></section>"
        : "<section>No jobs yet. Run a sample trigger to see its progress here.</section>";
    } else {
      res.writeHead(404).end();
      return;
    }
    const cloud = r.store.get<{
      pending: number;
      oldestExpires: number | null;
      expired: number;
    } | null>("relayStatus", null);
    if (rules && cloud)
      body +=
        "<section><h2>Webhook inbox</h2><p>" +
        esc(cloud.pending) +
        " pending · " +
        esc(cloud.expired) +
        " expired</p>" +
        (cloud.oldestExpires
          ? "<p>Oldest delivery expires " +
            esc(new Date(cloud.oldestExpires).toISOString()) +
            "</p>"
          : "") +
        "</section>";
    for (const pending of r.store.db
      .prepare(
        "SELECT source,error FROM inbox WHERE error IS NOT NULL ORDER BY rowid LIMIT 10",
      )
      .all())
      body +=
        "<section>" +
        pill("error") +
        "<p>" +
        esc(pending.source) +
        "</p><pre>" +
        esc(pending.error) +
        "</pre></section>";
    for (const key of ["relayError", "runnerError"]) {
      const issue = r.store.get<{ error: string } | null>(key, null);
      if (issue)
        body +=
          "<section>" +
          pill("error") +
          "<pre>" +
          esc(issue.error) +
          "</pre></section>";
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><html lang="en"><meta charset=utf-8><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
        title +
        " · Triggerbase</title><style>" +
        css +
        '</style><header><strong>Triggerbase</strong><nav><a href="/jobs" ' +
        (!rules ? "aria-current=page" : "") +
        '>Jobs</a><a href="/rules" ' +
        (rules ? "aria-current=page" : "") +
        ">Rules</a></nav></header><main><h1>" +
        title +
        "</h1>" +
        body +
        "</main></html>",
    );
  });
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", ok);
  });
  port = (server.address() as { port: number }).port;
  return { server, url: "http://127.0.0.1:" + port + "/login?key=" + access };
}
