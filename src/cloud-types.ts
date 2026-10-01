export interface Page<T> {
  data: T[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface PageOptions extends RequestOptions {
  limit?: number;
  cursor?: string;
}

export interface ThreadEnvironment {
  environmentId: string;
  environmentConfigId?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface Thread {
  id: string;
  name?: string | null;
  status: { type: string; [key: string]: unknown };
  environments?: ThreadEnvironment[];
  turns?: Turn[];
  [key: string]: unknown;
}

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  content?: unknown[];
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  status: string;
  items: ThreadItem[];
  error?: unknown;
  [key: string]: unknown;
}

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface Model {
  id: string;
  model: string;
  displayName: string;
  [key: string]: unknown;
}
