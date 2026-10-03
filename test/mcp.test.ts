import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CodexCloudClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp.js";
import { FakeSocket } from "./fake-socket.js";

async function connect(sdk: CodexCloudClient) {
  const server = createMcpServer(sdk);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      sdk.close();
      await client.close();
      await server.close();
    },
  };
}

test("MCP exposes config publication and thread tools with new input contracts", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private", refreshToken: "refresh" },
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        String(url).includes("oauth/token")
          ? { access_token: "rotated-private" }
          : { id: "config" },
      );
    },
  });
  const { client, close } = await connect(sdk);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of [
      "create_environment",
      "update_environment_draft",
      "begin_environment_publish",
      "complete_environment_publish",
      "start_task",
      "rename_task",
      "restore_task",
      "follow_up_task",
      "steer_task",
      "cancel_task",
      "list_task_items",
      "wait_for_task",
    ]) {
      expect(tools.some((tool) => tool.name === name)).toBe(true);
    }
    expect(tools.some((tool) => tool.name === "test_environment")).toBe(false);
    const invalid = await client.callTool({
      name: "create_environment",
      arguments: {
        name: "test",
        repositories: [{ repository_id: 123, ref: "main" }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const updated = await client.callTool({
      name: "update_environment_draft",
      arguments: {
        id: "config",
        draftId: "draft",
        update: {
          base_version_id: "version",
          expected_revision: 1,
          install_script: "echo ready",
          start_skill: "Instructions",
        },
      },
    });
    expect(updated.isError).not.toBe(true);
    expect(requests[0]?.url).toEndWith(
      "/v1/environment-configs/config/drafts/draft",
    );
    expect(requests[1]?.body).toEqual({
      base_version_id: "version",
      expected_revision: 1,
      install_script: "echo ready",
      start_skill: "Instructions",
    });
    const refreshed = await client.callTool({
      name: "refresh_auth",
      arguments: {},
    });
    expect(JSON.stringify(refreshed)).not.toContain("private");
    expect(refreshed.isError).not.toBe(true);
  } finally {
    await close();
  }
});

test("MCP cannot complete a pending publication", async () => {
  let completed = false;
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private" },
    fetch: async (url) => {
      if (String(url).endsWith("/complete")) {
        completed = true;
      }
      return Response.json({ id: "operation", state: "RUNNING" });
    },
  });
  const { client, close } = await connect(sdk);
  try {
    const result = await client.callTool({
      name: "complete_environment_publish",
      arguments: {
        id: "config",
        draftId: "draft",
        operationId: "operation",
        threadId: "thread",
      },
    });
    expect(result.isError).toBe(true);
    expect(completed).toBe(false);
  } finally {
    await close();
  }
});

test("MCP follow-up sends text through the socket and redacts RPC error details", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/resume") {
      current.reply(request, { thread: { id: "thread" } });
    }
    if (request.method === "turn/start") {
      current.emit({
        id: request.id,
        error: { code: -32600, message: "private secret echo" },
      });
    }
  });
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private" },
    socketFactory: async () => socket,
  });
  const { client, close } = await connect(sdk);
  try {
    const result = await client.callTool({
      name: "follow_up_task",
      arguments: { threadId: "thread", prompt: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(socket.sent.at(-1)?.method).toBe("turn/start");
  } finally {
    await close();
  }
});

test("vault tools validate creation and preserve omitted values without exposing responses", async () => {
  const requests: unknown[] = [];
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private" },
    fetch: async (url, init) => {
      if (init?.method === "GET") {
        return Response.json({ id: "config" });
      }
      requests.push(JSON.parse(String(init?.body)));
      const entry = {
        id: "entry",
        name: "KEY",
        value: "echoed-upstream-secret",
      };
      return Response.json(
        String(url).includes("personal-secrets") ? { secrets: [entry] } : entry,
      );
    },
  });
  const { client, close } = await connect(sdk);
  try {
    const target = { type: "environment_config_ids", ids: ["config"] };
    const invalid = await client.callTool({
      name: "save_personal_secrets",
      arguments: {
        namespace: "sensitive",
        secrets: [{ name: "KEY", env_var: "KEY", target }],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const saved = await client.callTool({
      name: "save_personal_secrets",
      arguments: {
        namespace: "sensitive",
        secrets: [{ id: "entry", name: "KEY", env_var: "RENAMED", target }],
      },
    });
    expect(saved.isError).not.toBe(true);
    expect(requests[0]).toEqual({
      namespace: "sensitive",
      secrets: [{ id: "entry", name: "KEY", env_var: "RENAMED", target }],
    });
    expect(JSON.stringify(saved)).not.toContain("echoed-upstream-secret");
    const shared = await client.callTool({
      name: "create_environment_value",
      arguments: { namespace: "proxy", name: "KEY", value: "dummy-input" },
    });
    expect(shared.isError).not.toBe(true);
    expect(JSON.stringify(shared)).not.toContain("echoed-upstream-secret");
    expect(JSON.stringify(shared)).not.toContain("dummy-input");
    const attached = await client.callTool({
      name: "update_environment_draft",
      arguments: {
        id: "config",
        draftId: "draft",
        update: {
          base_version_id: "base",
          expected_revision: 3,
          runtime_requirements: [
            {
              source: { type: "user_provided" },
              optional: true,
              delivery: {
                type: "direct_environment_variable",
                variable_name: "KEY",
              },
            },
          ],
          secrets: [
            {
              id: "shared",
              name: "NETWORK",
              source: "environment",
              optional: false,
              target: {
                environment_variable: "NETWORK",
                allowed_domains: ["example.com"],
              },
            },
            {
              name: "PERSONAL",
              source: "user_provided",
              optional: true,
              target: {
                environment_variable: "PERSONAL",
                allowed_domains: [],
              },
            },
          ],
        },
      },
    });
    expect(attached.isError).not.toBe(true);
    expect(requests[2]).toMatchObject({
      secrets: [
        { id: "shared", source: "environment", optional: false },
        { source: "user_provided", optional: true },
      ],
    });
  } finally {
    await close();
  }
});

test("setup allocation rejection supplies recovery guidance without leaking backend details", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/start") {
      current.emit({
        id: request.id,
        error: { code: -32004, message: "private backend reason" },
      });
    }
  });
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async () => Response.json({ name: "Example" }),
    socketFactory: async () => socket,
  });
  const { client, close } = await connect(sdk);
  try {
    const result = await client.callTool({
      name: "start_environment_setup",
      arguments: { environmentConfigId: "config" },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("rejected setup thread allocation");
    expect(text).toContain("follow_up_task");
    expect(text).not.toContain("private backend reason");
    expect(
      socket.sent.some(
        (x) => x.method === "thread/name/set" || x.method === "turn/start",
      ),
    ).toBe(false);
    expect(socket.sent.filter((x) => x.method === "thread/start")).toHaveLength(
      1,
    );
  } finally {
    await close();
  }
});

test("MCP personal vault deletion validates inputs, declares mutation, and returns only deleted references", async () => {
  const methods: string[] = [];
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private" },
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({
        secrets: [{ id: "entry", name: "KEY", value: "upstream-value" }],
        value: "upstream-value",
      });
    },
  });
  const { client, close } = await connect(sdk);
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(({ name }) => name === "delete_personal_secrets");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
    for (const arguments_ of [
      { namespace: "sensitive", ids: [] },
      { namespace: "sensitive", ids: [" "] },
      { namespace: "runtime", ids: ["entry"] },
      { namespace: "sensitive", ids: new Array(101).fill("entry") },
      { namespace: "sensitive", ids: ["entry"], value: "unexpected" },
    ]) {
      const result = await client.callTool({
        name: "delete_personal_secrets",
        arguments: arguments_,
      });
      expect(result.isError).toBe(true);
    }
    expect(methods).toEqual([]);

    const result = await client.callTool({
      name: "delete_personal_secrets",
      arguments: { namespace: "sensitive", ids: ["entry"] },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: '{"deleted":[{"id":"entry","name":"KEY"}]}' },
    ]);
    expect(methods).toEqual(["GET", "DELETE"]);
  } finally {
    await close();
  }
});

test("MCP archive validates IDs and reports only acknowledged mutations", async () => {
  let rejectArchive = false;
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    } else if (request.method === "thread/archive") {
      if (rejectArchive) {
        current.emit({
          id: request.id,
          error: { code: -32000, message: "private backend details" },
        });
      } else {
        current.reply(request, {});
      }
    }
  });
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "private" },
    fetch: async () =>
      Response.json({ thread: { id: "thread", status: { type: "idle" } } }),
    socketFactory: async () => socket,
  });
  const { client, close } = await connect(sdk);
  try {
    const tool = (await client.listTools()).tools.find(
      ({ name }) => name === "archive_task",
    );
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(
      (
        await client.callTool({
          name: "archive_task",
          arguments: { threadId: " " },
        })
      ).isError,
    ).toBe(true);
    expect(socket.sent).toEqual([]);
    const success = await client.callTool({
      name: "archive_task",
      arguments: { threadId: "thread" },
    });
    expect(success.isError).not.toBe(true);
    expect(success.content).toEqual([
      { type: "text", text: '{"threadId":"thread","archived":true}' },
    ]);
    rejectArchive = true;
    const failure = await client.callTool({
      name: "archive_task",
      arguments: { threadId: "thread" },
    });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("archived");
    expect(JSON.stringify(failure)).not.toContain("private");
  } finally {
    await close();
  }
});

for (const completionStatus of [200, 500]) {
  test(`MCP onboarding completion without threadId handles HTTP ${completionStatus}`, async () => {
    const writes: unknown[] = [];
    const sdk = new CodexCloudClient({
      tokens: { accessToken: "private" },
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.includes("environment-operations")) {
          return Response.json({ id: "operation", state: "SUCCEEDED" });
        }
        if (path.includes("/drafts/")) {
          return Response.json({}, { status: 404 });
        }
        if (path.endsWith("/draft/approve/complete")) {
          writes.push(JSON.parse(String(init?.body)));
          return Response.json(
            { error: "private-backend-detail" },
            { status: completionStatus },
          );
        }
        return Response.json({
          id: "config",
          thread_id: "owner",
          draft: { id: "draft" },
          version_id: "published",
        });
      },
    });
    const { client, close } = await connect(sdk);
    try {
      const result = await client.callTool({
        name: "complete_environment_publish",
        arguments: { id: "config", draftId: "draft", operationId: "operation" },
      });
      expect(writes).toEqual([{ operation_id: "operation" }]);
      const text = JSON.stringify(result.content);
      expect(text).not.toContain("private-backend-detail");
      if (completionStatus === 500) {
        expect(result.isError).toBe(true);
        expect(text).toContain("operation operation");
        expect(text).toContain("may already be published");
      } else {
        expect(result.isError).not.toBe(true);
        expect(text).toContain("published");
      }
    } finally {
      await close();
    }
  });
}
