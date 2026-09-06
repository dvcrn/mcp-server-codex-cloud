import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CodexCloudClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp.js";

test("MCP validates inputs, dispatches scripts, and keeps auth tokens private", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private", refreshToken: "refresh" },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("oauth/token"))
        return Response.json({ access_token: "rotated-private" });
      return Response.json({ id: "env", label: "Dummy", machine_id: "machine" });
    },
  });
  const server = createMcpServer(sdk);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    expect((await client.listTools()).tools).toHaveLength(11);
    const invalid = await client.callTool({
      name: "start_task",
      arguments: { environmentId: "env", prompt: "hi", attempts: 5 },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(0);
    await client.callTool({
      name: "update_environment",
      arguments: {
        id: "env",
        update: {
          setupScript: "echo setup",
          maintenanceScript: "echo maintenance",
          cache: { postSetupCacheEnabled: true },
        },
      },
    });
    expect(requests[0]?.body).toEqual({
      setup: "echo setup",
      maintenance_setup: "echo maintenance",
      cache_settings: { post_setup_cache_enabled: true, cache_invalidation_key: "" },
    });
    const refreshed = await client.callTool({ name: "refresh_auth", arguments: {} });
    expect(JSON.stringify(refreshed)).not.toContain("private");
    expect(refreshed.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
