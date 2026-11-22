import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { time, timezone } = JSON.parse(readFileSync(0, "utf8"));
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const events = [];
for (let offset = 0; ; offset += 100) {
  const output = execFileSync(
    "triggerbase",
    ["mcp", "call", "codex", "attio", "list-tasks"],
    {
      input: JSON.stringify({ limit: 100, offset, is_completed: false }),
      encoding: "utf8",
    },
  );
  const result = JSON.parse(output);
  const payload =
    result.structuredContent ??
    JSON.parse(
      result.content.find((c: { type: string }) => c.type === "text").text,
    );
  const tasks = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(tasks))
    throw Error("Inspect the list-tasks output schema for this connection");
  for (const task of tasks) {
    if (task.is_completed || !task.deadline_at) continue;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(task.deadline_at)
      ? task.deadline_at
      : date.format(new Date(task.deadline_at));
    if (due > date.format(new Date(time))) continue;
    events.push({
      id: task.id.task_id + "/" + task.deadline_at,
      data: { task_id: task.id.task_id, records: task.linked_records || [] },
    });
  }
  if (tasks.length < 100) break;
}
console.log(JSON.stringify({ events }));
