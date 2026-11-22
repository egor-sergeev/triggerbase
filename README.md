# Triggerbase — webhook and cron triggers for Codex and Claude Code on macOS

Give your coding agent a task to run when something happens. Triggerbase can open a new chat for each event, keep a weekly report in one chat, or route each conversation to its own thread. A background process on your Mac runs the rules after you close the setup chat.

## Install with one prompt

Open **Codex or Claude Code on your Mac** and paste this message:

> Install Triggerbase from https://github.com/egor-sergeev/triggerbase for the agent I’m using. Start it automatically when I log in and check that it’s ready.

Your agent follows the [installation instructions](docs/install.md), installs the plugin for the current host, and checks that the local job journal responds. Expect a readiness message and a question about your first automation. Installation runs under your macOS account and downloads its own Node.js runtime. If you use both hosts, paste the prompt in each. They share one runner and one set of rules.

**Requirements.** A Mac with Apple silicon or Intel, internet access for installation, and a local Codex or Claude Code CLI. Agent jobs use the host’s signed-in subscription. Live chat delivery has been verified in Codex. Claude subscription chat delivery and unattended Computer Use still need live verification. [Test coverage](docs/development.md#native-acceptance-on-macos)

## Create your first automation

Open a project in your agent and ask:

> Every Friday at 4 pm, summarize this project’s Git commits from the past week. Keep the reports in the same chat. Show me the schedule and where the rule is saved.

The agent creates a weekly rule for that project. At 4 pm local time on Friday, Triggerbase sends the task to your agent in the project directory. The first run creates the report chat. Later runs continue it. You can ask “Move the report to Thursday at 3 pm” or “Pause the weekly report.” The local journal shows the rule, its next check and its job history.

## Choose what starts a job

| When you want the agent to run | What Triggerbase does |
| --- | --- |
| At a given time | A five-field cron expression schedules the task in local time or a named time zone. |
| When an API or file changes | Cron runs a check script. The script returns events with stable IDs and any data the prompt needs. An empty result uses no agent turn. A saved cursor lets the next check pick up where it left off. |
| When a service sends a webhook | A public HTTPS receiver verifies and queues the payload. Your Mac receives a notification and pulls the event. The rule can extract fields, filter events and group related messages into chats. |

For your first public webhook, ask the agent to connect the sender. It pairs your Mac with the hosted receiver using your GitHub identity, then registers the source. Enter the returned URL and signing secret in the sender’s webhook settings. Scheduled rules work locally without pairing. [Webhook setup, supported signatures and retention](docs/relay.md)

## Where rules, data and results live

- **Rules** are individual YAML files in `~/.config/triggerbase/rules/`. Ask the agent to register another file or directory to keep project-specific rules in a repository. Edits take effect automatically. Set `enabled: false` to pause a rule.
- **Inputs** can supply prompt variables such as `{{title}}`. A check script can call an MCP tool through the host’s existing connection. Unattended checks need permission to use that tool. A rule can also run a local command directly. [Fields, scripts and chat routing](docs/rules.md)
- **Results** appear in the selected agent chat. Ask “Open the Triggerbase journal” to see what ran, when it ran and any error. To diagnose a missed task, ask “Why didn’t my weekly report run?”
- **Sleep and reboot.** Webhooks stay queued for up to 30 days. After wake or reconnect, the runner retrieves them. Each enabled cron rule gets one catch-up check after missed ticks. After reboot the runner starts when you log in.
- **Privacy and cost.** Local-only rules keep their configuration and history on your Mac. Agent prompts go to the host you chose. Public webhook bodies pass through the receiver and are encrypted while queued. Checks that emit no events have no model cost. Agent jobs use your host subscription. [Security](SECURITY.md) · [Receiver limits and hosting costs](docs/relay.md)

To update, ask “Update Triggerbase and verify it starts at login.” To remove it, ask “Uninstall Triggerbase from this Mac and keep my rules and history.” [Update and removal](docs/install.md#update-or-remove)

[Example rules](examples) · [Build and test](docs/development.md) · [License](LICENSE)
