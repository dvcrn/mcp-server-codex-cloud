import { setTimeout as delay } from "node:timers/promises";
import type { PageOptions, RequestOptions } from "./cloud-types.js";
import { CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { segment } from "./internal.js";

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

export interface CreateEnvironmentInput {
  name: string;
  repositories: EnvironmentRepository[];
  network_policy?: NetworkPolicy;
  share_settings?: "private" | "workspace";
  /** Whether config creation requests backend onboarding. @default false */
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
}

export interface EnvironmentOperation {
  id: string;
  kind: string;
  state: string;
  environment_id?: string;
  error?: unknown;
  [key: string]: unknown;
}

export class EnvironmentsApi {
  public constructor(private readonly http: HttpClient) {}

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

  /** Creates a persistent config with repository refs and network policy. */
  public create(
    input: CreateEnvironmentInput,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    if (!input.name.trim()) {
      throw new CodexCloudError("Environment name must not be empty");
    }
    for (const repository of input.repositories) {
      githubRepositoryId(repository.repository_id);
      if (!repository.ref.trim()) {
        throw new CodexCloudError("Repository ref must not be empty");
      }
    }
    return this.http.request("/v1/environment-configs", {
      method: "POST",
      body: {
        ...input,
        network_policy: input.network_policy ?? {
          type: "restricted",
          presets: ["package_managers"],
          egress_rules: [],
        },
        share_settings: input.share_settings ?? "private",
        start_onboarding: input.start_onboarding ?? false,
      },
      signal: options.signal,
    });
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

  /** Opens an editing draft and returns its runtime and conversation IDs. */
  public openDraft(
    id: string,
    options: RequestOptions = {},
  ): Promise<EditingRuntime> {
    return this.http.request(`/v1/environment-configs/${segment(id)}/drafts`, {
      method: "POST",
      signal: options.signal,
    });
  }

  /** Reads an explicit draft together with the published config. */
  public getDraft(
    id: string,
    draftId: string,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    return this.http.request(
      `/v1/environment-configs/${segment(id)}/drafts/${segment(draftId)}`,
      options,
    );
  }

  /** Saves draft changes guarded by the base version and expected revision. */
  public updateDraft(
    id: string,
    draftId: string,
    input: UpdateDraftInput,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    return this.http.request(
      `/v1/environment-configs/${segment(id)}/drafts/${segment(draftId)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
  }

  /** Begins asynchronous publication with a caller-reusable idempotency key. */
  public beginPublish(
    id: string,
    draftId: string,
    expectedRevision: number,
    idempotencyKey: string,
    options: RequestOptions = {},
  ): Promise<EnvironmentOperation> {
    return this.http.request(
      `/v1/environment-configs/${segment(id)}/drafts/${segment(draftId)}/approve/begin`,
      {
        method: "POST",
        body: {
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
        },
        signal: options.signal,
      },
    );
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

  /** Completes an approved operation using the draft's editing thread. */
  public completePublish(
    id: string,
    draftId: string,
    operationId: string,
    threadId: string,
    options: RequestOptions = {},
  ): Promise<CloudEnvironment> {
    return this.http.request(
      `/v1/environment-configs/${segment(id)}/drafts/${segment(draftId)}/approve/complete`,
      {
        method: "POST",
        body: { operation_id: operationId, thread_id: threadId },
        signal: options.signal,
      },
    );
  }

  /** Publishes a draft through begin, poll, and complete, preserving caller retry identity. */
  public async publish(
    id: string,
    draftId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      threadId: string;
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
      await this.completePublish(
        id,
        draftId,
        operation.id,
        input.threadId,
        options,
      );
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
