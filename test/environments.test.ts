import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";
import { githubRepositoryId } from "../src/environments.js";

test("config create and draft save use versioned routes, refs, and revision guards", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({
        id: "config",
        draft: { id: "draft", revision: 2 },
      });
    },
  });
  await client.environments.create({
    name: "test",
    repositories: [{ repository_id: "github-123", ref: "main" }],
  });
  await client.environments.openDraft("config");
  await client.environments.updateDraft("config", "draft", {
    base_version_id: "version",
    expected_revision: 1,
    install_script: "echo ready",
    start_skill: "Instructions",
  });
  expect(requests).toEqual([
    {
      path: "/v1/environment-configs",
      method: "POST",
      body: {
        name: "test",
        repositories: [{ repository_id: "github-123", ref: "main" }],
        network_policy: {
          type: "restricted",
          presets: ["package_managers"],
          egress_rules: [],
        },
        share_settings: "private",
        start_onboarding: false,
      },
    },
    {
      path: "/v1/environment-configs/config/drafts",
      method: "POST",
      body: undefined,
    },
    {
      path: "/v1/environment-configs/config/drafts/draft",
      method: "PATCH",
      body: {
        base_version_id: "version",
        expected_revision: 1,
        install_script: "echo ready",
        start_skill: "Instructions",
      },
    },
  ]);
});

test("publication completes only after operation success then reads back config", async () => {
  const requests: { path: string; body: unknown }[] = [];
  let polls = 0;
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.endsWith("/begin")) {
        return Response.json({ id: "operation", state: "PENDING" });
      }
      if (path.includes("environment-operations")) {
        return Response.json({
          id: "operation",
          state: ++polls === 1 ? "RUNNING" : "SUCCEEDED",
        });
      }
      return Response.json({ id: "config", version_id: "published-version" });
    },
  });
  const operation = await client.environments.beginPublish(
    "config",
    "draft",
    2,
    "retry-key",
  );
  await client.environments.waitForOperation(operation.id, { intervalMs: 1 });
  await client.environments.completePublish(
    "config",
    "draft",
    operation.id,
    "editing-thread",
  );
  expect((await client.environments.get("config")).version_id).toBe(
    "published-version",
  );
  expect(requests.map((x) => x.path)).toEqual([
    "/v1/environment-configs/config/drafts/draft/approve/begin",
    "/v1/environment-operations/operation",
    "/v1/environment-operations/operation",
    "/v1/environment-configs/config/drafts/draft/approve/complete",
    "/v1/environment-configs/config",
  ]);
  expect(requests[0]?.body).toEqual({
    expected_revision: 2,
    idempotency_key: "retry-key",
  });
  expect(requests[3]?.body).toEqual({
    operation_id: "operation",
    thread_id: "editing-thread",
  });
});

test("failed publication never runs complete and retains operation identity", async () => {
  const paths: string[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) => {
      paths.push(String(url));
      return Response.json({ id: "operation", state: "FAILED" });
    },
  });
  await expect(
    client.environments.publish("config", "draft", {
      expectedRevision: 1,
      idempotencyKey: "retry-key",
      threadId: "editing",
    }),
  ).rejects.toThrow("Publication operation operation");
  expect(paths.some((x) => x.endsWith("/complete"))).toBe(false);
});

test("draft conflict is surfaced without automatic retry or lost revision guard", async () => {
  let calls = 0;
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async () => {
      calls++;
      return Response.json({ error: { message: "conflict" } }, { status: 409 });
    },
  });
  await expect(
    client.environments.updateDraft("config", "draft", {
      base_version_id: "base",
      expected_revision: 0,
    }),
  ).rejects.toThrow("HTTP 409");
  expect(calls).toBe(1);
});

test("config pagination preserves snake case and opaque IDs are URL encoded", async () => {
  const urls: string[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({ data: [], next_cursor: "next" });
    },
  });
  expect(
    (
      await client.environments.list({
        scope: "workspace",
        cursor: "next",
        omitDraft: false,
      })
    ).next_cursor,
  ).toBe("next");
  await client.environments.getDraft("a/b", "c/d");
  expect(urls[0]).toContain(
    "scope=workspace&limit=100&cursor=next&omitDraft=false",
  );
  expect(urls[1]).toEndWith("/v1/environment-configs/a%2Fb/drafts/c%2Fd");
  expect(githubRepositoryId(123)).toBe("github-123");
  expect(() => githubRepositoryId("owner/repo")).toThrow();
});

test("personal vault writes distinguish create, replacement, and metadata-only update", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        secrets: [{ id: "entry", name: "KEY", value: "must-not-return" }],
      });
    },
  });
  const fields = {
    name: "KEY",
    env_var: "KEY",
    target: { type: "environment_config_ids" as const, ids: ["config"] },
  };
  expect(
    await client.environments.savePersonalSecrets("not_sensitive", [
      { ...fields, value: "first" },
    ]),
  ).toEqual({ secrets: [{ id: "entry", name: "KEY" }] });
  await client.environments.savePersonalSecrets("sensitive", [
    { ...fields, id: "entry", value: "replacement" },
  ]);
  await client.environments.savePersonalSecrets("sensitive", [
    { ...fields, id: "entry", env_var: "RENAMED" },
  ]);
  expect(requests).toEqual([
    {
      path: "/v1/personal-secrets",
      body: {
        namespace: "not_sensitive",
        secrets: [{ ...fields, value: "first" }],
      },
    },
    {
      path: "/v1/personal-secrets",
      body: {
        namespace: "sensitive",
        secrets: [{ ...fields, id: "entry", value: "replacement" }],
      },
    },
    {
      path: "/v1/personal-secrets",
      body: {
        namespace: "sensitive",
        secrets: [{ ...fields, id: "entry", env_var: "RENAMED" }],
      },
    },
  ]);
});

test("shared values return references and attach through revision-guarded drafts", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        id: "value",
        name: "KEY",
        value: "must-not-return",
      });
    },
  });
  expect(
    await client.environments.createValue({
      namespace: "runtime",
      name: "KEY",
      value: "first",
    }),
  ).toEqual({ id: "value", name: "KEY" });
  await client.environments.createValue({
    namespace: "proxy",
    name: "NETWORK",
    value: "dummy",
  });
  const update = {
    base_version_id: "base",
    expected_revision: 4,
    runtime_requirements: [
      {
        source: { type: "vault_secret" as const, id: "value" },
        optional: false,
        delivery: {
          type: "direct_environment_variable" as const,
          variable_name: "KEY",
        },
      },
    ],
    secrets: [
      {
        id: "network-value",
        name: "NETWORK",
        source: "environment" as const,
        target: {
          environment_variable: "NETWORK",
          allowed_domains: ["example.com"],
        },
      },
    ],
  };
  await client.environments.updateDraft("config", "draft", update);
  expect(requests).toEqual([
    {
      path: "/v1/environment-values",
      body: { namespace: "runtime", name: "KEY", value: "first" },
    },
    {
      path: "/v1/environment-values",
      body: { namespace: "proxy", name: "NETWORK", value: "dummy" },
    },
    { path: "/v1/environment-configs/config/drafts/draft", body: update },
  ]);
});
