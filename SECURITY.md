# Security

Report suspected vulnerabilities privately with the repository owner's GitHub private vulnerability reporting channel. If it is unavailable, contact the maintainer privately through their GitHub profile. Include the affected version and redacted evidence.

## Trust boundaries

The hosting operator sees inbound webhook content while validating it. The Worker encrypts queued bodies and provider secrets with AES-256-GCM and record-specific associated data. The encryption key is a Worker secret. This is application-layer encryption at rest; the operator and a compromised Worker remain in the trust boundary. The GitHub sign-in token is used for account identity. Separate random device credentials are revocable, scoped to one account, stored in Keychain locally and hashed at the receiver.

GitHub and Circleback use provider-specific HMAC verification over the original bytes. The generic bearer endpoint requires an independent secret header. A URL alone cannot authorize a delivery. For providers without authenticated webhooks, poll their authorized APIs. Account isolation applies to device management, endpoint creation, pulling and acknowledgement. A per-IP edge limit, per-account capacities, body size limit and ingress throttling bound accepted work.

The journal binds to loopback. Local authentication, Host checks, SameSite cookies, Origin checks, output escaping and CSP protect its routes. Rules and check programs run as the local OS user. A writable shared rule directory grants local code execution to its writers. Agent tool permissions and subscription credentials stay with the host. An untrusted message or transcript can influence an agent. Keep the task and tool permissions appropriate to the data.

Local SQLite contains payloads, resolved rule snapshots, errors and session IDs. The state directory is user-private. Use FileVault for disk encryption. Scripts should keep secrets off stdout, stderr and argument lists. Use Keychain or the host MCP connection. The plugin installer trusts the host-selected GitHub marketplace and its bundled code. It verifies the official Node.js archive against a SHA-256 digest pinned in that plugin. CI compares the bundled runner with a fresh source build. For an independent audit of a release archive, verify its GitHub attestation against this repository, release workflow and tag.
