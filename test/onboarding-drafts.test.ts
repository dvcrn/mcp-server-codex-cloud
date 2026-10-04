import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";

const config = {
  id: "config",
  version_id: "base",
  version_revision: 1,
  thread_id: "onboarding-thread",
  environment_id: "onboarding-runtime",
  draft: {
    id: "onboarding-draft",
    base_version_id: "base",
    revision: 1,
    repositories: [],
    network_policy: { type: "unrestricted" as const },
    install_script: "bun install",
    start_skill: "Run the app",
  },
};

function fixture(
  options: {
    explicitStatus?: number;
    config?: unknown;
    completionStatus?: number;
  } = {},
) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      requests.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path.includes("/drafts/")) {
        return Response.json(
          { error: "not an editing-session draft" },
          { status: options.explicitStatus ?? 404 },
        );
      }
      if (path.endsWith("/approve/begin")) {
        return Response.json({ id: "operation", state: "PENDING" });
      }
      if (path.endsWith("/approve/complete") && options.completionStatus) {
        return Response.json(
          { error: "private detail" },
          { status: options.completionStatus },
        );
      }
      return Response.json(options.config ?? config);
    },
  });
  return { client, requests };
}

test("onboarding draft read preserves saved content when explicit lookup is absent", async () => {
  const { client, requests } = fixture();
  const result = await client.environments.getDraft(
    "config",
    "onboarding-draft",
  );
  expect(result.draft).toEqual(config.draft);
  expect(requests.map((r) => r.path)).toEqual([
    "/v1/environment-configs/config/drafts/onboarding-draft",
    "/v1/environment-configs/config",
  ]);
});

test("opening a pending onboarding draft returns its original runtime without allocating", async () => {
  const { client, requests } = fixture();
  expect(await client.environments.openDraft("config")).toEqual({
    draft_id: "onboarding-draft",
    thread_id: "onboarding-thread",
    environment_id: "onboarding-runtime",
    draft_scope: "config",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
});

test("pending draft without runtime metadata is not replaced by an empty draft", async () => {
  const { client, requests } = fixture({
    config: { ...config, thread_id: null },
  });
  await expect(client.environments.openDraft("config")).rejects.toThrow(
    "pending draft",
  );
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test("onboarding publication uses the config draft route and owning thread", async () => {
  const { client, requests } = fixture();
  await client.environments.beginPublish(
    "config",
    "onboarding-draft",
    1,
    "retry-key",
  );
  await client.environments.completePublish(
    "config",
    "onboarding-draft",
    "operation",
    "onboarding-thread",
  );
  expect(requests.filter((r) => r.method === "POST")).toEqual([
    {
      path: "/v1/environment-configs/config/draft/approve/begin",
      method: "POST",
      body: { expected_revision: 1, idempotency_key: "retry-key" },
    },
    {
      path: "/v1/environment-configs/config/draft/approve/complete",
      method: "POST",
      body: { operation_id: "operation" },
    },
  ]);
});

test("onboarding draft updates preserve the revision guard on the singular route", async () => {
  const { client, requests } = fixture();
  const update = {
    base_version_id: "base",
    expected_revision: 1,
    start_skill: "Updated skill",
  };
  await client.environments.updateDraft("config", "onboarding-draft", update);
  expect(requests.at(-1)).toEqual({
    path: "/v1/environment-configs/config/draft",
    method: "PATCH",
    body: update,
  });
});

test("onboarding publication rejects stale revisions and mismatched completion threads", async () => {
  const { client, requests } = fixture();
  await expect(
    client.environments.beginPublish(
      "config",
      "onboarding-draft",
      2,
      "retry-key",
    ),
  ).rejects.toThrow("revision changed");
  await expect(
    client.environments.completePublish(
      "config",
      "onboarding-draft",
      "operation",
      "different-thread",
    ),
  ).rejects.toThrow("config's thread_id");
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});

for (const status of [403, 404, 500]) {
  test(`draft resolution preserves HTTP ${status} instead of selecting a different draft`, async () => {
    const { client, requests } = fixture({
      explicitStatus: status,
      config: { ...config, draft: { ...config.draft, id: "other-draft" } },
    });
    await expect(
      client.environments.beginPublish(
        "config",
        "onboarding-draft",
        1,
        "retry-key",
      ),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests).toHaveLength(status === 404 ? 2 : 1);
  });
}

test("completion failure retains the operation and warns that publication may have committed", async () => {
  const { client, requests } = fixture({ completionStatus: 500 });
  await expect(
    client.environments.completePublish(
      "config",
      "onboarding-draft",
      "operation",
      "onboarding-thread",
    ),
  ).rejects.toThrow(
    "operation operation was not confirmed. The version may already be published",
  );
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

test("config draft completion can omit the thread while editing-session completion requires it", async () => {
  const { client, requests } = fixture();
  await client.environments.completePublish(
    "config",
    "onboarding-draft",
    "operation",
  );
  expect(requests.at(-1)?.body).toEqual({ operation_id: "operation" });
  const explicit = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (_url, init) => {
      expect(init?.method).toBe("GET");
      return Response.json(config);
    },
  });
  await expect(
    explicit.environments.completePublish(
      "config",
      "editing-draft",
      "operation",
    ),
  ).rejects.toThrow("requires its thread_id");
});

test("publish retains config scope after the successful operation consumes the draft", async () => {
  let published = false;
  const posts: { path: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("/drafts/")) {
        return Response.json({}, { status: 404 });
      }
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
      }
      if (path.endsWith("/begin")) {
        return Response.json({ id: "operation", state: "PENDING" });
      }
      if (path.includes("environment-operations")) {
        published = true;
        return Response.json({ id: "operation", state: "SUCCEEDED" });
      }
      return Response.json(
        published
          ? {
              ...config,
              draft: undefined,
              version_id: "published",
              version_revision: 2,
            }
          : config,
      );
    },
  });
  const result = await client.environments.publish(
    "config",
    "onboarding-draft",
    { expectedRevision: 1, idempotencyKey: "retry-key" },
  );
  expect(result.version_revision).toBe(2);
  expect(posts).toEqual([
    {
      path: "/v1/environment-configs/config/draft/approve/begin",
      body: { expected_revision: 1, idempotency_key: "retry-key" },
    },
    {
      path: "/v1/environment-configs/config/draft/approve/complete",
      body: { operation_id: "operation" },
    },
  ]);
});

for (const threadId of ["onboarding-thread", "other-thread"]) {
  test(`completion without retained scope ${threadId === "onboarding-thread" ? "recognizes" : "rejects"} the published config owner`, async () => {
    const { client, requests } = fixture({
      config: { ...config, draft: undefined, version_revision: 2 },
    });
    const completion = client.environments.completePublish(
      "config",
      "onboarding-draft",
      "operation",
      threadId,
    );
    if (threadId === "onboarding-thread") {
      await completion;
      expect(requests.at(-1)?.body).toEqual({ operation_id: "operation" });
    } else {
      await expect(completion).rejects.toThrow("HTTP 404");
      expect(requests.every((r) => r.method === "GET")).toBe(true);
    }
  });
}
