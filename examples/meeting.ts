import { readFileSync } from "node:fs";
const { webhook } = JSON.parse(readFileSync(0, "utf8"));
if (webhook.id == null) throw Error("Missing meeting id");
const events =
  Array.isArray(webhook.transcript) && webhook.transcript.length
    ? [
        {
          id: String(webhook.id),
          data: {
            id: webhook.id,
            transcript: webhook.transcript,
            actionItems: webhook.actionItems || [],
          },
        },
      ]
    : [];
console.log(JSON.stringify({ events }));
