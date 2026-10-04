import { setTimeout as delay } from "node:timers/promises";
import type { PageOptions, RequestOptions } from "./cloud-types.js";
import { ApiError, CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { segment } from "./internal.js";
import type { CreatedTask, TasksApi } from "./tasks.js";

export type RepositoryId = `github-${string}`;

export interface EnvironmentRepository {
  repository_id: RepositoryId;
  ref: string;
  mount_path?: string;
}

export type NetworkPolicy =
  | { type: "unrestricted" }
  | { type: "restricted"; presets: string[]; egress_rules: unknown[] };

export type PersonalSecretNamespace = "not_sensitive" | "sensitive";

export type PersonalSecretTarget =
  | { type: "all_environment_configs" }
  | { type: "environment_config_ids"; ids: string[] };

export interface PersonalSecretMetadata {
  id: string;
  name: string;
  env_var: string;
  target: PersonalSecretTarget;
}

export type PersonalSecretInput = Omit<PersonalSecretMetadata, "id"> &
  ({ id?: never; value: string } | { id: string; value?: string });

export interface EnvironmentValueInput {
  namespace: "runtime" | "proxy";
  name: string;
  value: string;
}

export interface VaultValueReference {
  id: string;
  name: string;
}

export interface RuntimeRequirement {
  source: { type: "user_provided" } | { type: "vault_secret"; id: string };
  optional: boolean;
  delivery: { type: "direct_environment_variable"; variable_name: string };
}

export type EnvironmentSecret = {
  name: string;
  target: { environment_variable: string; allowed_domains: string[] };
} & (
  | { source: "environment"; id: string; optional?: boolean }
  | { source: "user_provided"; optional: boolean }
);

export interface EnvironmentDraft {
  id: string;
  base_version_id: string;
  revision: number;
  repositories: EnvironmentRepository[];
  install_script?: string;
  start_skill?: string;
  network_policy: NetworkPolicy;
  secrets?: EnvironmentSecret[];
  runtime_requirements?: RuntimeRequirement[];
  [key: string]: unknown;
}

export interface CloudEnvironment {
  id: string;
  name: string;
  repositories: EnvironmentRepository[];
  version_id: string;
  version_revision: number;
  latest_ready_version_id?: string;
  status?: string;
  install_script?: string;
  start_skill?: string;
  network_policy?: NetworkPolicy;
  secrets?: EnvironmentSecret[];
  runtime_requirements?: RuntimeRequirement[];
  environment_id?: string;
  thread_id?: string;
  draft?: EnvironmentDraft;
  [key: string]: unknown;
}

export interface EnvironmentPage {
  data: CloudEnvironment[];
  next_cursor?: string | null;
}

export interface CreatedEnvironment extends CloudEnvironment {
  setup_task?: CreatedTask;
}

export interface CreateEnvironmentInput {
  name: string;
  repositories: EnvironmentRepository[];
  network_policy?: NetworkPolicy;
  share_settings?: "private" | "workspace";
  /** Whether to start the onboarding skill in a durable setup thread. @default false */
  start_onboarding?: boolean;
}

export interface UpdateDraftInput {
  base_version_id: string;
  expected_revision: number;
  repositories?: EnvironmentRepository[];
  install_script?: string;
  start_skill?: string;
  network_policy?: NetworkPolicy;
  portals?: { ssh: boolean };
  secrets?: EnvironmentSecret[];
  runtime_requirements?: RuntimeRequirement[];
  outbound_identity_requirements?: unknown[];
}

export interface EditingRuntime {
  draft_id: string;
  environment_id: string;
  thread_id: string;
  draft_scope: EnvironmentDraftScope;
}

export type EnvironmentDraftScope = "config" | "editing_session";

export interface CompletePublishOptions extends RequestOptions {
  draftScope?: EnvironmentDraftScope;
}

export interface EnvironmentOperation {
  id: string;
  kind: string;
  state: string;
  draft_scope?: EnvironmentDraftScope;
  environment_id?: string;
  error?: unknown;
  [key: string]: unknown;
}

export class EnvironmentsApi {
  public constructor(
    private readonly http: HttpClient,
    private readonly tasks?: TasksApi,
  ) {}

  /** Lists persistent environment configs using the backend pagination envelope. */
  public list(
    options: PageOptions & {
      scope?: "user" | "workspace";
      omitDraft?: boolean;
    } = {},
  ): Promise<EnvironmentPage> {
    return this.http.request("/v1/environment-configs", {
      query: {
        scope: options.scope ?? "user",
        limit: options.limit ?? 100,
        cursor: options.cursor,
        omitDraft: options.omitDraft ?? true,
      },
      signal: options.signal,
    });
  }

  /** Reads a config's published version and any returned draft metadata. */
  public get(
    id: string,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    return this.http.request(`/v1/environment-configs/${segment(id)}`, options);
  }

  /** Creates a persistent config and optionally starts a durable onboarding turn. */
  public async create(
    input: CreateEnvironmentInput,
    options: RequestOptions = {},
  ): Promise<CreatedEnvironment> {
    if (input.start_onboarding && !this.tasks) {
      throw new CodexCloudError(
        "Onboarding requires the task API; create environments through CodexCloudClient",
      );
    }
    if (!input.name.trim()) {
      throw new CodexCloudError("Environment name must not be empty");
    }
    for (const repository of input.repositories) {
      githubRepositoryId(repository.repository_id);
      if (!repository.ref.trim()) {
        throw new CodexCloudError("Repository ref must not be empty");
      }
    }
    const config = await this.http.request<CloudEnvironment>(
      "/v1/environment-configs",
      {
        method: "POST",
        body: {
          ...input,
          network_policy: input.network_policy ?? {
            type: "restricted",
            presets: ["package_managers"],
            egress_rules: [],
          },
          share_settings: input.share_settings ?? "private",
          // Use durable thread/start to retain the setup thread's config association.
          start_onboarding: false,
        },
        signal: options.signal,
      },
    );
    if (!input.start_onboarding || !this.tasks) {
      return config;
    }
    try {
      const task = await this.tasks.setupEnvironment(
        { environmentConfigId: config.id },
        options,
      );
      const runtimeId = task.thread.environments?.[0]?.environmentId;
      return {
        ...config,
        thread_id: task.thread.id,
        ...(runtimeId ? { environment_id: runtimeId } : {}),
        setup_task: task,
      };
    } catch (error) {
      throw new CodexCloudError(
        `Environment config ${config.id} was created, but setup did not finish locally. Inspect get_environment and its thread's turns before retrying setup; do not recreate the config.`,
        { cause: error },
      );
    }
  }

  /** Renames the config without changing its published scripts. */
  public rename(
    id: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    if (!name.trim()) {
      throw new CodexCloudError("Environment name must not be empty");
    }
    return this.http.request(`/v1/environment-configs/${segment(id)}`, {
      method: "PATCH",
      body: { name },
      signal: options.signal,
    });
  }

  /** Opens or reuses a config draft bound to its durable native editor thread. */
  public async openDraft(
    id: string,
    options: RequestOptions = {},
  ): Promise<EditingRuntime> {
    const config = await this.get(id, options);
    if (config.draft && config.draft.base_version_id === config.version_id) {
      if (!config.thread_id || !config.environment_id) {
        throw new CodexCloudError(
          "The config has a pending draft but no editing runtime; inspect get_environment before opening another draft",
        );
      }
      return {
        draft_id: config.draft.id,
        thread_id: config.thread_id,
        environment_id: config.environment_id,
        draft_scope: "config",
      };
    }
    if (config.draft) {
      throw new CodexCloudError(
        "The pending draft is based on an older published version; read and reconcile it before opening another draft",
      );
    }
    if (!this.tasks) {
      throw new CodexCloudError(
        "Native environment editing requires the task API; open drafts through CodexCloudClient",
      );
    }
    let threadId = config.thread_id;
    try {
      if (threadId) {
        const previous = await this.tasks.get(threadId, options);
        if (previous.status?.type === "active") {
          throw new CodexCloudError(
            "The editor thread has an active turn; wait for completion before opening a draft",
          );
        }
      }
      const thread = await this.tasks.startEnvironmentEditingThread(
        id,
        options,
      );
      threadId = thread.id;
      if (thread.status?.type === "active") {
        throw new CodexCloudError(
          "The editor thread has an active turn; wait for completion before opening a draft",
        );
      }
      const runtime = thread.environments?.find(
        (environment) => environment.environmentConfigId === id,
      );
      if (!runtime?.environmentId) {
        throw new CodexCloudError(
          "The editor thread is not bound to the requested config",
        );
      }
      const current = await this.get(id, options);
      if (
        current.thread_id !== thread.id
        || current.environment_id !== runtime.environmentId
        || current.version_id !== config.version_id
      ) {
        throw new CodexCloudError(
          "The config's editor or published version changed; inspect get_environment before retrying",
        );
      }
      if (current.draft) {
        if (current.draft.base_version_id !== current.version_id) {
          throw new CodexCloudError(
            "The pending draft is based on an older published version",
          );
        }
        return {
          draft_id: current.draft.id,
          environment_id: runtime.environmentId,
          thread_id: thread.id,
          draft_scope: "config",
        };
      }
      // An omitted revision initializes only an absent draft; existing drafts conflict.
      const opened = await this.http.request<CloudEnvironment>(
        `/v1/environment-configs/${segment(id)}/draft`,
        {
          method: "PATCH",
          body: {
            base_version_id: current.version_id,
            repositories: current.repositories,
          },
          signal: options.signal,
        },
      );
      if (
        !opened.draft
        || opened.draft.base_version_id !== current.version_id
        || opened.thread_id !== thread.id
        || opened.environment_id !== runtime.environmentId
      ) {
        throw new CodexCloudError(
          "Draft initialization returned an unexpected editor binding",
        );
      }
      try {
        await this.tasks.rename(thread.id, `Edit ${current.name}`, options);
      } catch {
        // Naming is cosmetic and must not hide an initialized editor.
      }
      return {
        draft_id: opened.draft.id,
        environment_id: runtime.environmentId,
        thread_id: thread.id,
        draft_scope: "config",
      };
    } catch (error) {
      throw new CodexCloudError(
        `Opening the editor for config ${id}${threadId ? ` in thread ${threadId}` : ""} was not confirmed. Read get_environment and its thread before retrying; preserve any returned draft and runtime.`,
        { cause: error },
      );
    }
  }

  /** Reads an editing-session draft or the matching onboarding draft on its config. */
  public async getDraft(
    id: string,
    draftId: string,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    return (await this.#resolveDraft(id, draftId, options)).config;
  }

  async #resolveDraft(
    id: string,
    draftId: string,
    options: RequestOptions,
    publishedThreadId?: string,
  ) {
    const explicitPath =
      `/v1/environment-configs/${segment(id)}/drafts/${segment(draftId)}` as const;
    try {
      const config = await this.http.request<CloudEnvironment>(
        explicitPath,
        options,
      );
      return { config, path: explicitPath, configDraft: false };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) {
        throw error;
      }
      const config = await this.get(id, options);
      // Successful config publication removes its draft before completion.
      const publishedOwner =
        !config.draft
        && publishedThreadId !== undefined
        && config.thread_id === publishedThreadId;
      if (config.draft?.id !== draftId && !publishedOwner) {
        throw error;
      }
      return {
        config,
        path: `/v1/environment-configs/${segment(id)}/draft` as const,
        configDraft: true,
      };
    }
  }

  /** Saves draft changes guarded by the base version and expected revision. */
  public async updateDraft(
    id: string,
    draftId: string,
    input: UpdateDraftInput,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    const draft = await this.#resolveDraft(id, draftId, options);
    return this.http.request(draft.path, {
      method: "PATCH",
      body: input,
      signal: options.signal,
    });
  }

  /** Begins asynchronous publication with a caller-reusable idempotency key. */
  public async beginPublish(
    id: string,
    draftId: string,
    expectedRevision: number,
    idempotencyKey: string,
    options: RequestOptions = {},
  ): Promise<EnvironmentOperation> {
    const draft = await this.#resolveDraft(id, draftId, options);
    if (
      draft.configDraft
      && draft.config.draft?.revision !== expectedRevision
    ) {
      throw new CodexCloudError(
        "Draft revision changed; read the draft before publishing",
      );
    }
    const operation = await this.http.request<EnvironmentOperation>(
      `${draft.path}/approve/begin`,
      {
        method: "POST",
        body: {
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
        },
        signal: options.signal,
      },
    );
    return {
      ...operation,
      draft_scope: draft.configDraft ? "config" : "editing_session",
    };
  }

  /** Reads the state of a publication operation. */
  public getOperation(
    operationId: string,
    options: RequestOptions = {},
  ): Promise<EnvironmentOperation> {
    return this.http.request(
      `/v1/environment-operations/${segment(operationId)}`,
      options,
    );
  }

  /** Waits for operation success and rejects failed or unknown terminal states. */
  public async waitForOperation(
    operationId: string,
    options: RequestOptions & { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<EnvironmentOperation> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 45_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    for (;;) {
      const operation = await this.getOperation(operationId, { signal });
      if (operation.state === "SUCCEEDED") {
        return operation;
      }
      if (!["PENDING", "RUNNING"].includes(operation.state)) {
        throw new CodexCloudError(
          `Environment operation ${operationId} ended in state ${operation.state}`,
        );
      }
      await delay(options.intervalMs ?? 2_000, undefined, { signal });
    }
  }

  /** Completes an approved config draft, or an editing-session draft with its thread ID. */
  public async completePublish(
    id: string,
    draftId: string,
    operationId: string,
    threadId?: string,
    options: CompletePublishOptions = {},
  ): Promise<CloudEnvironment> {
    const configPath = `/v1/environment-configs/${segment(id)}` as const;
    const explicitPath = `${configPath}/drafts/${segment(draftId)}` as const;
    const draft =
      options.draftScope === "editing_session"
        ? { path: explicitPath, configDraft: false, config: undefined }
        : options.draftScope === "config"
          ? {
              path: `${configPath}/draft` as const,
              configDraft: true,
              config: await this.get(id, options),
            }
          : await this.#resolveDraft(id, draftId, options, threadId);
    if (
      draft.configDraft
      && threadId !== undefined
      && draft.config?.thread_id !== threadId
    ) {
      throw new CodexCloudError(
        "Onboarding publication requires the config's thread_id; read get_environment before completing",
      );
    }
    if (!draft.configDraft && !threadId) {
      throw new CodexCloudError(
        "Editing-session publication requires its thread_id",
      );
    }
    try {
      return await this.http.request<CloudEnvironment>(
        `${draft.path}/approve/complete`,
        {
          method: "POST",
          body: draft.configDraft
            ? { operation_id: operationId }
            : { operation_id: operationId, thread_id: threadId },
          signal: options.signal,
        },
      );
    } catch (error) {
      throw new CodexCloudError(
        `Completion of publication operation ${operationId} was not confirmed. The version may already be published; inspect get_environment and this operation before retrying.`,
        { cause: error },
      );
    }
  }

  /** Publishes a draft through begin, poll, and complete, preserving caller retry identity. */
  public async publish(
    id: string,
    draftId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      threadId?: string;
    },
    options: RequestOptions & { timeoutMs?: number } = {},
  ): Promise<CloudEnvironment> {
    const operation = await this.beginPublish(
      id,
      draftId,
      input.expectedRevision,
      input.idempotencyKey,
      options,
    );
    try {
      await this.waitForOperation(operation.id, options);
      await this.completePublish(id, draftId, operation.id, input.threadId, {
        ...options,
        ...(operation.draft_scope ? { draftScope: operation.draft_scope } : {}),
      });
      return await this.get(id, options);
    } catch (error) {
      throw new CodexCloudError(
        `Publication operation ${operation.id} did not finish locally. Inspect this operation before retrying publication.`,
        { cause: error },
      );
    }
  }

  /** Reads VPN capabilities or connection metadata for a config or draft. */
  public getVpn(
    id: string,
    options: RequestOptions & { draftId?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.http.request(`/v1/environment-configs/${segment(id)}/vpn`, {
      query: { draft_id: options.draftId },
      signal: options.signal,
    });
  }

  /** Lists secret metadata in the chosen namespace without requesting values. */
  public listSecrets(
    namespace: PersonalSecretNamespace,
    options: PageOptions = {},
  ): Promise<{
    secrets: PersonalSecretMetadata[];
    next_cursor?: string | null;
  }> {
    return this.http.request("/v1/personal-secrets", {
      query: { namespace, cursor: options.cursor },
      signal: options.signal,
    });
  }

  /** Creates or updates personal vault entries, preserving saved values when updates omit value. */
  public async savePersonalSecrets(
    namespace: PersonalSecretNamespace,
    secrets: PersonalSecretInput[],
    options: RequestOptions = {},
  ): Promise<{ secrets: VaultValueReference[] }> {
    const result = await this.http.request<{ secrets: VaultValueReference[] }>(
      "/v1/personal-secrets",
      { method: "POST", body: { namespace, secrets }, signal: options.signal },
    );
    return { secrets: result.secrets.map(({ id, name }) => ({ id, name })) };
  }

  /** Deletes requested personal vault entries and returns references, reporting confirmed progress on failure. */
  public async deletePersonalSecrets(
    namespace: PersonalSecretNamespace,
    ids: string[],
    options: RequestOptions = {},
  ): Promise<{ deleted: VaultValueReference[] }> {
    if (ids.length === 0) {
      throw new CodexCloudError("Supply at least one personal vault entry ID");
    }
    const entryIds = [...new Set(ids)];
    for (const id of entryIds) {
      segment(id);
    }

    const entries = new Map<string, VaultValueReference>();
    const requestedIds = new Set(entryIds);
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.listSecrets(namespace, {
        ...options,
        ...(cursor ? { cursor } : {}),
      });
      for (const { id, name } of page.secrets) {
        if (requestedIds.has(id)) {
          entries.set(id, { id, name });
        }
      }
      if (entries.size === entryIds.length) {
        break;
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new CodexCloudError(
            "Personal vault listing repeated a cursor; no entries were deleted",
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor);

    const requestedEntries = entryIds.map((id) => {
      const entry = entries.get(id);
      if (!entry) {
        throw new CodexCloudError(
          `Personal vault entry ${id} not found in ${namespace}; no entries were deleted`,
        );
      }
      return entry;
    });

    const deleted: VaultValueReference[] = [];
    for (const entry of requestedEntries) {
      const { id } = entry;
      try {
        await this.http.request("/v1/personal-secrets", {
          method: "DELETE",
          body: { namespace, ids: [id] },
          signal: options.signal,
        });
      } catch (error) {
        const status =
          error instanceof ApiError ? ` (HTTP ${error.status})` : "";
        throw new CodexCloudError(
          `Deletion of personal vault entry ${id} could not be confirmed${status}. Confirmed deletions: ${JSON.stringify(deleted)}. Use list_secret_metadata before retrying.`,
          { cause: error },
        );
      }
      deleted.push(entry);
    }
    return { deleted };
  }

  /** Stores an immutable shared value whose ID must be attached to an environment draft. */
  public async createValue(
    input: EnvironmentValueInput,
    options: RequestOptions = {},
  ): Promise<VaultValueReference> {
    const { id, name } = await this.http.request<VaultValueReference>(
      "/v1/environment-values",
      { method: "POST", body: input, signal: options.signal },
    );
    return { id, name };
  }
}

/** Converts a numeric GitHub repository ID into the cloud repository identifier. */
export function githubRepositoryId(id: number | string): RepositoryId {
  const value = String(id).replace(/^github-/, "");
  if (!/^\d+$/.test(value)) {
    throw new CodexCloudError(
      "Repository ID must be numeric or github-NUMERIC_ID",
    );
  }
  return `github-${value}`;
}
