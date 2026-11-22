import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { time, cursor } = JSON.parse(readFileSync(0, "utf8"));
const key = execFileSync(
  "security",
  ["find-generic-password", "-s", "triggerbase-lemlist", "-w"],
  { encoding: "utf8" },
).trim();
const events = [];
const since = new Date(
  new Date(cursor || time).valueOf() - 300000,
).toISOString();
for (let offset = 0; ; offset += 100) {
  const url = new URL("https://api.lemlist.com/api/activities");
  url.search = new URLSearchParams({
    type: "emailReplied",
    minDate: since,
    maxDate: time,
    limit: "100",
    offset: String(offset),
  }).toString();
  const response = await fetch(url, {
    headers: {
      authorization: "Basic " + Buffer.from(":" + key).toString("base64"),
    },
    redirect: "error",
  });
  if (!response.ok) throw Error("Lemlist returned " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw Error("Unexpected activities response");
  for (const r of rows) {
    if (!r._id || !r.leadId || !r.campaignId)
      throw Error("Missing activity identity");
    events.push({
      id: r._id,
      data: {
        conversation: r.threadId || [r.campaignId, r.leadId].join("/"),
        lead_id: r.leadId,
        activity_id: r._id,
      },
    });
  }
  if (rows.length < 100) break;
}
console.log(JSON.stringify({ events, cursor: time }));
