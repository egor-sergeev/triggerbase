# Deploy the HTTPS webhook receiver

The TypeScript Worker and its SQLite-backed Durable Objects run in Cloudflare. A separate object stores each GitHub account's devices, endpoints and encrypted inbox. The user-facing process and agent sessions run on macOS. The source tree includes staging and production configurations.

## Provision an environment

1. Use the Cloudflare account intended for this service. Run `pnpm install --frozen-lockfile` and `pnpm exec wrangler whoami`. Choose a workers.dev subdomain or configure a custom domain. Enable Workers Analytics Engine on the target account for anonymous queue metrics.
2. Prepare a GitHub OAuth App per environment. Its homepage is the relay origin and its authorization callback is `https://YOUR-RELAY/auth/callback`. Generate a client secret. The flow needs public account identity.
3. Set Worker secrets with `pnpm exec wrangler secret put NAME --config relay/wrangler.jsonc`. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `ENCRYPTION_KEY` (32 random bytes, base64). Paste secrets through Wrangler's input prompt or an approved secret manager. Add `--env production` to every production secret and deployment command.
4. Deploy staging with `pnpm deploy:relay`. Run the offline delivery and device revocation checks below. Deploy production with `pnpm deploy:relay --env production`. `GET /health` is a liveness check. Pairing and an authenticated signed test delivery verify the configured secrets and storage.
5. Enable Cloudflare account budget alerts and alert on HTTP 429/5xx, storage usage, sustained queue age and expired events. Keep request bodies, Authorization headers, OAuth codes, cookies and credentials out of logs. Workers Paid starts at $5/month before usage beyond the included limits. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## Pair a Mac and register a source

```sh
triggerbase login https://YOUR-RELAY
triggerbase hook add pull-requests github
triggerbase devices
```

The sign-in opens GitHub in a browser. A one-time code returns to a loopback port. The CLI redeems it with a verifier and stores the device token in Keychain. GitHub and bearer hooks return a public URL and a one-time secret. Enter these in the sender’s webhook settings. Avoid saving that command's output in a shared log. The rule's `webhook` value is the source name, here `pull-requests`.

**Circleback issues the signing key.** Run `triggerbase hook add meetings circleback`, enter the returned URL in the Circleback automation’s **Send webhook request** step, then copy its signing key. On macOS, run `pbpaste | triggerbase hook signing-key meetings` and clear the clipboard. The endpoint accepts deliveries after the key is set. Use the same command when Circleback rotates its key. Test the webhook in Circleback before enabling the automation. [Circleback webhook setup](https://circleback.ai/integrations/webhooks)

For a title-only rule use `triggerbase hook add meetings circleback --title-only personal Sensitive`. After verifying the signature, the receiver drops meetings with any listed tag (case-insensitive) and queues only `id` and `name`. Omit the tags to include every meeting. The default Circleback hook forwards the signed JSON in full.

Use `hook remove SOURCE` to retire an endpoint and `devices revoke ID` to revoke an installation. To rotate an endpoint without a delivery gap, register a temporary new source, test it, update the sender and remove the old one. For receiver encryption-key rotation, deploy the old key under `PREVIOUS_ENCRYPTION_KEY` before changing `ENCRYPTION_KEY`. Recreate old endpoint secrets and drain or expire old encrypted events before removing the previous key. Keep old backup keys in protected escrow for the backup retention period.

## Delivery contract and operating limits

- POST a verified JSON payload to the generated endpoint. Status 202 means persisted. Authenticated replay of the same bytes for the same source returns 200 with `duplicate`. A source-specific check can additionally deduplicate semantic events across different serializations.
- A paired Mac opens an authenticated outbound WebSocket to `/v1/notify`. After persisting a new event, the receiver sends `pending` to the registered device. The signal contains no event data. The runner reconciles the queue on subscription and when its local timer detects a sleep gap. If push is unavailable it checks the queue every 60 seconds. A protocol ping checks idle connections. Cloudflare can keep the socket open while the Durable Object hibernates.
- The Mac retrieves the oldest event and writes a local SQLite inbox transaction before acknowledging it. A lost acknowledgment can repeat delivery. Job IDs, script cursors and events are committed locally before dispatch.
- The body limit is 1 MiB. A source which can exceed it should send a signed reference and fetch the full content locally via the provider's authenticated API. Each account supports 32 sources and 256 unacknowledged events. A full inbox returns 429 rather than acknowledging an unstored event.
- Pending bodies and deduplication records expire after 30 days. An acknowledgment deletes the body immediately. Keep a provider-side history or redelivery mechanism for longer outages. Each source is delivered to the device that registered it. When replacing a Mac, drain it before moving the source. Deleting and recreating a source binds it to the new device. The journal reports pending and expired deliveries.
- Use Cloudflare's Durable Object point-in-time recovery procedures on a staging namespace. For a restore, pause senders and consumers, restore the affected account to a selected bookmark, reconcile provider delivery IDs and local job history, then reopen ingress. Test recovery on the target account before production.

## Staging acceptance

The project staging receiver runs at `https://triggerbase-relay-staging.500xp.workers.dev`. Use synthetic events for release testing. [Staging health](https://triggerbase-relay-staging.500xp.workers.dev/health)

Pair two different test accounts and verify each sees only its own inbox. Stop the local runner, deliver a signed test payload twice, then restart. Verify a single completed job in the intended native chat. Revoke the device and verify the next pull fails. Rotate the webhook secret, confirm that the old one fails and confirm a valid new delivery. Verify expiry handling with staging fixtures. Run a backup restore drill and check alerts and quotas before routing real customer data.

## Production monitoring

The Production relay monitor GitHub Actions workflow checks the public health endpoint every 15 minutes. Its Cloudflare token has Account Analytics Read on the hosting account. It queries sampled Worker traffic and SQLite storage for the preceding hour. The job fails on HTTP 429, HTTP 5xx, runtime errors, or namespace storage at 1 GiB. GitHub delivers failed scheduled workflow notifications according to the schedule owner's notification settings.

Each nonempty queue reports its oldest event's age and the number of expirations to Analytics Engine during daily cleanup. A newly nonempty queue reports zero for both values. The monitor checks the last 25 hours and fails at seven days of age or one expiration. These measurements contain only two numbers. Staging and production write to separate datasets. The Cloudflare account also emails its owner at a $5 budget threshold.

For another deployment, set the repository variables `CF_ACCOUNT_ID` and `CF_RELAY_NAMESPACE` (the production Durable Object namespace ID), the secret `CF_ANALYTICS_TOKEN`, and the origin, script and dataset names in `scripts/monitor-relay.ts`. Run the workflow manually to verify credentials and the first queue sample after sending a signed webhook.
