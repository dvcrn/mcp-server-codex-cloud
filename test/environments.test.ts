import { describe, expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import {
  EnvironmentsApi,
  githubRepositoryId,
  type RepositoryId,
} from "../src/environments.js";
import { HttpClient } from "../src/http.js";
import { MemoryTokenStore } from "../src/token-store.js";

describe("EnvironmentsApi", () => {
  test("creates an environment with the verified wire format", async () => {
    let body: unknown;
    const api = makeApi(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(environmentWire());
    });

    const environment = await api.create({
      label: "dummy-test",
      repositories: ["github-1165432182"],
    });

    expect(body).toEqual({
      label: "dummy-test",
      repos: ["github-1165432182"],
      machine_id: "wham-public/wham-universal",
    });
    expect(environment).toMatchObject({
      id: "env-1",
      setupScripts: ["echo setup"],
      environmentVariables: { FOO: "bar" },
      secretNames: ["FOO_SECRET"],
      networkAccess: { mode: "on", presetAllowlist: "all" },
    });
  });

  test("patches environment variables, secrets, setup, and network settings", async () => {
    let body: unknown;
    const api = makeApi(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(environmentWire());
    });

    await api.update("env-1", {
      setupScript: "echo setup\necho done",
      environmentVariables: { FOO: "bar" },
      secrets: { FOO_SECRET: "secret" },
      networkAccess: "unrestricted",
    });

    expect(body).toEqual({
      setup: "echo setup\necho done",
      env_vars: { FOO: "bar" },
      secrets: { FOO_SECRET: "secret" },
      agent_network_access: {
        mode: "on",
        preset_allowlist: "all",
        allowlist_domains: "",
        allowlist_rules: null,
        denylist_domains: null,
        safe_methods_only: null,
      },
    });
  });

  test("patches only supplied settings", async () => {
    let url = "";
    let body: unknown;
    const api = makeApi(async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return Response.json(environmentWire());
    });

    await api.update("env/with slash", {
      cache: { postSetupCacheEnabled: false },
    });

    expect(url).toEndWith("/wham/environments/env%2Fwith%20slash");
    expect(body).toEqual({
      cache_settings: {
        post_setup_cache_enabled: false,
        cache_invalidation_key: "",
      },
    });
  });

  test("lists repository environments", async () => {
    let url = "";
    const api = makeApi(async (input) => {
      url = String(input);
      return Response.json([environmentWire()]);
    });

    expect(await api.listByRepository("owner name", "repo/name")).toHaveLength(
      1,
    );
    expect(url).toEndWith(
      "/wham/environments/by-repo/github/owner%20name/repo%2Fname",
    );
  });
});

test("githubRepositoryId rejects non-numeric IDs", async () => {
  expect(githubRepositoryId("123")).toBe("github-123");
  expect(() => githubRepositoryId("owner/repo")).toThrow();
  const api = makeApi(async () => Response.json(environmentWire()));
  for (const repository of [
    1165432182,
    "github-not-numeric",
  ] as unknown as RepositoryId[]) {
    expect(
      api.create({ label: "test", repositories: [repository] }),
    ).rejects.toThrow("github-NUMERIC_ID");
  }
});

function makeApi(
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): EnvironmentsApi {
  const auth = new AuthController({
    tokenStore: new MemoryTokenStore({ accessToken: "access" }),
    fetch,
  });
  return new EnvironmentsApi(new HttpClient({ auth, fetch }));
}

function environmentWire(): object {
  return {
    id: "env-1",
    label: "dummy-test",
    machine_id: "wham-public/wham-universal",
    repos: ["github-1165432182"],
    repo_map: {},
    setup: ["echo setup"],
    maintenance_setup: [],
    env_vars: { FOO: "bar" },
    secrets: { FOO_SECRET: "<REDACTED>" },
    agent_network_access: {
      mode: "on",
      preset_allowlist: "all",
      allowlist_domains: "",
      allowlist_rules: null,
      denylist_domains: null,
      safe_methods_only: null,
    },
    cache_settings: {
      post_setup_cache_enabled: true,
      cache_invalidation_key: "",
    },
    permissions: { can_write: true, can_delete: true },
    created_at: 1,
  };
}
