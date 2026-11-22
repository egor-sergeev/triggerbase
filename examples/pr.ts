import { readFileSync } from "node:fs";
const { webhook } = JSON.parse(readFileSync(0, "utf8"));
const pr = webhook.pull_request;
const state =
  webhook.action === "opened"
    ? "opened"
    : webhook.action === "closed" && pr?.merged === true
      ? "merged"
      : null;
const events =
  pr && state
    ? [
        {
          id: [webhook.repository.id, pr.number, state].join("/"),
          data: { state, url: pr.html_url },
        },
      ]
    : [];
console.log(JSON.stringify({ events }));
