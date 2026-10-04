import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";

for (const draft of [null, { id: "published-draft", base_version_id: "old" }]) {
  test(`opening an edit allocates a separate runtime with ${draft ? "a retained published draft" : "no config draft"}`, async () => {
    const requests: { path: string; method: string }[] = [];
    const client = new CodexCloudClient({
      tokens: { accessToken: "access" },
      fetch: async (url, init) => {
        requests.push({
          path: new URL(String(url)).pathname,
          method: init?.method ?? "GET",
        });
        if (init?.method === "POST") {
          return Response.json({
            draft_id: "editing-draft",
            thread_id: "editing-thread",
            environment_id: "editing-runtime",
          });
        }
        return Response.json({
          id: "config",
          version_id: "published-version",
          version_revision: 8,
          status: "ready",
          thread_id: "original-setup-thread",
          draft,
        });
      },
      socketFactory: async () => {
        throw new Error("Must not create or rename a substitute task");
      },
    });

    expect(await client.environments.openDraft("config")).toEqual({
      draft_id: "editing-draft",
      thread_id: "editing-thread",
      environment_id: "editing-runtime",
    });
    expect(requests).toEqual([
      { path: "/v1/environment-configs/config", method: "GET" },
      { path: "/v1/environment-configs/config/drafts", method: "POST" },
    ]);
    client.close();
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
