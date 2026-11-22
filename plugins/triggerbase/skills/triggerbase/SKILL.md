---
name: triggerbase
description: Create, test, enable and disable local webhook and cron rules for Codex or Claude Code, inspect Triggerbase jobs and open the journal.
---

Use `triggerbase paths` and `triggerbase rules` to find trusted rule locations. If the binary is missing, follow the verified release installation in the upstream README. Check the user's active account before connecting a cloud receiver.

Write one YAML file per rule. Prefer the default rules directory. Register a different file or directory with `triggerbase paths add PATH` when requested. Use `enabled: false` while drafting. Set exactly one source, a five-field cron string or a webhook source name. Set the target agent, working directory, chat mode and prompt. An optional check is an argument array executed in the rule's directory. Pass external content as data, never as a command. Document any interpreter dependency. Keep credentials out of rules.

Check scripts read JSON from stdin. Return events with stable IDs and data and an optional cursor as JSON on stdout. Use `triggerbase mcp call codex SERVER TOOL` or `triggerbase mcp call claude SERVER TOOL` with JSON arguments on stdin. Inspect the host's actual tool schema and authorized account. Verify the check on a fixture before activating. Use `triggerbase preview RULE EVENT.json` with an emitted event for side-effect-free routing and prompt inspection. Set enabled true to activate. Respect the user's requested prompt and native host permissions.

Use `triggerbase jobs` for status and `triggerbase ui` to open the journal. Distinguish queue acceptance, running and completion. On unknown external results inspect the destination before repeating. For a local installation check use `triggerbase sample codex` or `triggerbase sample claude`.
