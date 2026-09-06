import { CodexCloudError } from "./errors.js";
import type { HttpClient } from "./http.js";

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

interface TaskListItemWire {
  id: string;
  title?: string;
  updated_at?: number;
  pull_requests?: unknown[] | null;
  task_status_display?: Record<string, unknown> | null;
}

interface CreateTaskResponseWire {
  id?: string;
  task?: { id?: string };
}

interface SiblingTurnsWire {
  sibling_turns?: Record<string, unknown>[];
}

function mapTaskSummary(wire: TaskListItemWire): TaskSummary {
  const display = object(wire.task_status_display);
  const latest = object(display?.latest_turn_status_display);
  const stats = object(latest?.diff_stats);
  const siblings = array(latest?.sibling_turn_ids);
  return {
    id: wire.id,
    title: wire.title ?? "<untitled>",
    status: normalizeStatus(string(latest?.turn_status) ?? string(display?.state)),
    updatedAt: timestamp(
      wire.updated_at ?? number(latest?.updated_at) ?? number(latest?.created_at),
    ),
    environmentLabel: string(display?.environment_label) ?? null,
    diffStats: {
      filesChanged: number(stats?.files_modified) ?? 0,
      linesAdded: number(stats?.lines_added) ?? 0,
      linesRemoved: number(stats?.lines_removed) ?? 0,
    },
    isReview: Array.isArray(wire.pull_requests) && wire.pull_requests.length > 0,
    attemptCount: siblings ? siblings.length + 1 : null,
  };
}

function mapTaskDetails(id: string, wire: Record<string, unknown>): TaskDetails {
  const task = object(wire.task);
  const assistant = object(wire.current_assistant_turn);
  const diffTurn = object(wire.current_diff_task_turn);
  const user = object(wire.current_user_turn);
  const active = assistant ?? diffTurn;
  const display = object(wire.task_status_display) ?? object(task?.task_status_display);
  const latest = object(display?.latest_turn_status_display);
  const messages = [...messagesFromTurn(diffTurn), ...messagesFromTurn(assistant)];
  const fallbackMessages = messages.length === 0 ? worklogMessages(assistant) : [];
  const error = object(active?.error);
  return {
    id: string(task?.id) ?? id,
    title: string(task?.title) ?? null,
    environmentId: string(task?.environment_id) ?? null,
    status: normalizeStatus(
      string(active?.turn_status) ?? string(latest?.turn_status) ?? string(display?.state),
    ),
    prompt: userPrompt(user),
    messages: messages.length > 0 ? messages : fallbackMessages,
    diff: diffFromTurn(diffTurn) ?? diffFromTurn(assistant),
    turnId: string(active?.id) ?? null,
    siblingTurnIds: strings(active?.sibling_turn_ids),
    attemptPlacement: number(active?.attempt_placement) ?? null,
    error: error
      ? { code: string(error.code) ?? null, message: string(error.message) ?? null }
      : null,
    raw: wire,
  };
}

function mapAttempt(wire: Record<string, unknown>): TaskAttempt {
  return {
    id: string(wire.id) ?? "",
    status: normalizeStatus(string(wire.turn_status)),
    attemptPlacement: number(wire.attempt_placement) ?? null,
    createdAt: timestamp(number(wire.created_at)),
    messages: messagesFromTurn(wire),
    diff: diffFromTurn(wire),
  };
}

function messagesFromTurn(turn: Record<string, unknown> | undefined): string[] {
  if (!turn) return [];
  const messages: string[] = [];
  for (const item of objects(turn.output_items)) {
    if (item.type !== "message") continue;
    messages.push(...textContent(item.content));
  }
  return messages;
}

function worklogMessages(turn: Record<string, unknown> | undefined): string[] {
  const worklog = object(turn?.worklog);
  const messages: string[] = [];
  for (const item of objects(worklog?.messages)) {
    if (string(object(item.author)?.role) !== "assistant") continue;
    messages.push(...textContent(object(item.content)?.parts));
  }
  return messages;
}

function userPrompt(turn: Record<string, unknown> | undefined): string | null {
  if (!turn) return null;
  for (const item of [...objects(turn.input_items), ...objects(turn.output_items)]) {
    if (item.type === "message" && (item.role === "user" || item.role === undefined)) {
      const text = textContent(item.content);
      if (text.length > 0) return text.join("\n");
    }
  }
  return null;
}

function diffFromTurn(turn: Record<string, unknown> | undefined): string | null {
  if (!turn) return null;
  for (const item of objects(turn.output_items)) {
    if (item.type === "output_diff" && typeof item.diff === "string" && item.diff) return item.diff;
    const outputDiff = object(item.output_diff);
    if (item.type === "pr" && typeof outputDiff?.diff === "string" && outputDiff.diff) {
      return outputDiff.diff;
    }
  }
  return null;
}

function textContent(value: unknown): string[] {
  const output: string[] = [];
  for (const part of array(value) ?? []) {
    if (typeof part === "string" && part.trim()) output.push(part);
    const content = object(part);
    if (content?.content_type === "text" && typeof content.text === "string" && content.text) {
      output.push(content.text);
    }
  }
  return output;
}

function normalizeStatus(value: string | undefined): TaskStatus {
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
    case "cancelled":
    case "ready":
    case "applied":
    case "error":
      return value;
    default:
      return "unknown";
  }
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

function timestamp(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value * 1000);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function objects(value: unknown): Record<string, unknown>[] {
  return (array(value) ?? []).map(object).filter((item) => item !== undefined);
}

function strings(value: unknown): string[] {
  return (array(value) ?? []).filter((item): item is string => typeof item === "string");
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
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
