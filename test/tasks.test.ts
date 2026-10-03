import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";
import type { RpcNotification } from "../src/cloud-types.js";
import { FakeSocket } from "./fake-socket.js";

function setup() {
  let name: string | null = null;
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
    if (request.method === "thread/name/set") {
      name = String(request.params?.name);
      current.reply(request, {});
    }
    if (request.method === "turn/interrupt") {
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
                name,
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
      serviceName: "codex_cloud",
      threadSource: "user",
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

test("rename rejects empty names and names stored threads without resuming", async () => {
  const { client, socket } = setup();
  try {
    await expect(client.tasks.rename("thread", " ")).rejects.toThrow("empty");
    expect(socket.sent).toHaveLength(0);
    const renamed = await client.tasks.rename("thread", "Custom title");
    expect(renamed.name).toBe("Custom title");
    expect(socket.sent.map((x) => x.method)).toEqual([
      "initialize",
      "initialized",
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

for (const outcome of [
  "success",
  "rejected",
  "disconnected",
  "aborted",
] as const) {
  test(`setup keeps its started turn when naming is ${outcome} and never fetches post-turn metadata`, async () => {
    const controller = new AbortController();
    const socket = new FakeSocket((request, current) => {
      if (request.method === "initialize") {
        current.reply(request, {});
      }
      if (request.method === "thread/start") {
        current.reply(request, {
          thread: { id: "thread", name: null, status: { type: "idle" } },
        });
      }
      if (request.method === "turn/start") {
        current.reply(request, {
          turn: { id: "turn", status: "inProgress", items: [] },
        });
        if (outcome === "aborted") {
          controller.abort();
        }
      }
      if (request.method === "thread/name/set") {
        if (outcome === "rejected") {
          current.emit({
            id: request.id,
            error: { code: -32601, message: "Unsupported naming" },
          });
        } else if (outcome === "disconnected") {
          current.close();
        } else {
          current.reply(request, {});
        }
      }
    });
    let fetches = 0;
    const client = new CodexCloudClient({
      tokens: { accessToken: "access" },
      fetch: async () => {
        fetches++;
        throw new Error("HTTP unavailable");
      },
      socketFactory: async () => socket,
    });
    try {
      const task = await client.tasks.setupEnvironment(
        { environmentConfigId: "config", name: "Custom setup" },
        { signal: controller.signal },
      );
      expect(fetches).toBe(0);
      expect(task.turn.id).toBe("turn");
      expect(task.thread.id).toBe("thread");
      expect(task.thread.name).toBe(
        outcome === "success" ? "Custom setup" : null,
      );
      const methods = socket.sent.map((x) => x.method);
      if (outcome !== "aborted") {
        expect(methods.indexOf("turn/start")).toBeLessThan(
          methods.indexOf("thread/name/set"),
        );
      }
    } finally {
      client.close();
    }
  });
}

test("rename reads metadata once and does not require a loadable environment or post-rename GET", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/resume") {
      current.emit({
        id: request.id,
        error: { code: -32004, message: "Environment expired" },
      });
    }
    if (request.method === "thread/name/set") {
      current.reply(request, {});
    }
  });
  let reads = 0;
  const thread = {
    id: "thread",
    name: "Old",
    status: { type: "idle" },
    preview: "Retained preview",
  };
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async () => {
      if (++reads > 1) {
        throw new Error("Post-rename GET unavailable");
      }
      return Response.json({ thread });
    },
    socketFactory: async () => socket,
  });
  try {
    expect(await client.tasks.rename("thread", "New")).toEqual({
      ...thread,
      name: "New",
    });
    expect(reads).toBe(1);
    expect(socket.sent.some((x) => x.method === "thread/resume")).toBe(false);
  } finally {
    client.close();
  }
});

test("archive targets a stored idle thread without resuming its environment", async () => {
  const reads: string[] = [];
  const socket = new FakeSocket((request, current) => {
    if (
      request.method === "initialize"
      || request.method === "thread/archive"
    ) {
      current.reply(request, {});
    } else if (request.method !== "initialized") {
      throw new Error(`Unexpected method: ${request.method}`);
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) => {
      reads.push(String(url));
      return Response.json({
        thread: { id: "thread", status: { type: "idle" } },
      });
    },
    socketFactory: async () => socket,
  });
  try {
    expect(await client.tasks.archive("thread")).toEqual({
      threadId: "thread",
      archived: true,
    });
    expect(reads).toEqual([
      "https://codex-cloud-backend.chatgpt.com/v1/threads/thread",
    ]);
    expect(
      socket.sent.filter((request) => request.method !== "initialize"),
    ).toEqual([
      { method: "initialized" },
      { id: 2, method: "thread/archive", params: { threadId: "thread" } },
    ]);
  } finally {
    client.close();
  }
});

test("archive rejects an active thread before opening the cloud socket", async () => {
  let opened = false;
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async () =>
      Response.json({ thread: { id: "thread", status: { type: "active" } } }),
    socketFactory: async () => {
      opened = true;
      throw new Error("Unexpected socket connection");
    },
  });
  try {
    await expect(client.tasks.archive("thread")).rejects.toThrow("active turn");
    expect(opened).toBe(false);
  } finally {
    client.close();
  }
});

test("restore returns backend metadata without explicitly resuming a thread", async () => {
  const restored = { id: "thread", name: "Restored", status: { type: "idle" } };
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/unarchive") {
      current.reply(request, { thread: restored });
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    socketFactory: async () => socket,
    fetch: async () => {
      throw new Error("Unexpected HTTP request");
    },
  });
  try {
    await expect(client.tasks.restore(" ")).rejects.toThrow(
      "must not be empty",
    );
    expect(socket.sent).toEqual([]);
    expect(await client.tasks.restore("thread")).toEqual(restored);
    expect(
      socket.sent.filter(
        (request) =>
          request.method !== "initialize" && request.method !== "initialized",
      ),
    ).toEqual([
      { id: 2, method: "thread/unarchive", params: { threadId: "thread" } },
    ]);
  } finally {
    client.close();
  }
});

test("restore rejects a response for another thread", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "thread/unarchive") {
      current.reply(request, { thread: { id: "other" } });
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    socketFactory: async () => socket,
  });
  try {
    await expect(client.tasks.restore("thread")).rejects.toThrow(
      "unexpected thread ID",
    );
  } finally {
    client.close();
  }
});
