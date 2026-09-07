import { z } from "zod";
import { CodexCloudError } from "./errors.js";
import type {
  TaskAttempt,
  TaskDetails,
  TaskHistory,
  TaskLogEntry,
  TaskStatus,
  TaskSummary,
  TaskTurn,
} from "./task-types.js";

export interface TaskListItemWire {
  id: string;
  title?: string;
  updated_at?: number;
  pull_requests?: unknown[] | null;
  task_status_display?: Record<string, unknown> | null;
}

const historySchema = z.object({
  current_turn_id: z.string().nullable(),
  turn_mapping: z.record(
    z.string(),
    z.object({
      id: z.string().min(1),
      parent: z.string().nullable(),
      children: z.array(z.string()),
      turn: z.record(z.string(), z.unknown()),
    }),
  ),
});
const logsSchema = z.object({
  logs: z.array(
    z.object({
      key: z.object({ name: z.string(), type: z.string(), created_at: z.string() }),
      line: z.string(),
    }),
  ),
});

export function mapTaskHistory(value: unknown): TaskHistory {
  const parsed = historySchema.safeParse(value);
  if (!parsed.success) throw new CodexCloudError("Invalid task history response");
  const turns: TaskTurn[] = Object.values(parsed.data.turn_mapping).map((node) => {
    const turn = node.turn;
    const prompt = userPrompt(turn);
    const attempt = mapAttempt(turn);
    return {
      ...attempt,
      id: node.id,
      parentId: node.parent,
      childIds: node.children,
      role: string(turn.role) ?? null,
      status: turn.turn_status === undefined ? null : attempt.status,
      environmentId: string(turn.environment_id) ?? null,
      messages: turn.role === "user" ? (prompt ? [prompt] : []) : attempt.messages,
    };
  });
  return { currentTurnId: parsed.data.current_turn_id, turns };
}

export function mapTaskLogs(value: unknown): TaskLogEntry[] {
  const parsed = logsSchema.safeParse(value);
  if (!parsed.success) throw new CodexCloudError("Invalid task logs response");
  return parsed.data.logs.map(({ key, line }) => ({
    name: key.name,
    type: key.type,
    createdAt: key.created_at,
    line,
  }));
}

export function mapTaskSummary(wire: TaskListItemWire): TaskSummary {
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

export function mapTaskDetails(id: string, wire: Record<string, unknown>): TaskDetails {
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
    environmentId: string(active?.environment_id) ?? string(task?.environment_id) ?? null,
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

export function mapAttempt(wire: Record<string, unknown>): TaskAttempt {
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
