import { describe, expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import { HttpClient } from "../src/http.js";
import { TasksApi } from "../src/tasks.js";
import { MemoryTokenStore } from "../src/token-store.js";

describe("TasksApi", () => {
  test("creates a best-of-N task using the verified body", async () => {
    let body: unknown;
    const api = makeApi(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ task: { id: "task-1" } });
    });

    const task = await api.create({
      environmentId: "env-1",
      prompt: "Count words",
      branch: "main",
      attempts: 2,
      startingDiff: "diff --git a/a b/a",
    });

    expect(task).toEqual({
      id: "task-1",
      url: "https://chatgpt.com/codex/tasks/task-1",
    });
    expect(body).toEqual({
      new_task: {
        environment_id: "env-1",
        branch: "main",
        run_environment_in_qa_mode: false,
      },
      input_items: [
        {
          type: "message",
          role: "user",
          content: [{ content_type: "text", text: "Count words" }],
        },
        {
          type: "pre_apply_patch",
          output_diff: { diff: "diff --git a/a b/a" },
        },
      ],
      metadata: { best_of_n: 2 },
    });
  });

  test("maps task lists and query parameters", async () => {
    let url = "";
    const api = makeApi(async (input) => {
      url = String(input);
      return Response.json({
        items: [
          {
            id: "task-1",
            title: "Test",
            updated_at: 2,
            pull_requests: [{}],
            task_status_display: {
              environment_label: "Env",
              latest_turn_status_display: {
                turn_status: "completed",
                sibling_turn_ids: ["other"],
                diff_stats: {
                  files_modified: 1,
                  lines_added: 2,
                  lines_removed: 3,
                },
              },
            },
          },
        ],
        cursor: "next",
      });
    });

    const page = await api.list({
      environmentId: "env-1",
      limit: 5,
      cursor: "before",
    });

    expect(url).toContain(
      "limit=5&task_filter=current&cursor=before&environment_id=env-1",
    );
    expect(page).toMatchObject({
      cursor: "next",
      tasks: [
        {
          id: "task-1",
          status: "completed",
          environmentLabel: "Env",
          diffStats: { filesChanged: 1, linesAdded: 2, linesRemoved: 3 },
          isReview: true,
          attemptCount: 2,
        },
      ],
    });
  });

  test("extracts task text, errors, and diffs", async () => {
    const api = makeApi(async () => Response.json(taskDetails("completed")));

    const task = await api.get("task-1");

    expect(task).toMatchObject({
      id: "task-1",
      title: "Count words",
      environmentId: "env-1",
      status: "completed",
      prompt: "Count README words",
      messages: ["232 words"],
      diff: "diff --git a/a b/a",
      turnId: "turn-1",
      siblingTurnIds: ["turn-2"],
      attemptPlacement: 0,
    });
  });

  test("cancels a task with an empty request body", async () => {
    let url = "";
    let method = "";
    let body: unknown;
    const api = makeApi(async (input, init) => {
      url = String(input);
      method = init?.method ?? "";
      body = init?.body;
      return new Response(null, { status: 204 });
    });

    expect(await api.cancel("task/1")).toEqual({
      id: "task/1",
      cancelled: true,
    });
    expect(url).toEndWith("/wham/tasks/task%2F1/cancel");
    expect(method).toBe("POST");
    expect(body).toBeUndefined();
  });

  test("rejects limits outside the backend range", async () => {
    const api = makeApi(async () => Response.json({ items: [], cursor: null }));

    expect(api.list({ limit: 21 })).rejects.toThrow("between 1 and 20");
  });

  test("waits until a task reaches a terminal state", async () => {
    let requests = 0;
    const api = makeApi(async () => {
      requests += 1;
      return Response.json(
        taskDetails(requests === 1 ? "in_progress" : "completed"),
      );
    });

    const task = await api.waitFor("task-1", {
      intervalMs: 0,
      timeoutMs: 2000,
    });

    expect(task.status).toBe("completed");
    expect(requests).toBe(2);
  });
});

function makeApi(
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): TasksApi {
  const auth = new AuthController({
    tokenStore: new MemoryTokenStore({ accessToken: "access" }),
    fetch,
  });
  return new TasksApi(new HttpClient({ auth, fetch }));
}

function taskDetails(status: string): object {
  return {
    task: { id: "task-1", title: "Count words", environment_id: "env-1" },
    current_user_turn: {
      input_items: [
        {
          type: "message",
          role: "user",
          content: [{ content_type: "text", text: "Count README words" }],
        },
      ],
    },
    current_assistant_turn: {
      id: "turn-1",
      turn_status: status,
      sibling_turn_ids: ["turn-2"],
      attempt_placement: 0,
      output_items: [
        {
          type: "message",
          content: [{ content_type: "text", text: "232 words" }],
        },
      ],
    },
    current_diff_task_turn: {
      output_items: [{ type: "output_diff", diff: "diff --git a/a b/a" }],
    },
  };
}

test("waitFor aborts a stalled task request at the deadline", async () => {
  let aborted = false;
  const api = makeApi(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal?.reason);
          },
          { once: true },
        );
      }),
  );
  await expect(api.waitFor("task", { timeoutMs: 10 })).rejects.toThrow();
  expect(aborted).toBe(true);
});

test("waitFor deadline does not wait for a stalled OAuth refresh", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.sig`;
  const auth = new AuthController({
    tokenStore: new MemoryTokenStore({
      accessToken: token,
      refreshToken: "refresh",
    }),
    fetch: async () => new Promise<Response>(() => {}),
  });
  const api = new TasksApi(
    new HttpClient({ auth, fetch: async () => Response.json({}) }),
  );
  await expect(api.waitFor("task", { timeoutMs: 10 })).rejects.toThrow();
});

test("waitFor deadline bounds transports that cannot cancel their underlying RPC", async () => {
  // Regression: AbortSignal.timeout does not fire while such a request is
  // outstanding, so waitFor must drive its deadline from an explicit timer.
  const api = makeApi(async () => new Promise<Response>(() => {}));
  await expect(api.waitFor("task", { timeoutMs: 10 })).rejects.toThrow(
    /Timed out/,
  );
});

test("waitFor deadline bounds a stalled response body", async () => {
  const api = makeApi(async () => new Response(new ReadableStream()));
  await expect(api.waitFor("task", { timeoutMs: 10 })).rejects.toThrow();
});
