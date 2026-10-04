import type {
  PageOptions,
  RequestOptions,
  Thread,
  Turn,
} from "./cloud-types.js";

export interface CreateTaskInput {
  environmentConfigId: string;
  prompt: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  cwd?: string;
}

export interface FollowUpTaskInput {
  threadId: string;
  prompt: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
}

export interface SetupEnvironmentInput {
  name?: string;
  environmentConfigId: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
}

export interface CreatedTask {
  thread: Thread;
  turn: Turn;
}

export type ArchiveTaskResult =
  | { threadId: string; status: "archived" }
  | { threadId: string; status: "skipped"; reason: "active_turn" }
  | { threadId: string; status: "failed"; error: string };

export interface ListTurnsOptions extends PageOptions {
  sortDirection?: "asc" | "desc";
  itemsView?: "notLoaded" | "summary" | "full";
}

export interface WaitForTurnOptions extends RequestOptions {
  intervalMs?: number;
  timeoutMs?: number;
}
