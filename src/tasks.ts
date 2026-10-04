import { setTimeout as delay } from "node:timers/promises";
import type {
  Model,
  Page,
  PageOptions,
  RequestOptions,
  RpcNotification,
  Thread,
  ThreadItem,
  Turn,
} from "./cloud-types.js";
import type { CloudEnvironment } from "./environments.js";
import { CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { segment } from "./internal.js";
import type { RpcClient } from "./rpc.js";
import type {
  ArchiveTaskResult,
  CreatedTask,
  CreateTaskInput,
  FollowUpTaskInput,
  ListTurnsOptions,
  SetupEnvironmentInput,
  WaitForTurnOptions,
} from "./task-types.js";

export type * from "./task-types.js";

export class TasksApi {
  public constructor(
    private readonly http: HttpClient,
    private readonly rpc: RpcClient,
  ) {}

  /** Lists cloud conversation threads with cursor pagination. */
  public list(options: PageOptions = {}): Promise<Page<Thread>> {
    return this.http.request("/v1/threads", {
      query: { limit: options.limit ?? 20, cursor: options.cursor },
      signal: options.signal,
    });
  }

  /** Reads thread metadata; use listTurns for populated conversation items. */
  public async get(
    threadId: string,
    options: RequestOptions = {},
  ): Promise<Thread> {
    const response = await this.http.request<{ thread: Thread }>(
      `/v1/threads/${segment(threadId)}`,
      options,
    );
    return response.thread;
  }

  /** Allocates a new cloud thread against a published environment config and starts its first turn. */
  public async create(
    input: CreateTaskInput,
    options: RequestOptions = {},
  ): Promise<CreatedTask> {
    return this.#create(
      input,
      {
        environmentConfigId: input.environmentConfigId,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      },
      options,
    );
  }

  /** Starts the cloud onboarding skill in a durable setup thread for an existing config. */
  public async setupEnvironment(
    input: SetupEnvironmentInput,
    options: RequestOptions = {},
  ): Promise<CreatedTask> {
    if (input.name !== undefined && !input.name.trim()) {
      throw new CodexCloudError("Thread name must not be empty");
    }
    const environment = await this.http.request<CloudEnvironment>(
      `/v1/environment-configs/${segment(input.environmentConfigId)}`,
      options,
    );
    const prompt =
      "Use $cloud-environment-onboarding:setup to set up this cloud environment";
    if (environment.thread_id) {
      return this.followUp(
        { ...input, threadId: environment.thread_id, prompt },
        options,
      );
    }
    const name = input.name ?? `Environment setup: ${environment.name}`;
    return this.#create(
      {
        ...input,
        name,
        prompt,
      },
      { onboardingConfigId: input.environmentConfigId },
      options,
    );
  }

  /** Allocates a durable config-owning editor thread without starting an agent turn. */
  public async startEnvironmentEditingThread(
    environmentConfigId: string,
    options: RequestOptions = {},
  ): Promise<Thread> {
    return this.#startThread(
      { onboardingConfigId: environmentConfigId },
      {},
      options,
    );
  }

  async #startThread(
    environment:
      | { environmentConfigId: string; cwd?: string }
      | { onboardingConfigId: string },
    input: Pick<CreateTaskInput, "model" | "serviceTier">,
    options: RequestOptions,
  ): Promise<Thread> {
    segment(
      "onboardingConfigId" in environment
        ? environment.onboardingConfigId
        : environment.environmentConfigId,
    );
    const response = await this.rpc.request<{ thread: Thread }>(
      "thread/start",
      {
        environments: [environment],
        serviceName: "codex_cloud",
        threadSource: "user",
        deferredEnvironment: true,
        pluginsMcp: { productSku: "codex" },
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.serviceTier === undefined
          ? {}
          : { serviceTier: input.serviceTier }),
      },
      options,
    );
    if (!response.thread?.id) {
      throw new CodexCloudError(
        "Cloud thread creation returned no thread ID; list threads before retrying",
      );
    }
    return response.thread;
  }

  async #create(
    input: Omit<CreateTaskInput, "environmentConfigId"> & { name?: string },
    environment:
      | { environmentConfigId: string; cwd?: string }
      | { onboardingConfigId: string },
    options: RequestOptions,
  ): Promise<CreatedTask> {
    validatePrompt(input.prompt);
    const allocated = await this.#startThread(environment, input, options);
    let turn: Turn;
    try {
      turn = await this.#startTurn(
        { ...input, threadId: allocated.id },
        options,
      );
    } catch (error) {
      // Allocation succeeded even if starting the first turn has an unknown outcome.
      throw new CodexCloudError(
        `Thread ${allocated.id} was created, but its first turn failed or its result was lost. Read its turns before retrying.`,
        { cause: error },
      );
    }
    let thread = allocated;
    if (input.name !== undefined) {
      try {
        await this.rpc.request(
          "thread/name/set",
          { threadId: thread.id, name: input.name },
          options,
        );
        thread = { ...thread, name: input.name };
      } catch {
        // Cosmetic naming failure must not hide a successfully started turn.
      }
    }
    return { thread, turn };
  }

  /** Renames a stored cloud thread without loading its retained environment. */
  public async rename(
    threadId: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<Thread> {
    if (!name.trim()) {
      throw new CodexCloudError("Thread name must not be empty");
    }
    const thread = await this.get(threadId, options);
    await this.rpc.request("thread/name/set", { threadId, name }, options);
    return { ...thread, name };
  }

  /** Archives a stored idle thread without resuming its environment. */
  public async archive(
    threadId: string,
    options: RequestOptions = {},
  ): Promise<{ threadId: string; archived: true }> {
    const { results } = await this.archiveMany([threadId], options);
    const [result] = results;
    if (result?.status === "skipped") {
      throw new CodexCloudError(
        "Thread has an active turn; interrupt it or wait for completion before archiving",
      );
    }
    if (result?.status === "failed") {
      throw new CodexCloudError(result.error);
    }
    return { threadId, archived: true };
  }

  /** Archives distinct idle threads with at most five concurrent operations and reports individual outcomes. */
  public async archiveMany(
    threadIds: string[],
    options: RequestOptions = {},
  ): Promise<{ results: ArchiveTaskResult[] }> {
    if (threadIds.length === 0 || threadIds.length > 500) {
      throw new CodexCloudError("Provide between 1 and 500 thread IDs");
    }
    for (const threadId of threadIds) {
      segment(threadId);
    }
    const ids = [...new Set(threadIds)];
    const results: ArchiveTaskResult[] = [];
    for (let offset = 0; offset < ids.length; offset += 5) {
      options.signal?.throwIfAborted();
      results.push(
        ...(await Promise.all(
          ids
            .slice(offset, offset + 5)
            .map(async (threadId): Promise<ArchiveTaskResult> => {
              try {
                const thread = await this.get(threadId, options);
                if (thread.status?.type === "active") {
                  return { threadId, status: "skipped", reason: "active_turn" };
                }
                await this.rpc.request("thread/archive", { threadId }, options);
                return { threadId, status: "archived" };
              } catch (error) {
                return {
                  threadId,
                  status: "failed",
                  error:
                    error instanceof CodexCloudError
                      ? error.message
                      : "Archive failed or its result was lost. Check list_tasks before retrying.",
                };
              }
            }),
        )),
      );
    }
    return { results };
  }

  /** Restores an archived thread and returns its metadata. */
  public async restore(
    threadId: string,
    options: RequestOptions = {},
  ): Promise<Thread> {
    segment(threadId);
    const response = await this.rpc.request<{ thread: Thread }>(
      "thread/unarchive",
      { threadId },
      options,
    );
    if (response.thread?.id !== threadId) {
      throw new CodexCloudError(
        "Cloud restore returned an unexpected thread ID",
      );
    }
    return response.thread;
  }

  /** Resumes an existing thread and starts a follow-up turn using its retained environment. */
  public async followUp(
    input: FollowUpTaskInput,
    options: RequestOptions = {},
  ): Promise<CreatedTask> {
    validatePrompt(input.prompt);
    const response = await this.resume(input.threadId, options);
    if (response.thread.status?.type === "active") {
      throw new CodexCloudError(
        "Thread has an active turn; use steer with its expected turn ID or wait for completion before following up",
      );
    }
    return {
      thread: response.thread,
      turn: await this.#startTurn(input, options),
    };
  }

  /** Rejoins an existing thread without returning its entire history. */
  public async resume(
    threadId: string,
    options: RequestOptions = {},
  ): Promise<{ thread: Thread; [key: string]: unknown }> {
    segment(threadId);
    const response = await this.rpc.request<{
      thread: Thread;
      [key: string]: unknown;
    }>("thread/resume", { threadId, excludeTurns: true }, options);
    if (response.thread?.id !== threadId) {
      throw new CodexCloudError(
        "Cloud resume returned an unexpected thread ID",
      );
    }
    return response;
  }

  /** Adds input to a specific active turn using an expected-turn precondition. */
  public async steer(
    input: { threadId: string; expectedTurnId: string; prompt: string },
    options: RequestOptions = {},
  ): Promise<{ turnId: string }> {
    segment(input.expectedTurnId);
    validatePrompt(input.prompt);
    await this.resume(input.threadId, options);
    return this.rpc.request(
      "turn/steer",
      {
        threadId: input.threadId,
        expectedTurnId: input.expectedTurnId,
        input: textInput(input.prompt),
      },
      options,
    );
  }

  /** Requests interruption of the identified turn without affecting other threads. */
  public async cancel(
    threadId: string,
    turnId: string,
    options: RequestOptions = {},
  ): Promise<{ threadId: string; turnId: string; interruptRequested: true }> {
    segment(turnId);
    await this.resume(threadId, options);
    await this.rpc.request("turn/interrupt", { threadId, turnId }, options);
    return { threadId, turnId, interruptRequested: true };
  }

  /** Reads a paginated turn history with explicit item hydration. */
  public listTurns(
    threadId: string,
    options: ListTurnsOptions = {},
  ): Promise<Page<Turn>> {
    return this.http.request(`/v2/threads/${segment(threadId)}/turns`, {
      query: {
        limit: options.limit ?? 20,
        cursor: options.cursor,
        sortDirection: options.sortDirection ?? "desc",
        itemsView: options.itemsView ?? "full",
      },
      signal: options.signal,
    });
  }

  /** Reads paginated persisted items, including tool output and file-change items. */
  public listItems(
    threadId: string,
    options: PageOptions & {
      turnId?: string;
      sortDirection?: "asc" | "desc";
    } = {},
  ): Promise<Page<ThreadItem>> {
    return this.http.request(`/v2/threads/${segment(threadId)}/items`, {
      query: {
        limit: options.limit ?? 20,
        cursor: options.cursor,
        turnId: options.turnId,
        sortDirection: options.sortDirection ?? "desc",
      },
      signal: options.signal,
    });
  }

  /** Waits for the specified persisted turn, never an unrelated or previously completed turn. */
  public async waitFor(
    threadId: string,
    turnId: string,
    options: WaitForTurnOptions = {},
  ): Promise<Turn> {
    segment(threadId);
    segment(turnId);
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 45_000;
    if (intervalMs < 1 || timeoutMs < 1) {
      throw new CodexCloudError(
        "Polling interval and timeout must be positive",
      );
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    for (;;) {
      let cursor: string | undefined;
      let found: Turn | undefined;
      do {
        const page = await this.listTurns(threadId, {
          limit: 100,
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
          signal,
        });
        found = page.data.find((turn) => turn.id === turnId);
        cursor = page.nextCursor ?? undefined;
      } while (!found && cursor);
      if (
        found
        && ["completed", "interrupted", "failed"].includes(found.status)
      ) {
        return found;
      }
      await delay(intervalMs, undefined, { signal });
    }
  }

  /** Observes live socket events and restricts delivery to the selected thread. */
  public subscribe(
    threadId: string,
    listener: (event: RpcNotification) => void,
  ): () => void {
    segment(threadId);
    return this.rpc.subscribe((event) => {
      const params = event.params;
      if (
        params?.threadId === threadId
        || (params?.thread as Thread | undefined)?.id === threadId
      ) {
        listener(event);
      }
    });
  }

  /** Lists models with their current reasoning and service-tier choices. */
  public listModels(
    options: PageOptions & { includeHidden?: boolean } = {},
  ): Promise<Page<Model>> {
    return this.http.request("/v2/models", {
      query: {
        limit: options.limit ?? 100,
        cursor: options.cursor,
        includeHidden: options.includeHidden ?? false,
      },
      signal: options.signal,
    });
  }

  /** Reads supported collaboration modes from the backend. */
  public listCollaborationModes(
    options: RequestOptions = {},
  ): Promise<{ data: Record<string, unknown>[] }> {
    return this.http.request("/v2/collaboration-modes", options);
  }

  async #startTurn(
    input: FollowUpTaskInput,
    options: RequestOptions,
  ): Promise<Turn> {
    const response = await this.rpc.request<{ turn: Turn }>(
      "turn/start",
      {
        threadId: input.threadId,
        input: textInput(input.prompt),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.serviceTier === undefined
          ? {}
          : { serviceTier: input.serviceTier }),
      },
      options,
    );
    if (!response.turn?.id) {
      throw new CodexCloudError(
        "Cloud turn response contained no turn ID; read history before retrying",
      );
    }
    return response.turn;
  }
}

function textInput(prompt: string): unknown[] {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function validatePrompt(prompt: string): void {
  if (!prompt.trim()) {
    throw new CodexCloudError("Prompt must not be empty");
  }
}
