import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { CodexCloudClient } from "./client.js";
import type { RepositoryId } from "./environments.js";
import {
  ApiError,
  AuthenticationError,
  CodexCloudError,
  TokenRefreshError,
} from "./errors.js";

const id = z.string().trim().min(1);
const repositoryIdError =
  "Repository ID must be a string in github-NUMERIC_ID format, for example github-23123123";
const repository = z
  .string({ error: repositoryIdError })
  .regex(/^github-\d+$/, repositoryIdError) as z.ZodType<RepositoryId>;
const repositories = z
  .array(repository)
  .min(1)
  .describe(
    "GitHub repository IDs in github-NUMERIC_ID format. If you only know owner/repo, resolve its numeric ID first using the GitHub API, gh CLI, or another GitHub tool.",
  );
const strings = z.record(z.string(), z.string());
const update = z.strictObject({
  label: id.optional(),
  repositories: repositories.optional(),
  machineId: id.optional(),
  description: z.string().nullable().optional(),
  workspaceDirectory: z.string().nullable().optional(),
  setupScript: z
    .string()
    .describe(
      "Script used to initialize an uncached environment. Set autoSetupEnabled to false for this script to run.",
    )
    .optional(),
  maintenanceScript: z
    .string()
    .describe(
      "Optional script run after the task branch is checked out when a cached container resumes. Use it to update dependencies installed by an older setup run. Set autoSetupEnabled to false for this script to run.",
    )
    .optional(),
  environmentVariables: strings.optional(),
  secrets: strings.optional(),
  networkAccess: z
    .union([
      z.literal("unrestricted"),
      z.strictObject({
        mode: id,
        presetAllowlist: z.string().nullable().optional(),
        allowlistDomains: z.string().nullable().optional(),
        allowlistRules: z.unknown().optional(),
        denylistDomains: z.string().nullable().optional(),
        safeMethodsOnly: z.boolean().nullable().optional(),
      }),
    ])
    .nullable()
    .optional(),
  autoSetupEnabled: z
    .boolean()
    .describe(
      "Use Codex automatic dependency setup. When true, custom setup and maintenance scripts are ignored. Set false to use those scripts.",
    )
    .optional(),
  cache: z
    .strictObject({
      postSetupCacheEnabled: z.boolean(),
      cacheInvalidationKey: z.string().optional(),
    })
    .optional(),
  dockerInDockerEnabled: z.boolean().optional(),
});

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
    "List Codex Cloud environments.",
    {},
    true,
    (_, signal) => client.environments.list({ signal }),
  );
  tool(
    "get_environment",
    "Get an environment including setup and maintenance scripts, environment variables, and configured secret names.",
    { id },
    true,
    (a, signal) => client.environments.get(a.id, { signal }),
  );
  tool(
    "test_environment",
    "Run the current Codex Cloud environment configuration and return its setup logs after the test finishes.",
    { id },
    false,
    (a, signal) => client.environments.test(a.id, { signal }),
  );
  tool(
    "list_environments_by_repository",
    "List environments associated with a repository.",
    { owner: id, repository: id, provider: id.optional() },
    true,
    (a, signal) =>
      client.environments.listByRepository(a.owner, a.repository, {
        signal,
        ...(a.provider ? { provider: a.provider } : {}),
      }),
  );
  tool(
    "create_environment",
    "Create an environment using repository IDs in github-NUMERIC_ID format. If only owner/repo is known, first look up its numeric ID with the GitHub API, gh CLI, or another GitHub tool.",
    { label: id, repositories, machineId: id.optional() },
    false,
    (a, signal) => client.environments.create(defined(a), { signal }),
  );
  tool(
    "update_environment",
    "Update environment settings. Provided scripts and maps replace their current values; omitted fields are preserved. Automatic setup ignores custom setup and maintenance scripts, so set autoSetupEnabled to false when using either script.",
    { id, update },
    false,
    (a, signal) =>
      client.environments.update(a.id, defined(a.update), { signal }),
  );
  tool(
    "list_tasks",
    "List tasks with cursor pagination (maximum 20 per page).",
    {
      environmentId: id.optional(),
      limit: z.number().int().min(1).max(20).optional(),
      cursor: id.optional(),
      taskFilter: id.optional(),
    },
    true,
    (a, signal) => client.tasks.list({ ...defined(a), signal }),
  );
  tool(
    "start_task",
    "Start a Codex Cloud task. This consumes account usage.",
    {
      environmentId: id,
      prompt: z
        .string()
        .refine((value) => value.trim().length > 0, "Prompt must not be empty"),
      branch: id.optional(),
      attempts: z.number().int().min(1).max(4).optional(),
      qaMode: z.boolean().optional(),
      startingDiff: z.string().optional(),
    },
    false,
    (a, signal) => client.tasks.create(defined(a), { signal }),
  );
  tool(
    "get_task",
    "Get task status, messages, diff, and raw details.",
    { id },
    true,
    (a, signal) => client.tasks.get(a.id, { signal }),
  );
  tool(
    "cancel_task",
    "Cancel a running Codex Cloud task. Completed, failed, and already cancelled tasks may reject cancellation.",
    { id },
    false,
    (a, signal) => client.tasks.cancel(a.id, { signal }),
  );
  tool(
    "follow_up_task",
    "Submit a follow-up prompt against an existing task and turn. This consumes account usage.",
    {
      taskId: id,
      turnId: id,
      prompt: z
        .string()
        .refine((value) => value.trim().length > 0, "Prompt must not be empty"),
      qaMode: z.boolean().optional(),
    },
    false,
    (a, signal) => client.tasks.followUp(defined(a), { signal }),
  );
  tool(
    "list_task_turns",
    "Get task conversation turns and their parent/child relationships.",
    { taskId: id },
    true,
    (a, signal) => client.tasks.listTurns(a.taskId, { signal }),
  );
  tool(
    "get_task_logs",
    "Get the logs available for a specific task turn, including setup output.",
    { taskId: id, turnId: id },
    true,
    (a, signal) => client.tasks.getLogs(a.taskId, a.turnId, { signal }),
  );
  tool(
    "list_sibling_turns",
    "List alternative attempts for a task turn.",
    { taskId: id, turnId: id },
    true,
    (a, signal) =>
      client.tasks.listSiblingTurns(a.taskId, a.turnId, { signal }),
  );
  tool(
    "wait_for_task",
    "Wait up to 50 seconds for a task to finish. Poll again if it times out.",
    {
      id,
      intervalMs: z.number().int().min(1000).max(10000).optional(),
      timeoutMs: z.number().int().min(1).max(50000).optional(),
    },
    true,
    (a, signal) =>
      client.tasks.waitFor(a.id, {
        intervalMs: a.intervalMs ?? 2000,
        timeoutMs: a.timeoutMs ?? 45000,
        signal,
      }),
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
    return "Timed out waiting for the task. Poll get_task or wait_for_task again.";
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
  if (name === "start_task") {
    return "Task creation failed or its result was lost. Check list_tasks before starting another task.";
  }
  if (name === "follow_up_task") {
    return "Follow-up failed or its result was lost. Check list_task_turns before submitting it again.";
  }
  return "Codex Cloud operation failed. Check the inputs and retry.";
}
