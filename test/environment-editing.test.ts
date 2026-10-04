import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";
import { FakeSocket } from "./fake-socket.js";

for (const pending of [false, true]) {
  test(`published environment creates fresh editing chats with pending config draft=${pending}`, async () => {
    const config = {
      id: "config",
      name: "Example",
      version_revision: 8,
      version_id: "published",
      repositories: [],
      thread_id: "archived-owner",
      environment_id: "old-runtime",
      draft: pending
        ? {
            id: "pending-config-draft",
            base_version_id: "older",
            revision: 2,
            repositories: [],
            network_policy: { type: "unrestricted" as const },
            install_script: "preserve unsaved work",
          }
        : null,
    };
    const requests: { path: string; method: string; body: unknown }[] = [];
    let allocated = 0;
    const socket = new FakeSocket((request, current) =>
      current.reply(request, {}),
    );
    const client = new CodexCloudClient({
      tokens: { accessToken: "access" },
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const method = init?.method ?? "GET";
        requests.push({
          path,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (path.endsWith("/drafts") && method === "POST") {
          allocated++;
          return Response.json({
            draft_id: `draft-${allocated}`,
            thread_id: `thread-${allocated}`,
            environment_id: `runtime-${allocated}`,
          });
        }
        if (path.includes("/threads/")) {
          return Response.json({
            thread: { id: path.split("/").at(-1), status: { type: "idle" } },
          });
        }
        return Response.json(config);
      },
      socketFactory: async () => socket,
    });
    try {
      for (let i = 1; i <= 2; i++) {
        expect(await client.environments.openDraft("config")).toEqual({
          draft_id: `draft-${i}`,
          thread_id: `thread-${i}`,
          environment_id: `runtime-${i}`,
          draft_scope: "editing_session",
        });
      }
      expect(requests.filter((r) => r.method === "POST")).toEqual(
        new Array(2).fill({
          path: "/v1/environment-configs/config/drafts",
          method: "POST",
          body: { start_thread: true },
        }),
      );
      expect(
        requests.some(
          (r) => r.path.includes("archived-owner") || r.method === "PATCH",
        ),
      ).toBe(false);
      expect(
        socket.sent
          .filter((r) => r.method === "thread/name/set")
          .map((r) => r.params),
      ).toEqual([
        { threadId: "thread-1", name: "Edit Example" },
        { threadId: "thread-2", name: "Edit Example" },
      ]);
      expect(
        socket.sent.some(
          (r) =>
            r.method === "thread/start"
            || r.method === "turn/start"
            || r.method === "thread/resume",
        ),
      ).toBe(false);
      expect(JSON.stringify(await client.environments.get("config"))).toBe(
        JSON.stringify(config),
      );
    } finally {
      client.close();
    }
  });
}

for (const response of [
  null,
  { draft_id: "draft", environment_id: "runtime", thread_id: null },
]) {
  test(`allocation failure is not retried or replaced by owner reuse: ${JSON.stringify(response)}`, async () => {
    let allocations = 0;
    const client = new CodexCloudClient({
      tokens: { accessToken: "access" },
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          allocations++;
          if (response === null) {
            throw new Error("Response lost");
          }
          return Response.json(response);
        }
        return Response.json({
          id: "config",
          name: "Example",
          version_revision: 3,
          thread_id: "old-thread",
        });
      },
    });
    try {
      await expect(client.environments.openDraft("config")).rejects.toThrow(
        "not confirmed",
      );
      expect(allocations).toBe(1);
    } finally {
      client.close();
    }
  });
}

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
