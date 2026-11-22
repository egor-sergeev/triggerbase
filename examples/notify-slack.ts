import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { url, state } = JSON.parse(readFileSync(0, "utf8"));
const destination = execFileSync(
  "security",
  ["find-generic-password", "-s", "triggerbase-slack-webhook", "-w"],
  { encoding: "utf8" },
).trim();
if (new URL(destination).origin !== "https://hooks.slack.com")
  throw Error("Expected a Slack incoming webhook");
const response = await fetch(destination, {
  method: "POST",
  redirect: "error",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "PR " + state + " — " + url }),
});
if (!response.ok) throw Error("Slack returned " + response.status);
