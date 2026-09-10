import { CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { segment } from "./internal.js";

export interface AgentNetworkAccess {
  mode: string;
  presetAllowlist: string | null;
  allowlistDomains: string | null;
  allowlistRules: unknown;
  denylistDomains: string | null;
  safeMethodsOnly: boolean | null;
}

export interface EnvironmentCacheSettings {
  postSetupCacheEnabled: boolean;
  cacheInvalidationKey: string;
}

const defaultEnvironmentVariables: Record<string, string> = {
  CODEX_ENV_PYTHON_VERSION: "3.12",
  CODEX_ENV_NODE_VERSION: "20",
  CODEX_ENV_RUBY_VERSION: "3.4.4",
  CODEX_ENV_RUST_VERSION: "1.89.0",
  CODEX_ENV_GO_VERSION: "1.24.3",
  CODEX_ENV_BUN_VERSION: "1.2.14",
  CODEX_ENV_PHP_VERSION: "8.4",
  CODEX_ENV_JAVA_VERSION: "21",
  CODEX_ENV_SWIFT_VERSION: "6.1",
};

export interface EnvironmentPermissions {
  canWrite: boolean;
  canDelete: boolean;
}

export interface CloudEnvironment {
  id: string;
  label: string;
  machineId: string;
  repositoryIds: string[];
  repositories: Record<string, unknown>;
  githubConnectorId: string | null;
  setupScripts: string[];
  maintenanceScripts: string[];
  environmentVariables: Record<string, string>;
  secretNames: string[];
  secretsWithDomains: unknown[];
  networkAccess: AgentNetworkAccess | null;
  autoSetupEnabled: boolean | null;
  cache: EnvironmentCacheSettings | null;
  permissions: EnvironmentPermissions | null;
  workspaceDirectory: string | null;
  description: string | null;
  isPinned: boolean;
  taskCount: number;
  etag: string | null;
  createdAt: Date | null;
  dockerInDockerEnabled: boolean;
  authTranslatorEnabled: boolean;
  shareSettings: string | null;
  shareTargets: unknown[];
  warnings?: string[];
}

export type RepositoryId = `github-${string}`;

export interface CreateEnvironmentInput {
  label: string;
  repositories: readonly RepositoryId[];
  machineId?: string;
}

export interface UpdateEnvironmentInput {
  label?: string;
  repositories?: readonly RepositoryId[];
  machineId?: string;
  description?: string | null;
  workspaceDirectory?: string | null;
  setupScript?: string;
  maintenanceScript?: string;
  environmentVariables?: Record<string, string>;
  secrets?: Record<string, string>;
  networkAccess?: AgentNetworkAccessInput | "unrestricted" | null;
  autoSetupEnabled?: boolean;
  cache?: EnvironmentCacheSettingsInput;
  dockerInDockerEnabled?: boolean;
}

export interface AgentNetworkAccessInput {
  mode: string;
  presetAllowlist?: string | null;
  allowlistDomains?: string | null;
  allowlistRules?: unknown;
  denylistDomains?: string | null;
  safeMethodsOnly?: boolean | null;
}

export interface EnvironmentCacheSettingsInput {
  postSetupCacheEnabled: boolean;
  cacheInvalidationKey?: string;
}

export interface EnvironmentTestLog {
  type: string;
  key: string;
  line: string;
}

export interface EnvironmentTestResult {
  success: boolean;
  logs: EnvironmentTestLog[];
}

export class EnvironmentsApi {
  public constructor(private readonly http: HttpClient) {}

  public async list(
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudEnvironment[]> {
    const environments = await this.http.request<EnvironmentWire[]>(
      "/environments",
      {
        signal: options.signal,
      },
    );
    return environments.map(mapEnvironment);
  }

  public async listByRepository(
    owner: string,
    repository: string,
    options: { provider?: string; signal?: AbortSignal } = {},
  ): Promise<CloudEnvironment[]> {
    const provider = options.provider ?? "github";
    const path =
      `/environments/by-repo/${segment(provider)}/${segment(owner)}/${segment(repository)}` as const;
    const environments = await this.http.request<EnvironmentWire[]>(path, {
      signal: options.signal,
    });
    return environments.map(mapEnvironment);
  }

  public async get(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudEnvironment> {
    const environment = (await this.list(options)).find(
      (candidate) => candidate.id === id,
    );
    if (!environment) {
      throw new CodexCloudError(`Environment ${id} was not found`);
    }
    return environment;
  }

  public async create(
    input: CreateEnvironmentInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudEnvironment> {
    if (!input.label.trim()) {
      throw new CodexCloudError("Environment label must not be empty");
    }
    if (input.repositories.length === 0) {
      throw new CodexCloudError("At least one repository is required");
    }
    const environment = await this.http.request<EnvironmentWire>(
      "/environments",
      {
        method: "POST",
        body: {
          label: input.label,
          repos: input.repositories.map(repositoryId),
          machine_id: input.machineId ?? "wham-public/wham-universal",
          description: "",
          workspace_dir: "/workspace",
          setup: [""],
          maintenance_setup: [""],
          env_vars: defaultEnvironmentVariables,
          auto_setup_settings: { use_auto_setup: true },
        },
        signal: options.signal,
      },
    );
    return mapEnvironment(environment);
  }

  public async update(
    id: string,
    input: UpdateEnvironmentInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudEnvironment> {
    const environment = await this.http.request<EnvironmentWire>(
      `/environments/${segment(id)}`,
      {
        method: "PATCH",
        body: environmentInput(input),
        signal: options.signal,
      },
    );
    const result = mapEnvironment(environment);
    if (
      result.autoSetupEnabled === true
      && (input.setupScript !== undefined
        || input.maintenanceScript !== undefined)
    ) {
      result.warnings = [
        "Custom setup and maintenance scripts are ignored because autoSetupEnabled is true. Set it to false for these scripts to run.",
      ];
    }
    return result;
  }

  /** Runs the current environment configuration and collects its setup logs. */
  public async test(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentTestResult> {
    const environment = await this.get(id, options);
    const stream = await this.http.requestEventStream("/environments/test", {
      method: "POST",
      body: {
        machine_id: environment.machineId,
        repos: environment.repositoryIds,
        github_connector_id: environment.githubConnectorId,
        setup: environment.setupScripts,
        maintenance_setup: environment.maintenanceScripts,
        workspace_dir: environment.workspaceDirectory ?? "/workspace",
        env_vars: environment.environmentVariables,
        secrets_with_domains: environment.secretsWithDomains,
        environment_id: environment.id,
        agent_network_access: environment.networkAccess
          ? mapNetworkInput(environment.networkAccess)
          : null,
        auto_setup_settings: {
          use_auto_setup: environment.autoSetupEnabled ?? true,
        },
      },
      signal: options.signal,
    });
    const logs = parseTestLogs(stream);
    return {
      success: !logs.some((log) => log.type === "error"),
      logs,
    };
  }
}

export function githubRepositoryId(id: number | string): `github-${string}` {
  const value = String(id).trim();
  if (!/^\d+$/.test(value)) {
    throw new CodexCloudError("GitHub repository ID must be numeric");
  }
  return `github-${value}`;
}

export function unrestrictedNetworkAccess(): AgentNetworkAccessInput {
  return {
    mode: "on",
    presetAllowlist: "all",
    allowlistDomains: "",
    allowlistRules: null,
    denylistDomains: null,
    safeMethodsOnly: null,
  };
}

interface EnvironmentWire {
  id: string;
  label: string;
  machine_id: string;
  repos?: string[];
  repo_map?: Record<string, unknown>;
  github_connector_id?: string | null;
  setup?: string[] | string;
  maintenance_setup?: string[] | string;
  env_vars?: Record<string, string>;
  secrets?: Record<string, string>;
  secrets_with_domains?: unknown[];
  agent_network_access?: NetworkWire | null;
  auto_setup_settings?: { use_auto_setup?: boolean } | null;
  cache_settings?: {
    post_setup_cache_enabled?: boolean;
    cache_invalidation_key?: string;
  } | null;
  permissions?: { can_write?: boolean; can_delete?: boolean } | null;
  workspace_dir?: string | null;
  description?: string | null;
  is_pinned?: boolean;
  task_count?: number;
  etag?: string | null;
  created_at?: number | null;
  enable_docker_in_docker?: boolean;
  enable_authtranslator?: boolean;
  share_settings?: string | null;
  share_targets?: unknown[];
}

interface NetworkWire {
  mode?: string;
  preset_allowlist?: string | null;
  allowlist_domains?: string | null;
  allowlist_rules?: unknown;
  denylist_domains?: string | null;
  safe_methods_only?: boolean | null;
}

function environmentInput(
  input: UpdateEnvironmentInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.label !== undefined) {
    body.label = input.label;
  }
  if (input.repositories !== undefined) {
    body.repos = input.repositories.map(repositoryId);
  }
  if (input.machineId !== undefined) {
    body.machine_id = input.machineId;
  }
  if (input.description !== undefined) {
    body.description = input.description;
  }
  if (input.workspaceDirectory !== undefined) {
    body.workspace_dir = input.workspaceDirectory;
  }
  if (input.setupScript !== undefined) {
    body.setup = input.setupScript;
  }
  if (input.maintenanceScript !== undefined) {
    body.maintenance_setup = input.maintenanceScript;
  }
  if (input.environmentVariables !== undefined) {
    body.env_vars = input.environmentVariables;
  }
  if (input.secrets !== undefined) {
    body.secrets = input.secrets;
  }
  if (input.networkAccess !== undefined) {
    body.agent_network_access = mapNetworkInput(input.networkAccess);
  }
  if (input.autoSetupEnabled !== undefined) {
    body.auto_setup_settings = { use_auto_setup: input.autoSetupEnabled };
  }
  if (input.cache !== undefined) {
    body.cache_settings = {
      post_setup_cache_enabled: input.cache.postSetupCacheEnabled,
      cache_invalidation_key: input.cache.cacheInvalidationKey ?? "",
    };
  }
  if (input.dockerInDockerEnabled !== undefined) {
    body.enable_docker_in_docker = input.dockerInDockerEnabled;
  }
  return body;
}

function repositoryId(id: RepositoryId): string {
  if (typeof id !== "string" || !/^github-\d+$/.test(id)) {
    throw new CodexCloudError(
      "Repository ID must use the github-NUMERIC_ID format",
    );
  }
  return id;
}

function mapNetworkInput(
  input: AgentNetworkAccessInput | "unrestricted" | null,
): unknown {
  if (input === null) {
    return null;
  }
  const value = input === "unrestricted" ? unrestrictedNetworkAccess() : input;
  return {
    mode: value.mode,
    preset_allowlist: value.presetAllowlist ?? null,
    allowlist_domains: value.allowlistDomains ?? null,
    allowlist_rules: value.allowlistRules ?? null,
    denylist_domains: value.denylistDomains ?? null,
    safe_methods_only: value.safeMethodsOnly ?? null,
  };
}

function mapEnvironment(wire: EnvironmentWire): CloudEnvironment {
  const network = wire.agent_network_access;
  const cache = wire.cache_settings;
  const permissions = wire.permissions;
  return {
    id: wire.id,
    label: wire.label,
    machineId: wire.machine_id,
    repositoryIds: wire.repos ?? [],
    repositories: wire.repo_map ?? {},
    githubConnectorId: wire.github_connector_id ?? null,
    setupScripts: scripts(wire.setup),
    maintenanceScripts: scripts(wire.maintenance_setup),
    environmentVariables: wire.env_vars ?? {},
    secretNames: Object.keys(wire.secrets ?? {}),
    secretsWithDomains: wire.secrets_with_domains ?? [],
    networkAccess: network
      ? {
          mode: network.mode ?? "unknown",
          presetAllowlist: network.preset_allowlist ?? null,
          allowlistDomains: network.allowlist_domains ?? null,
          allowlistRules: network.allowlist_rules ?? null,
          denylistDomains: network.denylist_domains ?? null,
          safeMethodsOnly: network.safe_methods_only ?? null,
        }
      : null,
    autoSetupEnabled: wire.auto_setup_settings?.use_auto_setup ?? null,
    cache: cache
      ? {
          postSetupCacheEnabled: cache.post_setup_cache_enabled ?? false,
          cacheInvalidationKey: cache.cache_invalidation_key ?? "",
        }
      : null,
    permissions: permissions
      ? {
          canWrite: permissions.can_write ?? false,
          canDelete: permissions.can_delete ?? false,
        }
      : null,
    workspaceDirectory: wire.workspace_dir ?? null,
    description: wire.description ?? null,
    isPinned: wire.is_pinned ?? false,
    taskCount: wire.task_count ?? 0,
    etag: wire.etag ?? null,
    createdAt:
      wire.created_at === undefined || wire.created_at === null
        ? null
        : new Date(wire.created_at * 1000),
    dockerInDockerEnabled: wire.enable_docker_in_docker ?? false,
    authTranslatorEnabled: wire.enable_authtranslator ?? false,
    shareSettings: wire.share_settings ?? null,
    shareTargets: wire.share_targets ?? [],
  };
}

function scripts(value: string[] | string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseTestLogs(stream: string): EnvironmentTestLog[] {
  const logs: EnvironmentTestLog[] = [];
  for (const event of stream.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexCloudError("Environment test returned invalid SSE data");
    }
    if (!isRecord(parsed)) {
      throw new CodexCloudError("Environment test returned invalid SSE data");
    }
    logs.push({
      type: typeof parsed.type === "string" ? parsed.type : "log",
      key: typeof parsed.key === "string" ? parsed.key : "system",
      line:
        typeof parsed.line === "string"
          ? parsed.line
          : typeof parsed.message === "string"
            ? parsed.message
            : data,
    });
  }
  return logs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
