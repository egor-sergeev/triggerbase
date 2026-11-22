import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const { time, cursor } = JSON.parse(readFileSync(0, "utf8"));
const [field, incoming] = process.argv.slice(2);
if (!field || !incoming)
  throw Error(
    "Supply the direction field and incoming value from a test message",
  );
const key = execFileSync(
  "security",
  ["find-generic-password", "-s", "triggerbase-getsales", "-w"],
  { encoding: "utf8" },
).trim();
const since = Date.parse(cursor || time) - 300000,
  events = [];
for (let offset = 0; ; offset += 100) {
  const url = new URL(
    "https://amazing.getsales.io/flows/api/linkedin-messages",
  );
  url.search = new URLSearchParams({
    limit: "100",
    offset: String(offset),
    "order-field": "created_at",
    "order-type": "desc",
  }).toString();
  const res = await fetch(url, {
    headers: { authorization: "Bearer " + key },
    redirect: "error",
  });
  if (!res.ok) throw Error("GetSales returned " + res.status);
  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(rows))
    throw Error("Check the GetSales message collection schema");
  let older = false;
  for (const row of rows) {
    if (
      !Object.hasOwn(row, field) ||
      !row.uuid ||
      !row.lead_uuid ||
      !Number.isFinite(Date.parse(row.created_at))
    )
      throw Error(
        "Confirm the message mapping with an authorized GetSales sample",
      );
    if (Date.parse(row.created_at) < since) {
      older = true;
      continue;
    }
    if (String(row[field]) === incoming)
      events.push({
        id: row.uuid,
        data: {
          conversation:
            row.thread_uuid ||
            [row.sender_profile_uuid, row.lead_uuid].join("/"),
          message_id: row.uuid,
        },
      });
  }
  if (older || rows.length < 100) break;
}
console.log(JSON.stringify({ events: events.reverse(), cursor: time }));
