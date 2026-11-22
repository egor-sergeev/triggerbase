# Install Triggerbase for the current host

This is the procedure for the agent handling the README prompt. Use the current user's local host CLI. Install the plugin, run its setup from the installed copy, and report readiness in the same conversation. Setup includes the runner, login service and journal check. It requires internet access to GitHub and nodejs.org. The host may ask the user to reload the plugin to expose its skill in future chats.

## Codex

Run `codex plugin marketplace add egor-sergeev/triggerbase`, then `codex plugin add triggerbase@triggerbase --json`. Read `installedPath` from the result and run `/bin/sh "$installedPath/setup.sh"`. Preserve the full path as one argument.

## Claude Code

Run `claude plugin install triggerbase --marketplace egor-sergeev/triggerbase`. Find the enabled `triggerbase@triggerbase` entry in `claude plugin list --json`. Run `/bin/sh "$installPath/setup.sh"` with its `installPath`.

## Finish setup

Wait for the installer to report that the runner starts at login and the journal is responding. Report that result and ask what the user wants to automate. Leave demo jobs, model calls and relay pairing for explicit requests. If a step fails, report the failing step and its error. No root access or shell profile edits are needed. The CLI is available to the agent at `~/.local/bin/triggerbase` even when that directory is outside the shell PATH.

The installer selects a pinned official Node.js runtime for the Mac, checks its SHA-256 before extraction and installs a per-user launchd service. Runtime and runner files live under `~/.local/share/triggerbase/`. Rules and job history live separately in `~/.config/triggerbase/`.

## Update or remove

**Existing rules migrate automatically.** Update the plugin and run setup. The runner reads older rules from the default directory and registered paths, including read-only files. Agent rules that predate worktrees keep running in their configured directory. Existing worktree choices, queued jobs and chat bindings carry over. Run `triggerbase rules` to inspect the effective configuration and any errors. [Rule schema versions](rules.md#rule-schema-versions)

**Updating from the historical 2.0.0 release.** Worktree support was renumbered to 1.1.0. Use the usual update procedure below. The installer recognizes the transition and reuses your rules, job history and device pairing.

Refresh the GitHub marketplace in the current host (`codex plugin marketplace upgrade triggerbase` or `claude plugin marketplace update triggerbase`). Apply the new plugin version with `codex plugin add triggerbase@triggerbase --json` or `claude plugin update triggerbase@triggerbase`. Run setup from that installed version and check readiness. Each host shares the same runner. If a job is active, setup waits up to a minute, then asks you to retry after the job completes.

**Migrating alpha.1 or alpha.2.** Those versions registered a local archive directory as the marketplace. If the host reports a source conflict, inspect the registered source. For the legacy Triggerbase path under `~/.local/share/triggerbase/v*/`, remove that marketplace from the current host, then follow the GitHub installation above. Both versions use the same local state and Keychain pairing. Leave unrelated marketplaces alone.

**Remove from one host.** Use the host’s plugin removal command. The shared runner continues to serve rules on this Mac.

**Uninstall from the Mac.** Run `~/.local/bin/triggerbase service uninstall` first. Remove the Triggerbase plugin and its marketplace from each installed host. Remove the Triggerbase-owned launcher and runtime directory. Keep the rules, SQLite history and Keychain pairing unless the user asks to erase or revoke them. To retire a paired device, revoke it before removing the CLI. [Device revocation](relay.md#pair-a-mac-and-register-a-source)
