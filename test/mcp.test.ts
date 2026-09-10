import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CodexCloudClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp.js";

test("MCP validates inputs, dispatches scripts, and keeps auth tokens private", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private", refreshToken: "refresh" },
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url).includes("oauth/token")) {
        return Response.json({ access_token: "rotated-private" });
      }
      return Response.json({
        id: "env",
        label: "Dummy",
        machine_id: "machine",
      });
    },
  });
  const server = createMcpServer(sdk);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(14);
    const createEnvironment = tools.find(
      (tool) => tool.name === "create_environment",
    );
    expect(createEnvironment?.description).toContain(
      "first look up its numeric ID",
    );
    expect(JSON.stringify(createEnvironment?.inputSchema)).toContain(
      "resolve its numeric ID first using the GitHub API, gh CLI, or another GitHub tool",
    );
    const invalidRepository = await client.callTool({
      name: "create_environment",
      arguments: { label: "test", repositories: [1165432182] },
    });
    expect(invalidRepository.isError).toBe(true);
    expect(JSON.stringify(invalidRepository)).toContain(
      "Repository ID must be a string in github-NUMERIC_ID format, for example github-23123123",
    );
    expect(requests).toHaveLength(0);
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
      cache_settings: {
        post_setup_cache_enabled: true,
        cache_invalidation_key: "",
      },
    });
    const refreshed = await client.callTool({
      name: "refresh_auth",
      arguments: {},
    });
    expect(JSON.stringify(refreshed)).not.toContain("private");
    expect(refreshed.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP dispatches history, logs and follow-ups with safe retry guidance", async () => {
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "test" },
    fetch: async (url, init) => {
      if (String(url).endsWith("/logs")) {
        return Response.json({
          logs: [
            {
              key: {
                name: "setup",
                type: "UserSetupScript",
                created_at: "2026-09-07T00:00:00",
              },
              line: "setup OK",
            },
          ],
        });
      }
      if (String(url).endsWith("/turns")) {
        return Response.json({ current_turn_id: null, turn_mapping: {} });
      }
      const body = JSON.parse(String(init?.body));
      if (body.input_items[0].content[0].text === "lose response") {
        throw new Error("private-upstream-detail");
      }
      return Response.json({
        task: { id: body.follow_up.task_id },
        user_turn: { id: "user" },
        turn: { id: "assistant" },
      });
    },
  });
  const server = createMcpServer(sdk);
  const client = new Client({ name: "history-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    expect(
      tools.find((tool) => tool.name === "follow_up_task")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    for (const name of ["list_task_turns", "get_task_logs"]) {
      expect(
        tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
      ).toBe(true);
    }
    const history = await client.callTool({
      name: "list_task_turns",
      arguments: { taskId: "task" },
    });
    expect(history.isError).not.toBe(true);
    expect(history.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ currentTurnId: null, turns: [] }),
      },
    ]);
    const logs = await client.callTool({
      name: "get_task_logs",
      arguments: { taskId: "task", turnId: "turn" },
    });
    expect(logs.isError).not.toBe(true);
    expect(JSON.stringify(logs)).toContain("setup OK");
    const follow = await client.callTool({
      name: "follow_up_task",
      arguments: { taskId: "task", turnId: "turn", prompt: "hi" },
    });
    expect(follow.isError).not.toBe(true);
    expect(JSON.stringify(follow)).toContain("userTurnId");
    const invalid = await client.callTool({
      name: "follow_up_task",
      arguments: { taskId: "task", turnId: "turn", prompt: " " },
    });
    expect(invalid.isError).toBe(true);
    const lost = await client.callTool({
      name: "follow_up_task",
      arguments: { taskId: "task", turnId: "turn", prompt: "lose response" },
    });
    expect(lost.isError).toBe(true);
    expect(JSON.stringify(lost)).toContain("Check list_task_turns");
    expect(JSON.stringify(lost)).not.toContain("private-upstream-detail");
  } finally {
    await client.close();
    await server.close();
  }
});
