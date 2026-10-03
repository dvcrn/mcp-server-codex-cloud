import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";
import type { RpcNotification } from "../src/cloud-types.js";
import { FakeSocket } from "./fake-socket.js";

function setup() {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (
      request.method === "thread/start"
      || request.method === "thread/resume"
    ) {
      current.reply(request, {
        thread: { id: "thread", status: { type: "idle" } },
      });
    }
    if (request.method === "turn/start") {
      current.reply(request, {
        turn: { id: "turn", status: "inProgress", items: [] },
      });
    }
    if (request.method === "turn/steer") {
      current.reply(request, { turnId: "turn" });
    }
    if (
      request.method === "turn/interrupt"
      || request.method === "thread/name/set"
    ) {
      current.reply(request, {});
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) =>
      Response.json(
        String(url).includes("environment-configs")
          ? { name: "Example" }
          : {
              thread: {
                id: "thread",
                name: "Environment setup: Example",
                preview: "setup",
                status: { type: "active" },
              },
            },
      ),
    socketFactory: async () => socket,
  });
  return { socket, client };
}

test("new task selects the config and starts input on the returned thread", async () => {
  const { client, socket } = setup();
  try {
    const task = await client.tasks.create({
      environmentConfigId: "config",
      prompt: "hello",
    });
    expect(task.thread.id).toBe("thread");
    expect(task.turn.id).toBe("turn");
    expect(
      socket.sent.find((x) => x.method === "thread/start")?.params,
    ).toEqual({
      environments: [{ environmentConfigId: "config" }],
      deferredEnvironment: true,
      pluginsMcp: { productSku: "codex" },
    });
    expect(socket.sent.find((x) => x.method === "turn/start")?.params).toEqual({
      threadId: "thread",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    await expect(
      client.tasks.create({ environmentConfigId: "config", prompt: " " }),
    ).rejects.toThrow("empty");
    expect(socket.sent.filter((x) => x.method === "thread/start")).toHaveLength(
      1,
    );
  } finally {
    client.close();
  }
});

test("follow up resumes its existing thread before starting a new turn", async () => {
  const { client, socket } = setup();
  try {
    await client.tasks.followUp({
      threadId: "thread",
      prompt: "again",
      model: "model",
      effort: "high",
    });
    expect(socket.sent.map((x) => x.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
    expect(
      socket.sent.find((x) => x.method === "thread/resume")?.params,
    ).toEqual({ threadId: "thread", excludeTurns: true });
    expect(socket.sent.at(-1)?.params).toMatchObject({
      threadId: "thread",
      model: "model",
      effort: "high",
    });
  } finally {
    client.close();
  }
});

test("steering and interruption target the specified thread and turn", async () => {
  const { client, socket } = setup();
  try {
    await client.tasks.steer({
      threadId: "thread",
      expectedTurnId: "turn",
      prompt: "adjust",
    });
    const cancelled = await client.tasks.cancel("thread", "turn");
    expect(cancelled).toEqual({
      threadId: "thread",
      turnId: "turn",
      interruptRequested: true,
    });
    expect(
      socket.sent.find((x) => x.method === "turn/steer")?.params,
    ).toMatchObject({ threadId: "thread", expectedTurnId: "turn" });
    expect(
      socket.sent.find((x) => x.method === "turn/interrupt")?.params,
    ).toEqual({ threadId: "thread", turnId: "turn" });
  } finally {
    client.close();
  }
});

test("live subscriptions ignore other threads and unsubscribe cleanly", async () => {
  const { client, socket } = setup();
  const events: RpcNotification[] = [];
  try {
    const unsubscribe = client.tasks.subscribe("thread", (event) =>
      events.push(event),
    );
    await client.tasks.resume("thread");
    socket.emit({
      method: "turn/completed",
      params: { threadId: "other", turn: { id: "turn", status: "completed" } },
    });
    socket.emit({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
    expect(events).toHaveLength(1);
    unsubscribe();
    socket.emit({ method: "turn/completed", params: { threadId: "thread" } });
    expect(events).toHaveLength(1);
  } finally {
    client.close();
  }
});

test("wait uses exact turn identity, paginates, and returns persisted output", async () => {
  let targetPolls = 0;
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/v2/threads/thread/turns");
      expect(parsed.searchParams.get("itemsView")).toBe("full");
      if (!parsed.searchParams.get("cursor")) {
        return Response.json({
          data: [{ id: "other", status: "completed", items: [] }],
          nextCursor: "next",
        });
      }
      return Response.json({
        data: [
          {
            id: "target",
            status: ++targetPolls === 1 ? "inProgress" : "completed",
            items: [{ id: "message", type: "agentMessage", text: "answer" }],
          },
        ],
      });
    },
  });
  const result = await client.tasks.waitFor("thread", "target", {
    intervalMs: 1,
    timeoutMs: 1000,
  });
  expect(result.status).toBe("completed");
  expect(result.items[0]?.text).toBe("answer");
  expect(targetPolls).toBe(2);
});

test("wait timeout settles a transport ignoring cancellation", async () => {
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: () => new Promise(() => {}),
  });
  await expect(
    client.tasks.waitFor("thread", "turn", { timeoutMs: 20 }),
  ).rejects.toThrow();
});

test("allocation failure retains created thread ID and never silently creates another", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/start") {
      current.reply(request, { thread: { id: "created-thread" } });
    }
    if (request.method === "turn/start") {
      current.close();
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    socketFactory: async () => socket,
  });
  try {
    await expect(
      client.tasks.create({ environmentConfigId: "config", prompt: "hello" }),
    ).rejects.toThrow("Thread created-thread was created");
    expect(socket.sent.filter((x) => x.method === "thread/start")).toHaveLength(
      1,
    );
  } finally {
    client.close();
  }
});

test("follow-up rejects an active thread before sending more input", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/resume") {
      current.reply(request, {
        thread: { id: "thread", status: { type: "active" } },
      });
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    socketFactory: async () => socket,
  });
  try {
    await expect(
      client.tasks.followUp({ threadId: "thread", prompt: "more" }),
    ).rejects.toThrow("active turn");
    expect(socket.sent.some((x) => x.method === "turn/start")).toBe(false);
  } finally {
    client.close();
  }
});

test("environment setup selects durable onboarding and invokes the setup skill", async () => {
  const { client, socket } = setup();
  try {
    const task = await client.tasks.setupEnvironment({
      environmentConfigId: "config",
    });
    expect(task.thread.name).toBe("Environment setup: Example");
    expect(
      socket.sent.find((x) => x.method === "thread/name/set")?.params,
    ).toEqual({ threadId: "thread", name: "Environment setup: Example" });
    expect(task.thread.id).toBe("thread");
    expect(task.turn.id).toBe("turn");
    expect(
      socket.sent.find((x) => x.method === "thread/start")?.params,
    ).toEqual({
      environments: [{ onboardingConfigId: "config" }],
      serviceName: "codex_cloud",
      threadSource: "user",
      deferredEnvironment: true,
      pluginsMcp: { productSku: "codex" },
    });
    expect(socket.sent.find((x) => x.method === "turn/start")?.params).toEqual({
      threadId: "thread",
      input: [
        {
          type: "text",
          text: "Use $cloud-environment-onboarding:setup to set up this cloud environment",
          text_elements: [],
        },
      ],
    });
  } finally {
    client.close();
  }
});

test("rename rejects empty names before resuming and persists through the naming RPC", async () => {
  const { client, socket } = setup();
  try {
    await expect(client.tasks.rename("thread", " ")).rejects.toThrow("empty");
    expect(socket.sent).toHaveLength(0);
    await client.tasks.rename("thread", "Custom title");
    expect(socket.sent.map((x) => x.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/name/set",
    ]);
    expect(socket.sent.at(-1)?.params).toEqual({
      threadId: "thread",
      name: "Custom title",
    });
  } finally {
    client.close();
  }
});
