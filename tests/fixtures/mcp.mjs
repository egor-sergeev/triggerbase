import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const result =
    method === "initialize"
      ? {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "triggerbase-fixture", version: "1.0.0" },
        }
      : method === "tools/list"
        ? {
            tools: [
              {
                name: "ping",
                description: "Return a test marker",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
          }
        : method === "tools/call"
          ? {
              content: [
                { type: "text", text: "pong-from-triggerbase-fixture" },
              ],
            }
          : {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
