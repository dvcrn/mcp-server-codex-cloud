import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";
import type { CloudEnvironment } from "../src/environments.js";
import { FakeSocket } from "./fake-socket.js";

function editorFixture(
  options: {
    owner?: boolean;
    active?: boolean;
    lostSave?: boolean;
    concurrentDraft?: boolean;
    lostStart?: boolean;
  } = {},
) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  let config: CloudEnvironment = {
    id: "config",
    name: "Example",
    version_id: "published-version",
    version_revision: 8,
    repositories: [{ repository_id: "github-123", ref: "main" }],
    install_script: "bun install",
    network_policy: {
      type: "restricted",
      presets: ["package_managers"],
      egress_rules: [],
    },
    secrets: [],
    ...(options.owner
      ? { thread_id: "editing-thread", environment_id: "editing-runtime" }
      : {}),
  };
  const thread = {
    id: "editing-thread",
    status: { type: options.active ? "active" : "idle" },
    environments: [
      {
        environmentId: "editing-runtime",
        environmentConfigId: "config",
        cwd: "/workspace",
      },
    ],
  };
  let configReads = 0;
  const socket = new FakeSocket((request, current) => {
    if (request.method === "thread/start") {
      config = {
        ...config,
        thread_id: thread.id,
        environment_id: "editing-runtime",
      };
      if (options.lostStart) {
        current.emit({
          id: request.id,
          error: { code: -32603, message: "Allocation response lost" },
        });
        return;
      }
      current.reply(request, { thread });
    } else if (request.method === "thread/resume") {
      current.reply(request, { thread });
    } else if (request.method === "turn/start") {
      current.reply(request, {
        turn: { id: "turn", status: "inProgress", items: [] },
      });
    } else {
      current.reply(request, {});
    }
  });
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (path.includes("/threads/")) {
        return Response.json({ thread });
      }
      if (method === "PATCH") {
        config = {
          ...config,
          draft: {
            id: "config-draft",
            base_version_id: config.version_id,
            revision: 1,
            repositories: config.repositories,
            install_script: config.install_script ?? "",
            network_policy: config.network_policy ?? { type: "unrestricted" },
          },
        };
        if (options.lostSave) {
          throw new Error("Draft response lost");
        }
      } else if (++configReads === 2 && options.concurrentDraft) {
        config = {
          ...config,
          draft: {
            id: "concurrent-draft",
            base_version_id: config.version_id,
            revision: 2,
            repositories: config.repositories,
            install_script: "preserve concurrent edits",
            network_policy: { type: "unrestricted" },
          },
        };
      }
      return Response.json(config);
    },
    socketFactory: async () => socket,
  });
  return { client, requests, socket };
}

for (const owner of [false, true]) {
  test(`native draft ${owner ? "reuses its config-owning thread" : "allocates a durable config-owning thread"} without an agent turn`, async () => {
    const { client, requests, socket } = editorFixture({ owner });
    try {
      expect(await client.environments.openDraft("config")).toEqual({
        draft_id: "config-draft",
        thread_id: "editing-thread",
        environment_id: "editing-runtime",
        draft_scope: "config",
      });
      expect(requests.filter((r) => r.method === "PATCH")).toEqual([
        {
          path: "/v1/environment-configs/config/draft",
          method: "PATCH",
          body: {
            base_version_id: "published-version",
            repositories: [{ repository_id: "github-123", ref: "main" }],
          },
        },
      ]);
      expect(requests.some((r) => r.path.endsWith("/drafts"))).toBe(false);
      expect(socket.sent.some((r) => r.method === "turn/start")).toBe(false);
      if (owner) {
        expect(socket.sent.some((r) => r.method === "thread/start")).toBe(
          false,
        );
      } else {
        expect(
          socket.sent.find((r) => r.method === "thread/start")?.params,
        ).toEqual({
          environments: [{ onboardingConfigId: "config" }],
          serviceName: "codex_cloud",
          threadSource: "user",
          deferredEnvironment: true,
          pluginsMcp: { productSku: "codex" },
        });
      }
      expect(
        (await client.environments.get("config")).draft?.install_script,
      ).toBe("bun install");
      const task = await client.tasks.followUp({
        threadId: "editing-thread",
        prompt: "Read this draft",
      });
      expect(task.thread.environments?.[0]?.environmentId).toBe(
        "editing-runtime",
      );
      expect(
        socket.sent.find((r) => r.method === "turn/start")?.params,
      ).toMatchObject({
        threadId: "editing-thread",
        input: [{ type: "text", text: "Read this draft", text_elements: [] }],
      });
    } finally {
      client.close();
    }
  });
}

for (const lost of ["lostStart", "lostSave"] as const) {
  test(`retry after ${lost} retains the server editor association`, async () => {
    const { client, requests, socket } = editorFixture({ [lost]: true });
    try {
      await expect(client.environments.openDraft("config")).rejects.toThrow(
        "not confirmed",
      );
      const result = await client.environments.openDraft("config");
      expect(result.thread_id).toBe("editing-thread");
      expect(result.draft_id).toBe("config-draft");
      expect(
        socket.sent.filter((r) => r.method === "thread/start"),
      ).toHaveLength(1);
      expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    } finally {
      client.close();
    }
  });
}

test("opening an editor preserves a draft created during thread initialization", async () => {
  const { client, requests } = editorFixture({ concurrentDraft: true });
  try {
    expect((await client.environments.openDraft("config")).draft_id).toBe(
      "concurrent-draft",
    );
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(
      (await client.environments.get("config")).draft?.install_script,
    ).toBe("preserve concurrent edits");
  } finally {
    client.close();
  }
});

test("an active owning thread cannot allocate a new config draft", async () => {
  const { client, requests, socket } = editorFixture({
    owner: true,
    active: true,
  });
  try {
    await expect(client.environments.openDraft("config")).rejects.toThrow(
      "not confirmed",
    );
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(socket.sent).toHaveLength(0);
  } finally {
    client.close();
  }
});

test("a stale config draft is preserved for reconciliation", async () => {
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async () =>
      Response.json({
        id: "config",
        version_id: "new-version",
        draft: { id: "stale-draft", base_version_id: "old-version" },
      }),
  });
  try {
    await expect(client.environments.openDraft("config")).rejects.toThrow(
      "older published version",
    );
  } finally {
    client.close();
  }
});

test("an explicit draft stays readable when the published config has no draft", async () => {
  const requests: string[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      return Response.json({
        id: "config",
        version_revision: 8,
        environment_id: "editing-runtime",
        draft: path.endsWith("/drafts/explicit-draft")
          ? { id: "explicit-draft", revision: 1, base_version_id: "base" }
          : null,
      });
    },
  });

  expect((await client.environments.get("config")).draft).toBeNull();
  const editing = await client.environments.getDraft(
    "config",
    "explicit-draft",
  );
  expect(editing.draft?.id).toBe("explicit-draft");
  expect(editing.environment_id).toBe("editing-runtime");
  expect(requests).toHaveLength(2);
  client.close();
});

test("explicit draft updates preserve the editing-session path and revision guard", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({
        id: "config",
        environment_id: "editing-runtime",
        draft: {
          id: "explicit-draft",
          revision: init?.method === "PATCH" ? 2 : 1,
          base_version_id: "base",
        },
      });
    },
  });

  const saved = await client.environments.updateDraft(
    "config",
    "explicit-draft",
    {
      base_version_id: "base",
      expected_revision: 1,
      install_script: "echo changed",
    },
  );
  expect(saved.draft?.revision).toBe(2);
  expect(requests).toEqual([
    {
      path: "/v1/environment-configs/config/drafts/explicit-draft",
      method: "GET",
      body: null,
    },
    {
      path: "/v1/environment-configs/config/drafts/explicit-draft",
      method: "PATCH",
      body: {
        base_version_id: "base",
        expected_revision: 1,
        install_script: "echo changed",
      },
    },
  ]);
  client.close();
});
