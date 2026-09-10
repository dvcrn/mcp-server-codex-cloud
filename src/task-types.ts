/**
 * Domain models for Codex Cloud tasks.
 *
 * Kept separate from the API client and the wire mappers so both can depend on
 * the shared vocabulary without depending on each other.
 */

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

export interface CancelledTask {
  id: string;
  cancelled: true;
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
