# Triggerbase — webhook and cron triggers for Codex and Claude Code on macOS

Run your **local coding agent** when a customer replies, a meeting transcript arrives, a pull request merges, or a scheduled script finds work. Deliver the prompt to a new chat, one persistent chat, or the chat for a particular conversation. A public HTTPS receiver can hold webhooks while your Mac sleeps.

**Preview release.** The local runner, journal and Cloudflare receiver are included. Codex has completed a live local job. Both hosts passed direct MCP calls against a test server. Claude Desktop session delivery and unattended access to individual SaaS accounts still need live verification. Native Computer Use could not read a window in the latest background test. The hosted receiver is available for the preview. A signed production webhook completed a job in Codex. Local cron works immediately.

## Install by asking your agent

On macOS with Node.js 24.10+ and the GitHub CLI, paste this into **Codex or Claude Code**:

> Install Triggerbase from egor-sergeev/triggerbase for the agent I am using. Follow the verified preview installation in its README. Start the local runner, run the installation sample, wait for completion, and open the journal and the resulting chat. Tell me if my current agent account or permissions prevent completion.

The following commands install the verified release into your user account. Use the same preview tag for the archive and installation. For a source installation, use the [development guide](docs/development.md).

```sh
repo=egor-sergeev/triggerbase
tag=v0.1.0-alpha.2
stage=$(mktemp -d)
gh release download "$tag" --repo "$repo" --pattern triggerbase.tgz --dir "$stage"
gh attestation verify "$stage/triggerbase.tgz" --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/$tag"
dest="$HOME/.local/share/triggerbase/$tag"
mkdir -p "$dest" "$HOME/.local/bin"
tar -xzf "$stage/triggerbase.tgz" -C "$dest"
chmod +x "$dest/cli.js"
ln -sfn "$dest/cli.js" "$HOME/.local/bin/triggerbase"
export PATH="$HOME/.local/bin:$PATH"
```

Keep `~/.local/bin` on your shell PATH. Install the plugin in the host you use:

```sh
# Codex
codex plugin marketplace add "$dest"
codex plugin add triggerbase@triggerbase

# Claude Code
claude plugin install triggerbase --marketplace "$dest"
```

Then run:

```sh
triggerbase service install
triggerbase sample codex              # or: triggerbase sample claude
triggerbase jobs
triggerbase ui
```

The sample requests one short reply in a shared chat. A repeated sample uses the same event ID. Open its job to see the session and delivery history. Follow any host prompt to reload your plugin. Agent jobs use the locally signed-in subscription account. A CLI configured for API-key billing fails the preflight.

## Receive a public webhook

Pair your Mac with the hosted receiver using your GitHub public profile. Then register a source:

```sh
triggerbase login https://triggerbase-relay.500xp.workers.dev
triggerbase hook add pull-requests github
```

Enter the returned URL and signing secret in the sender’s webhook settings. Set `webhook: pull-requests` in the rule. Run `triggerbase jobs` to see deliveries. [Self-hosting and delivery limits](docs/relay.md)

## Configure a trigger

One file defines one rule. Save this example as `~/.config/triggerbase/rules/morning.trigger.yaml` and set `cwd` to your project. The runner discovers changes automatically.

```yaml
id: morning-review
enabled: true
cron: "0 9 * * 1-5"
run:
  agent: codex
  cwd: ~/projects/my-project
  chat: shared
  prompt: "Review the open work in this project for {{time}}."
```

Use `webhook: circleback` in place of `cron` to subscribe to a receiver source. An optional `check` runs a script in **any language** before an agent starts. It reads JSON on stdin and emits events on stdout. An empty list uses zero model turns. The script can invoke an authorized MCP tool through the selected host.

| Example | Source | Result |
|---|---|---|
| [Lemlist replies](examples/lemlist.trigger.yaml) | Poll authenticated activities | Continue the sales chat for a conversation |
| [GetSales replies](examples/getsales.trigger.yaml) | Poll LinkedIn messages | Draft a reply for the same conversation |
| [Attio deadlines](examples/attio.trigger.yaml) | Cron and a read-only MCP call | Find due tasks after sleep and draft follow-ups |
| [Circleback meeting notes](examples/circleback.trigger.yaml) | Signed transcript webhook | Deliver notes and action items to Claude |
| [GitHub PRs → Slack](examples/github.trigger.yaml) | Signed pull-request webhook | Post opened and merged PRs without an agent |

Examples ship disabled. Copy an example and its scripts together, set the working directory and connection, and test the mapping on your account before enabling it. For a rule in a repository, register its directory with `triggerbase paths add /absolute/path`. A rule may also live outside any repository. To pause one, set `enabled: false`.

## Frequently asked questions

**Does Triggerbase start after a reboot?** Run `triggerbase service install` once. The macOS LaunchAgent starts the runner when you log in and restarts it if it exits. After an upgrade, run the same command from the new installation.

**What happens while my Mac sleeps?** The receiver queues verified webhooks for up to 30 days. While the Mac is online, the receiver signals new events over an outbound WebSocket. The runner checks the queue at startup, after detecting wake and on reconnect. If the socket is unavailable, it polls once a minute. After missed cron ticks, each enabled rule runs one catch-up check. A check can use its saved cursor to retrieve the missed interval.

**Can a script use my existing MCP authorization?** Use `triggerbase mcp call codex SERVER TOOL` or `triggerbase mcp call claude SERVER TOOL`, with JSON arguments on stdin. The host checks its own connection and permissions. A tool requiring interactive consent will report an error in unattended use.

**Where do I review and send a draft?** Continue in your agent's chat. Your prompt and native tool permissions determine which actions the agent takes.

**What does it cost?** Local scheduling has no Triggerbase service charge. Agent usage follows your host account. The optional relay can use Cloudflare Workers Free within quotas or Workers Paid. [Deployment and limits](docs/relay.md)

**How do I debug a missing job?** Open Rules in the journal to inspect the file path, parse errors and last successful check. Open Jobs for the event, rule version, attempt, rendered task and session. A delivered message may still be waiting for its host to start.

[Rule and command reference](docs/rules.md) · [Security and private reporting](SECURITY.md) · [Development and live test matrix](docs/development.md) · [Apache-2.0 license](LICENSE)
