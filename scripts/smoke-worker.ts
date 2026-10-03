import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const base = process.env.CODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const token =
  process.env.ADMIN_TOKEN ?? "local-test-token-not-a-production-secret-12345";
const endpoint = new URL("/mcp", base);
for (const path of ["/mcp", "/admin/status", "/admin/tokens"]) {
  assert.equal((await fetch(new URL(path, base))).status, 401);
}
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
assert.equal(
  (
    await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, origin: "https://untrusted.example" },
      body: "{}",
    })
  ).status,
  403,
);
assert.equal(
  (
    await fetch(new URL("/admin/tokens", base), {
      method: "POST",
      headers,
      body: "{}",
    })
  ).status,
  400,
);
assert.equal(
  (
    await fetch(endpoint, {
      method: "POST",
      headers,
      body: "x".repeat(1048577),
    })
  ).status,
  413,
);
const client = new Client({ name: "worker-smoke", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
try {
  const tools = await client.listTools();
  assert(tools.tools.length >= 25);
  for (const name of [
    "follow_up_task",
    "list_task_turns",
    "list_task_items",
    "rename_task",
  ]) {
    assert(tools.tools.some((tool) => tool.name === name));
  }
  console.log(
    "Worker auth, origin, input limits, MCP connection and cloud tools verified",
  );
} finally {
  await client.close();
}
