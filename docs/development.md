# Build and verify Triggerbase

Use Node.js 24.10+ and pnpm. All product code is TypeScript. The root package builds the CLI and macOS runner. `relay/` builds the separate Cloudflare runtime in the same workspace. The two marketplace formats point to one plugin directory.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bundle
```

Run `pnpm package:plugin` after changing runner code. Commit the compressed runner inside the plugin. CI rebuilds and compares the decompressed bytes. The shell bootstrap verifies the Node.js distribution against the pinned architecture-specific checksums, then hands setup to TypeScript.

For a source installation, add the repository's `dist/cli.js` to your PATH as `triggerbase`, register the checkout as a plugin marketplace and install `triggerbase@triggerbase` in your host. Run `triggerbase service install` from that installation. Keep the checkout in place so launchd can find it. The shell PATH recorded at installation must include the interpreter and host binaries used by your rules.

## Automated coverage

Vitest exercises real subprocesses, temporary SQLite stores, dynamically edited rule directories, cron catch-up and cursor commits. The relay suite runs actual Worker and Durable Object code under Miniflare. GitHub OAuth and SaaS calls use test servers or fixtures. An offline test loses an acknowledgment, restarts the local store and checks the resulting command's external output. Provider scenarios run the distributed example scripts and assert jobs, destinations, duplicates and Slack messages. A fixture agent can validate delivery and context selection; it cannot validate a SaaS vendor's account-specific schema or the reasoning of a model.

Playwright starts the compiled daemon with an empty state directory. It checks journal authentication, empty jobs, a completed cron command, job history, a broken rule and narrow-screen layout. Use `TRIGGERBASE_CHROME=chrome pnpm test:e2e` for installed Google Chrome. Images go to `test-results/`.

Run `node scripts/onboarding-smoke.ts` on macOS to exercise the installed plugin bootstrap with only system tools on PATH. Supply two installed plugin directories to test Codex and Claude against the same state directory. CI runs it on Intel and Apple silicon. It checks a rejected checksum, parallel installs, a due weekly cron, an upgrade with active work and recovery from a broken candidate.

The native service smoke test runs the bundled artifact in a disposable state directory with its own LaunchAgent label. Run `pnpm bundle && node scripts/service-smoke.ts` to verify installation and upgrades, bootstrap from the login plist, cron catch-up, suspension and resumption of the runner, and restart after a forced process exit. The test leaves the Mac awake and removes its temporary LaunchAgent.

## Native acceptance on macOS

```sh
node scripts/host-smoke.ts codex mcp
node scripts/host-smoke.ts claude mcp
node scripts/host-smoke.ts codex session
node scripts/host-smoke.ts claude session
```

MCP checks create disposable host profiles and use a local test tool. The session check uses the signed-in native agent, consumes two turns, and verifies that a second job remembers a random marker from the first. Successful sessions remain accessible in the host.

| Capability | Verified on the development Mac |
|---|---|
| Install both host plugins from the marketplace | Codex CLI 0.170.0 and Claude Code 2.1.329, isolated profiles |
| Call MCP without a model turn | Both real host CLIs called the fixture tool. Claude enforced its tool permission |
| Local Codex execution | On macOS 15.7.4, the installed alpha delivered its sample through launchd and Codex Desktop read the completed reply. A second job queued during an active turn reused the same chat and recalled the first job's marker. |
| Computer Use from a launchd Codex job | The native tool was present. Finder, TextEdit and QuickTime window reads returned `cgWindowNotFound` on the release Mac. Window access requires another test in an active GUI session. |
| Verified release installation | Downloaded the published archive, verified its GitHub attestation and SHA-256 checksum, and installed its packaged plugin in both host CLIs. |
| Agent worktrees | Native Codex started a new checkout from a rule pointing at a nested directory and returned the same physical working directory on a second delivery. Tests cover both host command lines, linked checkouts, empty repositories, folder fallback and in-place execution. Live Claude worktree delivery still needs a subscription test. |
| Wake and server notifications | On staging, an authenticated WebSocket signaled a synthetic webhook and the Mac finished the command in about two seconds. A second event stayed queued while the runner was suspended and completed about three seconds after resumption. A separate macOS LaunchAgent test loaded the login plist, caught up an enabled cron once, skipped a disabled rule and restarted the killed process. |
| Cloudflare staging | A Mac paired through GitHub. The runner received one signed event after an offline replay and completed one native Codex job. Rotating the webhook secret rejected old signatures. Revoking the device rejected its next poll. A point-in-time recovery drill in a disposable Cloudflare SQLite namespace restored a deleted synthetic event and its original contents. |
| Claude account selection | The runner rejects the configured API-key helper before executing a model turn. Live subscription and Desktop delivery require a signed-in subscription test |
| Vendor accounts and offline production delivery | A signed production webhook completed a native Codex job and the relay acknowledged the queue drain. Private SaaS destinations use fixtures in CI |

When changing host delivery, run the affected hosts on the release Mac. Open the created chats in their native applications, submit two jobs while a chat is busy and verify order, actual completion, Computer Use availability and focus behaviour. Use isolated sales contacts, meetings, Attio records and a Slack test channel to check external effects. For Circleback, interrupt after the first task and reconcile each stable action-item marker before proceeding. For an uncertain send, inspect the remote service. Record the OS, binary versions, scope and observed results in this matrix.

## Publishing

Follow the versioning policy in [AGENTS.md](../AGENTS.md#versioning-and-releases). Update the package and plugin manifests together, then run `pnpm package:plugin` and commit the refreshed bundle. After Linux and macOS CI pass on the release commit, push a matching `vMAJOR.MINOR.PATCH` tag. The release workflow checks the tag and manifests, runs tests, and publishes the archive, SHA-256 checksum and build provenance as the latest GitHub release. Verify the archive with `gh attestation verify` against this repository, the release workflow and the tag.
