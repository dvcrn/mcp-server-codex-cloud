import { CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";
import {
  mapAttempt,
  mapTaskDetails,
  mapTaskHistory,
  mapTaskLogs,
  mapTaskSummary,
  type TaskListItemWire,
} from "./task-mappers.js";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "ready"
  | "applied"
  | "error"
  | "unknown";

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  updatedAt: Date | null;
  environmentLabel: string | null;
  diffStats: DiffStats;
  isReview: boolean;
  attemptCount: number | null;
}

export interface TaskPage {
  tasks: TaskSummary[];
  cursor: string | null;
}

export interface ListTasksOptions {
  environmentId?: string;
  limit?: number;
  cursor?: string;
  taskFilter?: string;
  signal?: AbortSignal;
}

export interface CreateTaskInput {
  environmentId: string;
  prompt: string;
  branch?: string;
  attempts?: number;
  qaMode?: boolean;
  startingDiff?: string;
}

export interface CreatedTask {
  id: string;
  url: string;
}

export interface FollowUpTaskInput {
  taskId: string;
  turnId: string;
  prompt: string;
  /** Whether to run the environment in QA mode. @default false */
  qaMode?: boolean;
}

export interface CreatedTaskTurn extends CreatedTask {
  turnId: string;
  userTurnId: string;
}

export interface TaskTurn extends Omit<TaskAttempt, "status"> {
  status: TaskStatus | null;
  parentId: string | null;
  childIds: string[];
  role: string | null;
  environmentId: string | null;
}

export interface TaskHistory {
  currentTurnId: string | null;
  turns: TaskTurn[];
}

export interface TaskLogEntry {
  name: string;
  type: string;
  /** Upstream timestamp, preserved because it has no timezone offset. */
  createdAt: string;
  line: string;
}

export interface TaskError {
  code: string | null;
  message: string | null;
}

export interface TaskDetails {
  id: string;
  title: string | null;
  environmentId: string | null;
  status: TaskStatus;
  prompt: string | null;
  messages: string[];
  diff: string | null;
  turnId: string | null;
  siblingTurnIds: string[];
  attemptPlacement: number | null;
  error: TaskError | null;
  raw: Record<string, unknown>;
}

export interface TaskAttempt {
  id: string;
  status: TaskStatus;
  attemptPlacement: number | null;
  createdAt: Date | null;
  messages: string[];
  diff: string | null;
}

export interface WaitForTaskOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class TasksApi {
  public constructor(private readonly http: HttpClient) {}

  public async list(options: ListTasksOptions = {}): Promise<TaskPage> {
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20)
    ) {
      throw new CodexCloudError("Task list limit must be an integer between 1 and 20");
    }
    const response = await this.http.request<TaskListWire>("/tasks/list", {
      query: {
        limit: options.limit,
        task_filter: options.taskFilter ?? "current",
        cursor: options.cursor,
        environment_id: options.environmentId,
      },
      signal: options.signal,
    });
    return {
      tasks: (response.items ?? []).map(mapTaskSummary),
      cursor: response.cursor ?? null,
    };
  }

  public async create(
    input: CreateTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CreatedTask> {
    if (!input.environmentId.trim()) throw new CodexCloudError("Environment ID must not be empty");
    if (!input.prompt.trim()) throw new CodexCloudError("Task prompt must not be empty");
    const attempts = input.attempts ?? 1;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
      throw new CodexCloudError("Task attempts must be an integer between 1 and 4");
    }

    const inputItems: unknown[] = [
      {
        type: "message",
        role: "user",
        content: [{ content_type: "text", text: input.prompt }],
      },
    ];
    if (input.startingDiff) {
      inputItems.push({ type: "pre_apply_patch", output_diff: { diff: input.startingDiff } });
    }
    const body: Record<string, unknown> = {
      new_task: {
        environment_id: input.environmentId,
        branch: input.branch ?? "main",
        run_environment_in_qa_mode: input.qaMode ?? false,
      },
      input_items: inputItems,
    };
    if (attempts > 1) body.metadata = { best_of_n: attempts };

    const response = await this.http.request<CreateTaskResponseWire>("/tasks", {
      method: "POST",
      body,
      signal: options.signal,
    });
    const id = response.task?.id ?? response.id;
    if (!id) throw new CodexCloudError("Create-task response did not contain a task ID");
    return { id, url: taskUrl(this.http.baseUrl, id) };
  }

  public async get(id: string, options: { signal?: AbortSignal } = {}): Promise<TaskDetails> {
    const response = await this.http.request<Record<string, unknown>>(`/tasks/${segment(id)}`, {
      signal: options.signal,
    });
    return mapTaskDetails(id, response);
  }

  public async followUp(
    input: FollowUpTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CreatedTaskTurn> {
    segment(input.taskId);
    segment(input.turnId);
    if (!input.prompt.trim()) throw new CodexCloudError("Prompt must not be empty");
    const response = await this.http.request<{
      task?: { id?: string };
      turn?: { id?: string };
      user_turn?: { id?: string };
    }>("/tasks", {
      method: "POST",
      signal: options.signal,
      body: {
        follow_up: {
          task_id: input.taskId,
          turn_id: input.turnId,
          run_environment_in_qa_mode: input.qaMode ?? false,
        },
        input_items: [
          {
            type: "message",
            role: "user",
            content: [{ content_type: "text", text: input.prompt }],
          },
        ],
      },
    });
    const turnId = response?.turn?.id;
    const userTurnId = response?.user_turn?.id;
    if (
      response?.task?.id !== input.taskId ||
      typeof turnId !== "string" ||
      !turnId ||
      typeof userTurnId !== "string" ||
      !userTurnId
    )
      throw new CodexCloudError(
        "Follow-up response did not contain the expected task and turn IDs",
      );
    return { id: input.taskId, url: taskUrl(this.http.baseUrl, input.taskId), turnId, userTurnId };
  }

  public async listTurns(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskHistory> {
    return mapTaskHistory(
      await this.http.request<unknown>(`/tasks/${segment(taskId)}/turns`, options),
    );
  }

  public async getLogs(
    taskId: string,
    turnId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskLogEntry[]> {
    return mapTaskLogs(
      await this.http.request<unknown>(
        `/tasks/${segment(taskId)}/turns/${segment(turnId)}/logs`,
        options,
      ),
    );
  }

  public async listSiblingTurns(
    taskId: string,
    turnId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskAttempt[]> {
    const response = await this.http.request<SiblingTurnsWire>(
      `/tasks/${segment(taskId)}/turns/${segment(turnId)}/sibling_turns`,
      { signal: options.signal },
    );
    return (response.sibling_turns ?? []).map(mapAttempt).sort(compareAttempts);
  }

  public async waitFor(id: string, options: WaitForTaskOptions = {}): Promise<TaskDetails> {
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    if (intervalMs < 0 || timeoutMs < 0) {
      throw new CodexCloudError("Polling interval and timeout must not be negative");
    }
    const deadline = Date.now() + timeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new DOMException("Task wait timed out", "TimeoutError")),
      timeoutMs,
    );
    const timeoutSignal = timeoutController.signal;
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      for (;;) {
        const task = await this.get(id, { signal });
        if (isTerminal(task.status)) return task;
        if (Date.now() >= deadline)
          throw new DOMException(`Timed out waiting for task ${id}`, "TimeoutError");
        await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TaskListWire {
  items?: TaskListItemWire[];
  cursor?: string | null;
}

interface CreateTaskResponseWire {
  id?: string;
  task?: { id?: string };
}

interface SiblingTurnsWire {
  sibling_turns?: Record<string, unknown>[];
}

function isTerminal(status: TaskStatus): boolean {
  return ["completed", "failed", "cancelled", "ready", "applied", "error"].includes(status);
}

function compareAttempts(left: TaskAttempt, right: TaskAttempt): number {
  if (left.attemptPlacement !== null && right.attemptPlacement !== null) {
    return left.attemptPlacement - right.attemptPlacement;
  }
  if (left.attemptPlacement !== null) return -1;
  if (right.attemptPlacement !== null) return 1;
  return (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
}

function taskUrl(baseUrl: string, id: string): string {
  const root = baseUrl.endsWith("/backend-api")
    ? baseUrl.slice(0, -"/backend-api".length)
    : baseUrl;
  return `${root}/codex/tasks/${encodeURIComponent(id)}`;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function segment(value: string): string {
  if (!value.trim()) throw new CodexCloudError("Task and turn IDs must not be empty");
  return encodeURIComponent(value);
}
