# Rule reference

Register files with `triggerbase paths add PATH` and unregister them with `triggerbase paths remove PATH`. A directory includes immediate regular files ending in `.trigger.yaml`. A file entry includes that specific file. The default directory is `~/.config/triggerbase/rules`. Register only paths whose contributors you trust to execute code as your user.

| Field | Meaning |
|---|---|
| `schemaVersion` | Set to `2` for new rules. Older files can omit it. |
| `id` | Stable unique rule ID, up to 80 lowercase letters, digits, dots, underscores or hyphens. Start with a letter or digit. |
| `enabled` | Defaults to true. False holds queued work and prevents new agent launches. Setting it true resumes eligible queued work. A running process may finish. |
| `cron` or `webhook` | Exactly one source. Five-field cron uses local time, optionally overridden by an IANA `timezone`. A webhook name matches the name registered at the receiver. Direct webhook templates read the verified JSON object. |
| `check` | Optional executable and argument array. Working directory is the rule file's directory. On a timer with no check, the event contains `time`. |
| `run.agent` | `codex` or `claude`. Set `cwd` and `prompt`. Relative directories resolve against the rule file. |
| `run.worktree` | Required boolean for agent rules. Use `false` for the configured directory. Use `true` to start new chats in a host-managed Git worktree. Command rules omit this field. |
| `run.chat` | `new` (default), `shared`, `{key: "{{conversation_id}}"}` or `{id: "<session UUID>"}`. A keyed chat is scoped to its rule and host. |
| `run.command` | An executable and argument array, with optional `cwd`. Receives the event data on stdin. |

## Rule schema versions

The runner upgrades each rule in memory when it reads the file. An absent `schemaVersion` means revision 1. A revision 1 agent rule with no worktree setting runs in its configured directory. Explicit worktree choices carry over, and command rules keep their arguments. The original YAML, including comments, stays on disk. Queued jobs use the rule saved when the event arrived.

For example, this rule from Triggerbase 1.0 still runs in place:

```yaml
id: daily-review
cron: "0 9 * * 1-5"
run:
  agent: codex
  cwd: ~/projects/shop
  prompt: "Summarize yesterday's changes."
```

When writing its equivalent today, add `schemaVersion: 2` at the top and `worktree: false` under `run`. A newer, unsupported schema appears as an error in the journal and in `triggerbase rules`. Update the plugin to load that rule. Other valid rules continue running.

## Agent working directory

Set `worktree` under `run` alongside `agent` and `cwd`:

```yaml
run:
  agent: codex
  cwd: ~/projects/shop/packages/api
  worktree: true
  chat: shared
  prompt: "Review recent changes in packages/api."
```

With `true`, Git discovers the enclosing checkout from `cwd`, including linked worktrees and submodules. The selected host starts at the root of the **new** checkout. Name the subdirectory in the prompt when the task targets one package. In an existing folder outside Git, with Git unavailable, or before the first commit, the job runs in its configured directory and records the reason in job history. An error creating a worktree in a usable repository fails the job. Triggerbase never retries that task in the source checkout.

`chat: new` gets a worktree per new chat. Shared and keyed chats keep their original workspace on later deliveries, including after a runner restart. An explicit session ID resumes an existing chat. Changing the flag affects new chats. Worktree creation requires a host CLI that supports `--worktree`. The host owns its worktrees.

## Script protocol

On stdin a check receives `time`, `timezone`, `cursor`, and for webhooks `webhook` and `deliveryId`. Times are UTC. The timezone gives the user's local calendar for deadline rules. On stdout return one JSON object:

```json
{"events":[{"id":"reply-387","data":{"conversation_id":"sales-12","text":"Thursday works."}}],"cursor":"page-17"}
```

A successful empty check returns `{"events":[]}`. Only a successful check advances the cursor. Standard error is for diagnostics. A nonzero exit, timeout or malformed output fails the check. Scheduled checks retry at the next cron occurrence. Webhook checks retry from the local inbox. One event ID can produce one job per rule. Choose a stable ID from the provider. For rescheduled tasks include the deadline in the event ID.

A command is trusted user code and can make external changes. A command with an ambiguous outcome enters `unknown`. Inspect the provider before repeating work. Agent-level operations inside a turn follow the agent's own instructions and permissions. For external writes use provider idempotency keys or reconcile a stable business identifier before retrying.

## Preview and setup

Save one **emitted** event containing `id` and `data` and run `triggerbase preview RULE EVENT.json`. Preview resolves the message, chat key, command and directory without executing the check or target. A raw webhook fixture can be tested separately by feeding an envelope into the check. Run only checks you trust to execute.

MCP tools receive JSON on stdin. For example, `printf '{}' | triggerbase mcp call codex fixture ping` calls `ping` on the host's configured `fixture` server. Confirm the server and tool names and arguments in the host's tool list. Claude enforces tool permissions on its control channel. Use a narrow read permission on the intended connection for unattended polling.

## Provider examples

- **Lemlist.** Create a local generic password item named `triggerbase-lemlist` in Keychain Access with your API key. The example queries activities with a bounded time window and pagination. The first check covers five minutes. It uses a thread ID if available, otherwise groups by campaign and lead. [Activities API](https://developer.lemlist.com/api-reference/endpoints/activities/get-many-activities)
- **GetSales.** Create a local Keychain item named `triggerbase-getsales`. Confirm the message direction field and inbound value on a real message, then update the two arguments to the example check. The example polls LinkedIn messages. For email use the corresponding mailbox reader and its actual schema. [GetSales API guide](https://help.getsales.io/en/articles/10217805-getsales-api-quick-start-guide)
- **Attio.** Connect the Attio MCP server in Codex. Inspect `list-tasks` on your connection and verify its pagination, output and exact server name. The example checks all currently open tasks and includes overdue ones on its first run. [Attio MCP](https://attio.com/apps/mcp)
- **Circleback.** Configure a signed meeting webhook with transcript and action items. The example uses the meeting ID for deduplication and requests reconciliation by action item ID inside the agent task. Verify task creation and recovery in a test workspace before using it for external writes. [Webhook reference](https://circleback.ai/integrations/webhooks)
- **GitHub.** Register a signed pull-request webhook, choose JSON as the content type and store the Slack incoming webhook URL as the generic password `triggerbase-slack-webhook`. The check maps only opened and successfully merged PRs. The URL determines the Slack channel.

## Service commands

`triggerbase service install` installs or updates the per-user LaunchAgent. `triggerbase start` runs the same daemon in the foreground. Only one daemon can own a state directory. `service stop` unloads it. `service uninstall` also removes its LaunchAgent file. For complete removal uninstall the plugin in the host and remove the installed binaries. Rules and the local SQLite database belong to you. Delete that directory explicitly only if you no longer need the data. Revoke cloud devices and remove their Keychain entries when retiring an installation.

The default state directory is `~/.config/triggerbase`. Set `TRIGGERBASE_HOME` for an isolated installation. The authenticated journal is local. Treat the output of `ui --url` as a credential.
