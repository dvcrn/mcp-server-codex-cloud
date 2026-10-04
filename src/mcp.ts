import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { CodexCloudClient } from "./client.js";
import type { RepositoryId } from "./environments.js";
import {
  ApiError,
  AuthenticationError,
  CodexCloudError,
  RpcError,
  TokenRefreshError,
} from "./errors.js";

const id = z.string().trim().min(1);
const repositoryIdError =
  "Repository ID must be a string in github-NUMERIC_ID format, for example github-23123123";
const repository = z
  .string({ error: repositoryIdError })
  .regex(/^github-\d+$/, repositoryIdError) as z.ZodType<RepositoryId>;
const repositoryRef = z.strictObject({
  repository_id: repository,
  ref: id,
  mount_path: id.optional(),
});
const networkPolicy = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("unrestricted") }),
  z.strictObject({
    type: z.literal("restricted"),
    presets: z.array(z.string()),
    egress_rules: z.array(z.unknown()),
  }),
]);
const personalSecretTarget = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("all_environment_configs") }),
  z.strictObject({
    type: z.literal("environment_config_ids"),
    ids: z.array(id).min(1).max(100),
  }),
]);
const personalSecretFields = {
  name: id,
  env_var: id,
  target: personalSecretTarget,
};
const personalSecretInput = z.union([
  z.strictObject({ ...personalSecretFields, value: z.string() }),
  z.strictObject({
    ...personalSecretFields,
    id,
    value: z.string().optional(),
  }),
]);
const runtimeRequirement = z.strictObject({
  source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user_provided") }),
    z.strictObject({ type: z.literal("vault_secret"), id }),
  ]),
  optional: z.boolean(),
  delivery: z.strictObject({
    type: z.literal("direct_environment_variable"),
    variable_name: id,
  }),
});
const environmentSecretFields = {
  name: id,
  target: z.strictObject({
    environment_variable: id,
    allowed_domains: z.array(id),
  }),
};
const environmentSecret = z.discriminatedUnion("source", [
  z.strictObject({
    ...environmentSecretFields,
    id,
    source: z.literal("environment"),
    optional: z.boolean().optional(),
  }),
  z.strictObject({
    ...environmentSecretFields,
    source: z.literal("user_provided"),
    optional: z.boolean(),
  }),
]);
const page = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: id.optional(),
};
const turnOptions = {
  model: id.optional(),
  effort: id.optional(),
  serviceTier: id.optional(),
};
const prompt = z
  .string()
  .refine((value) => value.trim().length > 0, "Prompt must not be empty");

/** Creates the MCP tools for cloud configs, publication, threads, and turns. */
export function createMcpServer(client: CodexCloudClient): McpServer {
  const server = new McpServer({
    name: "mcp-server-codex-cloud",
    version: packageJson.version,
  });
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    run: (
      input: z.infer<z.ZodObject<S>>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(shape),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      async (input, ctx: ServerContext) => {
        try {
          const result = await run(input, ctx.mcpReq.signal);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          const message = toolError(error, name);
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
          };
        }
      },
    );
  }
  tool(
    "list_environments",
    "List persistent cloud environment configs.",
    {
      ...page,
      scope: z.enum(["user", "workspace"]).optional(),
      omitDraft: z.boolean().optional(),
    },
    true,
    (a, signal) => client.environments.list({ ...defined(a), signal }),
  );
  tool(
    "get_environment",
    "Read a published config and its pending draft. Use the returned draft.id directly with get_environment_draft and begin_environment_publish.",
    { id },
    true,
    (a, signal) => client.environments.get(a.id, { signal }),
  );
  tool(
    "create_environment",
    "Create a cloud config with repository refs. Resolve numeric GitHub repository IDs first. start_onboarding starts the onboarding skill in a durable setup thread and returns setup_task with thread and turn IDs. Review and publish the draft before starting tasks.",
    {
      name: id,
      repositories: z.array(repositoryRef),
      network_policy: networkPolicy.optional(),
      share_settings: z.enum(["private", "workspace"]).optional(),
      start_onboarding: z.boolean().optional(),
    },
    false,
    (a, signal) => client.environments.create(defined(a), { signal }),
  );
  tool(
    "rename_environment",
    "Rename an environment config.",
    { id, name: id },
    false,
    (a, signal) => client.environments.rename(a.id, a.name, { signal }),
  );
  tool(
    "open_environment_draft",
    "Return the existing pending config draft and its runtime, or open a new editing draft. Keep draft_id, environment_id, and thread_id for saving and publishing.",
    { id },
    false,
    (a, signal) => client.environments.openDraft(a.id, { signal }),
  );
  tool(
    "get_environment_draft",
    "Read an editing-session or onboarding draft and its base version and revision.",
    { id, draftId: id },
    true,
    (a, signal) => client.environments.getDraft(a.id, a.draftId, { signal }),
  );
  tool(
    "update_environment_draft",
    "Save environment fields with an expected revision. secrets and runtime_requirements replace whole lists; preserve existing entries. Read the returned revision before publishing.",
    {
      id,
      draftId: id,
      update: z.strictObject({
        base_version_id: id,
        expected_revision: z.number().int().min(0),
        install_script: z.string().optional(),
        start_skill: z.string().optional(),
        repositories: z.array(repositoryRef).optional(),
        network_policy: networkPolicy.optional(),
        portals: z.strictObject({ ssh: z.boolean() }).optional(),
        secrets: z.array(environmentSecret).optional(),
        runtime_requirements: z.array(runtimeRequirement).optional(),
      }),
    },
    false,
    (a, signal) =>
      client.environments.updateDraft(
        a.id,
        a.draftId,
        {
          ...defined(a.update),
          ...(a.update.secrets === undefined
            ? {}
            : { secrets: a.update.secrets.map((entry) => defined(entry)) }),
        },
        {
          signal,
        },
      ),
  );
  tool(
    "begin_environment_publish",
    "Begin publication. Supply a UUID idempotencyKey and retain the returned operation ID and draft_scope for polling and completion; a timeout does not mean publication failed.",
    {
      id,
      draftId: id,
      expectedRevision: z.number().int().min(0),
      idempotencyKey: z.uuid(),
    },
    false,
    (a, signal) =>
      client.environments.beginPublish(
        a.id,
        a.draftId,
        a.expectedRevision,
        a.idempotencyKey,
        { signal },
      ),
  );
  tool(
    "get_environment_operation",
    "Read asynchronous publication state. SUCCEEDED requires complete_environment_publish before reporting publication complete.",
    { operationId: id },
    true,
    (a, signal) => client.environments.getOperation(a.operationId, { signal }),
  );
  tool(
    "wait_for_environment_operation",
    "Wait up to 50 seconds for publication validation. Retain the same operation ID after timeout.",
    {
      operationId: id,
      timeoutMs: z.number().int().min(1).max(50000).optional(),
    },
    true,
    (a, signal) =>
      client.environments.waitForOperation(a.operationId, {
        ...defined(a),
        signal,
      }),
  );
  tool(
    "complete_environment_publish",
    "Complete a succeeded publication, then read back the config. Pass draftScope from begin's draft_scope because publication can remove the draft. Editing-session drafts require threadId; onboarding drafts use the config owner automatically. A completion error may occur after publication; inspect the config before retrying.",
    {
      id,
      draftId: id,
      operationId: id,
      threadId: id.optional(),
      draftScope: z.enum(["config", "editing_session"]).optional(),
    },
    false,
    async (a, signal) => {
      const operation = await client.environments.getOperation(a.operationId, {
        signal,
      });
      if (operation.state !== "SUCCEEDED") {
        throw new CodexCloudError("Publication operation has not succeeded");
      }
      await client.environments.completePublish(
        a.id,
        a.draftId,
        a.operationId,
        a.threadId,
        { signal, ...(a.draftScope ? { draftScope: a.draftScope } : {}) },
      );
      return client.environments.get(a.id, { signal });
    },
  );
  tool(
    "get_environment_vpn",
    "Read VPN capabilities and connection metadata.",
    { id, draftId: id.optional() },
    true,
    (a, signal) => client.environments.getVpn(a.id, { ...defined(a), signal }),
  );
  tool(
    "list_secret_metadata",
    "List personal secret names and targets without requesting values.",
    {
      namespace: z.enum(["not_sensitive", "sensitive"]),
      cursor: id.optional(),
    },
    true,
    (a, signal) =>
      client.environments.listSecrets(a.namespace, { ...defined(a), signal }),
  );
  tool(
    "save_personal_secrets",
    "Create or update personal vault entries. not_sensitive supplies real environment variables; sensitive supplies network placeholders. Supply id to update, omit value to preserve it. Returns IDs and names only. The environment must request the key separately.",
    {
      namespace: z.enum(["not_sensitive", "sensitive"]),
      secrets: z.array(personalSecretInput).min(1),
    },
    false,
    (a, signal) =>
      client.environments.savePersonalSecrets(
        a.namespace,
        a.secrets.map((entry) => defined(entry)),
        { signal },
      ),
  );

  tool(
    "delete_personal_secrets",
    "Delete personal vault entries by IDs from list_secret_metadata in the specified namespace. Returns deleted IDs and names only. Stops on failure and reports confirmed deletions; list metadata before retrying.",
    {
      namespace: z.enum(["not_sensitive", "sensitive"]),
      ids: z.array(id).min(1).max(100),
    },
    false,
    (a, signal) =>
      client.environments.deletePersonalSecrets(a.namespace, a.ids, { signal }),
  );

  tool(
    "create_environment_value",
    "Store a shared value and return its ID and name only. runtime is a direct variable, proxy is a network secret. Attach its ID using update_environment_draft, then publish. Replacements create a new ID; this tool alone does not update the environment.",
    { namespace: z.enum(["runtime", "proxy"]), name: id, value: z.string() },
    false,
    (a, signal) => client.environments.createValue(a, { signal }),
  );
  tool(
    "list_tasks",
    "List cloud conversation threads with cursor pagination.",
    page,
    true,
    (a, signal) => client.tasks.list({ ...defined(a), signal }),
  );
  tool(
    "get_task",
    "Read cloud thread metadata. Use list_task_turns for messages and tool output.",
    { threadId: id },
    true,
    (a, signal) => client.tasks.get(a.threadId, { signal }),
  );
  tool(
    "rename_task",
    "Rename a cloud task thread and return its persisted metadata.",
    { threadId: id, name: id },
    false,
    (a, signal) => client.tasks.rename(a.threadId, a.name, { signal }),
  );
  tool(
    "archive_task",
    "Archive an idle cloud task without resuming its environment. Use list_tasks to verify it is absent from active tasks before retrying an uncertain result.",
    { threadId: id },
    false,
    (a, signal) => client.tasks.archive(a.threadId, { signal }),
  );
  tool(
    "restore_task",
    "Restore an archived cloud task and return its metadata.",
    { threadId: id },
    false,
    (a, signal) => client.tasks.restore(a.threadId, { signal }),
  );
  tool(
    "start_task",
    "Create a cloud thread using a published environmentConfigId and start its first turn. This consumes account usage. Retain both thread.id and turn.id.",
    { environmentConfigId: id, prompt, cwd: id.optional(), ...turnOptions },
    false,
    (a, signal) => client.tasks.create(defined(a), { signal }),
  );
  tool(
    "start_environment_setup",
    "Run the Cloud Environment Onboarding setup skill for an existing config. Resume its setup thread or allocate one if absent; active turns must finish first. Consumes account usage. Retain thread.id and turn.id for history and follow-ups; review its draft and publish separately to activate it.",
    { environmentConfigId: id, name: id.optional(), ...turnOptions },
    false,
    (a, signal) => client.tasks.setupEnvironment(defined(a), { signal }),
  );
  tool(
    "follow_up_task",
    "Resume a cloud thread and start a new turn in its retained environment. This consumes account usage. For an active turn use steer_task instead.",
    { threadId: id, prompt, ...turnOptions },
    false,
    (a, signal) => client.tasks.followUp(defined(a), { signal }),
  );
  tool(
    "steer_task",
    "Add a message to a specific active turn; rejects if expectedTurnId is no longer active.",
    { threadId: id, expectedTurnId: id, prompt },
    false,
    (a, signal) => client.tasks.steer(a, { signal }),
  );
  tool(
    "cancel_task",
    "Request interruption of the specified turn. Poll its history to verify interrupted status.",
    { threadId: id, turnId: id },
    false,
    (a, signal) => client.tasks.cancel(a.threadId, a.turnId, { signal }),
  );
  tool(
    "list_task_turns",
    "Read paginated thread history. itemsView full includes messages, reasoning, tool results, and file-change items; notLoaded intentionally omits them.",
    {
      threadId: id,
      ...page,
      sortDirection: z.enum(["asc", "desc"]).optional(),
      itemsView: z.enum(["notLoaded", "summary", "full"]).optional(),
    },
    true,
    (a, signal) =>
      client.tasks.listTurns(a.threadId, { ...defined(a), signal }),
  );
  tool(
    "list_task_items",
    "Read paginated persisted thread items, optionally restricted to a turn.",
    {
      threadId: id,
      turnId: id.optional(),
      ...page,
      sortDirection: z.enum(["asc", "desc"]).optional(),
    },
    true,
    (a, signal) =>
      client.tasks.listItems(a.threadId, { ...defined(a), signal }),
  );
  tool(
    "wait_for_task",
    "Wait up to 50 seconds for a specific turn to complete, fail, or be interrupted. After timeout poll the same threadId and turnId.",
    {
      threadId: id,
      turnId: id,
      intervalMs: z.number().int().min(1000).max(10000).optional(),
      timeoutMs: z.number().int().min(1).max(50000).optional(),
    },
    true,
    (a, signal) =>
      client.tasks.waitFor(a.threadId, a.turnId, { ...defined(a), signal }),
  );
  tool(
    "list_models",
    "List available models and supported reasoning efforts and service tiers.",
    { ...page, includeHidden: z.boolean().optional() },
    true,
    (a, signal) => client.tasks.listModels({ ...defined(a), signal }),
  );
  tool(
    "list_collaboration_modes",
    "Read available collaboration modes.",
    {},
    true,
    (_, signal) => client.tasks.listCollaborationModes({ signal }),
  );
  tool(
    "refresh_auth",
    "Refresh and persist OAuth credentials without returning tokens.",
    {},
    false,
    async () => {
      await client.refreshTokens();
      return { refreshed: true };
    },
  );
  return server;
}

/**
 * Zod fills absent optional fields with `undefined`, but `exactOptionalPropertyTypes`
 * requires them omitted. Drop those keys so parsed input satisfies the API types.
 */
type Defined<T> = T extends object
  ? { [K in keyof T]: Defined<Exclude<T[K], undefined>> }
  : T;

function defined<T extends Record<string, unknown>>(value: T): Defined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result as Defined<T>;
}

/**
 * Build the message the calling model sees.
 *
 * Upstream error bodies are withheld deliberately: they can echo environment
 * secrets submitted by `update_environment`. Status codes and validation
 * messages raised by this package are safe and worth surfacing.
 */
function toolError(error: unknown, name: string): string {
  if (
    name === "wait_for_task"
    && error instanceof DOMException
    && error.name === "TimeoutError"
  ) {
    return "Timed out waiting for the task. Poll list_task_turns or wait_for_task with the same thread and turn IDs.";
  }
  if (
    name === "start_environment_setup"
    && error instanceof RpcError
    && error.code === -32004
  ) {
    return "Codex Cloud rejected setup thread allocation (RPC -32004) before returning a thread ID. Use get_environment to inspect the config's existing thread_id and draft. Continue an existing setup with follow_up_task, or test initial onboarding on a new config. Check list_tasks before retrying. No naming request or setup turn was sent.";
  }
  if (error instanceof ApiError) {
    if (
      name === "cancel_task"
      && (error.status === 400 || error.status === 409)
    ) {
      return "The task cannot be cancelled in its current state.";
    }
    const hint =
      error.status === 404
        ? " The referenced resource does not exist."
        : error.status === 429
          ? " The account is rate limited; retry later."
          : error.status >= 500
            ? " Codex Cloud is unavailable; retry later."
            : " Check the inputs.";
    return `Codex Cloud returned HTTP ${error.status}.${hint}`;
  }
  if (error instanceof TokenRefreshError && error.status) {
    return `Codex OAuth refresh failed with HTTP ${error.status}. Renew or reseed credentials.`;
  }
  if (error instanceof AuthenticationError) {
    return "Codex authentication failed. Renew or reseed credentials.";
  }
  // Raised by this package's own input validation, so the text is safe to show.
  if (error instanceof CodexCloudError) {
    return error.message;
  }
  if (name === "start_task" || name === "start_environment_setup") {
    return "Task creation failed or its result was lost. Check list_tasks before starting another task.";
  }
  if (name === "follow_up_task") {
    return "Follow-up failed or its result was lost. Check list_task_turns before submitting it again.";
  }
  return "Codex Cloud operation failed. Check the inputs and retry.";
}
