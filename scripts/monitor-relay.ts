const account = process.env.CF_ACCOUNT_ID;
const namespace = process.env.CF_RELAY_NAMESPACE;
const token = process.env.CF_ANALYTICS_TOKEN;
if (!account || !namespace || !token)
  throw Error("Missing Cloudflare monitoring credentials");

const health = await fetch(
  "https://triggerbase-relay.500xp.workers.dev/health",
  {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  },
);
if (!health.ok || (await health.json()).status !== "ok")
  throw Error("Relay health check failed");

async function query(path: string, body: string, contentType: string) {
  const response = await fetch("https://api.cloudflare.com/client/v4/" + path, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: "Bearer " + token, "content-type": contentType },
    body,
  });
  if (!response.ok)
    throw Error("Cloudflare analytics returned HTTP " + response.status);
  return response.json();
}

const since = new Date(Date.now() - 3_600_000).toISOString();
const metrics = await query(
  "graphql",
  JSON.stringify({
    query: `query Relay($account: string!, $ns: string!, $since: Time!) {
    viewer { accounts(filter: {accountTag: $account}) {
      requests: workersInvocationsAdaptive(limit: 512, filter: {scriptName: "triggerbase-relay", datetime_geq: $since}) {
        dimensions { httpResponseStatus } sum { requests errors }
      }
      storage: durableObjectsSqlStorageGroups(limit: 1, filter: {namespaceId: $ns, datetime_geq: $since}) {
        max { storedBytes }
      }
    } }
  }`,
    variables: { account, ns: namespace, since },
  }),
  "application/json",
);
if (metrics.errors?.length || metrics.data?.viewer?.accounts?.length !== 1)
  throw Error("Cloudflare returned incomplete relay analytics");
const [data] = metrics.data.viewer.accounts;
const bad = data.requests.filter(
  (r: {
    dimensions: { httpResponseStatus: number };
    sum: { errors: number };
  }) =>
    r.dimensions.httpResponseStatus === 429 ||
    r.dimensions.httpResponseStatus >= 500 ||
    r.sum.errors > 0,
);
const bytes = data.storage[0]?.max.storedBytes;

const queue = await query(
  "accounts/" + account + "/analytics_engine/sql",
  "SELECT max(double1) AS days, max(double2) AS expired FROM triggerbase_queue WHERE timestamp >= NOW() - INTERVAL '25' HOUR FORMAT JSON",
  "text/plain",
);
const [sample] = queue.data;
console.log(
  "Sampled error groups: %d. Storage bytes: %s. Maximum queue age (days): %s. Maximum expirations per sample: %s.",
  bad.length,
  bytes ?? "no sample",
  sample?.days ?? "no sample",
  sample?.expired ?? "no sample",
);
if (
  bad.length ||
  bytes >= 1024 ** 3 ||
  Number(sample?.days) >= 7 ||
  Number(sample?.expired) > 0
)
  throw Error("Production relay exceeded its operating thresholds");
