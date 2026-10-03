import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";

for (const draft of [null, { id: "published-draft", base_version_id: "old" }]) {
  test(`opening an edit cannot allocate an unregistered thread with ${draft ? "a retained published draft" : "no config draft"}`, async () => {
    const requests: { path: string; method: string }[] = [];
    const client = new CodexCloudClient({
      tokens: { accessToken: "access" },
      fetch: async (url, init) => {
        requests.push({
          path: new URL(String(url)).pathname,
          method: init?.method ?? "GET",
        });
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

    await expect(client.environments.openDraft("config")).rejects.toThrow(
      "opened with Edit environment in the Codex UI",
    );
    expect(requests).toEqual([
      { path: "/v1/environment-configs/config", method: "GET" },
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

test("direct explicit writes cannot bypass UI initialization for an invisible or generic thread", async () => {
  const methods: string[] = [];
  const client = new CodexCloudClient({
    tokens: { accessToken: "access" },
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({
        id: "config",
        environment_id: "editing-runtime",
        draft: { id: "explicit-draft", revision: 1, base_version_id: "base" },
      });
    },
  });

  await expect(
    client.environments.updateDraft("config", "explicit-draft", {
      base_version_id: "base",
      expected_revision: 1,
      install_script: "echo changed",
    }),
  ).rejects.toThrow("cannot verify native UI initialization");
  expect(methods).toEqual(["GET"]);
  client.close();
});
