import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CodexCloudClient } from "./client.js";
import { ApiError, AuthenticationError, TokenRefreshError } from "./errors.js";

const id = z.string().trim().min(1);
const repository = z.union([
  z.number().int().nonnegative(),
  z.templateLiteral(["github-", z.string().regex(/^\d+$/)]),
]);
const repositories = z.array(repository).min(1);
const strings = z.record(z.string(), z.string());
const update = z.strictObject({
  label: id.optional(),
  repositories: repositories.optional(),
  machineId: id.optional(),
  description: z.string().nullable().optional(),
  workspaceDirectory: z.string().nullable().optional(),
  setupScript: z.string().optional(),
  maintenanceScript: z.string().optional(),
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
  autoSetupEnabled: z.boolean().optional(),
  cache: z
    .strictObject({
      postSetupCacheEnabled: z.boolean(),
      cacheInvalidationKey: z.string().optional(),
    })
    .optional(),
  dockerInDockerEnabled: z.boolean().optional(),
});

export function createMcpServer(client: CodexCloudClient): McpServer {
  const server = new McpServer({ name: "mcp-server-codex-cloud", version: "0.1.0" });
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    run: (input: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<unknown>,
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
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message = toolError(error, name);
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
    );
  }
  tool("list_environments", "List Codex Cloud environments.", {}, true, (_, signal) =>
    client.environments.list({ signal }),
  );
  tool(
    "get_environment",
    "Get an environment including setup and maintenance scripts.",
    { id },
    true,
    (a, signal) => client.environments.get(a.id, { signal }),
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
    "Create an environment using numeric GitHub repository IDs.",
    { label: id, repositories, machineId: id.optional() },
    false,
    (a, signal) => client.environments.create(defined(a), { signal }),
  );
  tool(
    "update_environment",
    "Update environment settings. Provided scripts and maps replace their current values; omitted fields are preserved.",
    { id, update },
    false,
    (a, signal) => client.environments.update(a.id, defined(a.update), { signal }),
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
      prompt: z.string().refine((value) => value.trim().length > 0, "Prompt must not be empty"),
      branch: id.optional(),
      attempts: z.number().int().min(1).max(4).optional(),
      qaMode: z.boolean().optional(),
      startingDiff: z.string().optional(),
    },
    false,
    (a, signal) => client.tasks.create(defined(a), { signal }),
  );
  tool("get_task", "Get task status, messages, diff, and raw details.", { id }, true, (a, signal) =>
    client.tasks.get(a.id, { signal }),
  );
  tool(
    "follow_up_task",
    "Submit a follow-up prompt against an existing task and turn. This consumes account usage.",
    {
      taskId: id,
      turnId: id,
      prompt: z.string().refine((value) => value.trim().length > 0, "Prompt must not be empty"),
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
    (a, signal) => client.tasks.listSiblingTurns(a.taskId, a.turnId, { signal }),
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

// Zod optional fields include undefined; SDK inputs require omitted optional properties.
type Defined<T> = T extends object ? { [K in keyof T]: Defined<Exclude<T[K], undefined>> } : T;

function defined<T>(value: T): Defined<T> {
  return JSON.parse(JSON.stringify(value));
}

function toolError(error: unknown, name: string): string {
  if (name === "wait_for_task" && error instanceof DOMException && error.name === "TimeoutError") {
    return "Timed out waiting for the task. Poll get_task or wait_for_task again.";
  }
  if (error instanceof ApiError) return `Codex Cloud returned HTTP ${error.status}`;
  if (error instanceof TokenRefreshError && error.status) {
    return `Codex OAuth refresh failed with HTTP ${error.status}. Renew or reseed credentials.`;
  }
  if (error instanceof AuthenticationError)
    return "Codex authentication failed. Renew or reseed credentials.";
  if (name === "start_task")
    return "Task creation failed or its result was lost. Check list_tasks before starting another task.";
  if (name === "follow_up_task")
    return "Follow-up failed or its result was lost. Check list_task_turns before submitting it again.";
  return "Codex Cloud operation failed. Check the inputs and retry.";
}
