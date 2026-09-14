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
      description: "",
      workspace_dir: "/workspace",
      setup: [""],
      maintenance_setup: [""],
      env_vars: {
        CODEX_ENV_PYTHON_VERSION: "3.12",
        CODEX_ENV_NODE_VERSION: "20",
        CODEX_ENV_RUBY_VERSION: "3.4.4",
        CODEX_ENV_RUST_VERSION: "1.89.0",
        CODEX_ENV_GO_VERSION: "1.24.3",
        CODEX_ENV_BUN_VERSION: "1.2.14",
        CODEX_ENV_PHP_VERSION: "8.4",
        CODEX_ENV_JAVA_VERSION: "21",
        CODEX_ENV_SWIFT_VERSION: "6.1",
      },
      auto_setup_settings: { use_auto_setup: true },
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

    const environment = await api.update("env-1", {
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
    expect(environment.warnings).toEqual([
      "Custom setup and maintenance scripts are ignored because autoSetupEnabled is true. Set it to false for these scripts to run.",
    ]);
  });

  test("does not warn when custom scripts are enabled", async () => {
    const api = makeApi(async () =>
      Response.json({
        ...environmentWire(),
        auto_setup_settings: { use_auto_setup: false },
      }),
    );

    const environment = await api.update("env-1", {
      setupScript: "echo setup",
      autoSetupEnabled: false,
    });

    expect(environment.warnings).toBeUndefined();
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

  test("gets environment details including secret names", async () => {
    let url = "";
    const api = makeApi(async (input) => {
      url = String(input);
      return Response.json(environmentWire());
    });

    const environment = await api.get("env/with slash");

    expect(url).toEndWith(
      "/wham/environments/env%2Fwith%20slash/with-creator-and-machine",
    );
    expect(environment.secretNames).toEqual(["FOO_SECRET"]);
  });

  test("tests an environment and aggregates SSE logs", async () => {
    const requests: { url: string; accept: string; body: unknown }[] = [];
    const api = makeApi(async (input, init) => {
      requests.push({
        url: String(input),
        accept: new Headers(init?.headers).get("accept") ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).endsWith("/environments/test")) {
        return new Response(
          'data: {"type":"log","key":"system","line":"Starting test"}\r\n\r\ndata: {"type":"log","key":"setup_autodetect","line":"Configuring runtimes"}\r\n\r\ndata: [DONE]\r\n\r\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json(environmentWire());
    });

    expect(await api.test("env-1")).toEqual({
      success: true,
      logs: [
        { type: "log", key: "system", line: "Starting test" },
        {
          type: "log",
          key: "setup_autodetect",
          line: "Configuring runtimes",
        },
      ],
    });
    expect(requests[1]).toEqual({
      url: "https://chatgpt.com/backend-api/wham/environments/test",
      accept: "text/event-stream",
      body: {
        machine_id: "wham-public/wham-universal",
        repos: ["github-1165432182"],
        github_connector_id: "connector-1",
        setup: ["echo setup"],
        maintenance_setup: [],
        workspace_dir: "/workspace",
        env_vars: { FOO: "bar" },
        secrets_with_domains: [
          { name: "FOO_SECRET", domains: ["example.com"] },
        ],
        environment_id: "env-1",
        agent_network_access: {
          mode: "on",
          preset_allowlist: "all",
          allowlist_domains: "",
          allowlist_rules: null,
          denylist_domains: null,
          safe_methods_only: null,
        },
        auto_setup_settings: { use_auto_setup: true },
      },
    });
  });

  test("reports environment test error events as failure", async () => {
    const api = makeApi(async (input) => {
      if (String(input).endsWith("/environments/test")) {
        return new Response(
          'data: {"type":"server_error","key":"system","line":"An unexpected error occurred"}\n\n',
        );
      }
      return Response.json(environmentWire());
    });

    expect(await api.test("env-1")).toMatchObject({
      success: false,
      logs: [{ type: "server_error" }],
    });
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
    github_connector_id: "connector-1",
    setup: ["echo setup"],
    maintenance_setup: [],
    env_vars: { FOO: "bar" },
    secrets: { FOO_SECRET: "<REDACTED>" },
    secrets_with_domains: [{ name: "FOO_SECRET", domains: ["example.com"] }],
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
    auto_setup_settings: { use_auto_setup: true },
    permissions: { can_write: true, can_delete: true },
    created_at: 1,
  };
}
