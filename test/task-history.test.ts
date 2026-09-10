import { expect, test } from "bun:test";
import { CodexCloudClient } from "../src/client.js";

function client(
  response: unknown,
  requests: { url: string; body: unknown }[] = [],
) {
  return new CodexCloudClient({
    tokens: { accessToken: "test" },
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(response);
    },
  });
}

test("follow-up uses an existing turn and returns the newly created turn IDs", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sdk = client(
    {
      task: { id: "task" },
      user_turn: { id: "new-user" },
      turn: { id: "new-assistant" },
    },
    requests,
  );
  expect(
    await sdk.tasks.followUp({
      taskId: "task",
      turnId: "previous",
      prompt: "Continue",
      qaMode: true,
    }),
  ).toEqual({
    id: "task",
    url: "https://chatgpt.com/codex/tasks/task",
    turnId: "new-assistant",
    userTurnId: "new-user",
  });
  expect(requests).toEqual([
    {
      url: "https://chatgpt.com/backend-api/wham/tasks",
      body: {
        follow_up: {
          task_id: "task",
          turn_id: "previous",
          run_environment_in_qa_mode: true,
        },
        input_items: [
          {
            type: "message",
            role: "user",
            content: [{ content_type: "text", text: "Continue" }],
          },
        ],
      },
    },
  ]);
});

test("follow-up rejects missing IDs, empty prompts and incomplete responses", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sdk = client({}, requests);
  for (const input of [
    { taskId: "", turnId: "turn", prompt: "hi" },
    { taskId: "task", turnId: " ", prompt: "hi" },
    { taskId: "task", turnId: "turn", prompt: " " },
  ]) {
    await expect(sdk.tasks.followUp(input)).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  await expect(
    sdk.tasks.followUp({ taskId: "task", turnId: "turn", prompt: "hi" }),
  ).rejects.toThrow("expected task and turn IDs");
  const wrong = client({
    task: { id: "other" },
    user_turn: { id: "user" },
    turn: { id: "assistant" },
  });
  await expect(
    wrong.tasks.followUp({ taskId: "task", turnId: "turn", prompt: "hi" }),
  ).rejects.toThrow("expected task and turn IDs");
});

test("history preserves branches and messages without returning embedded environment data", async () => {
  const sdk = client({
    current_turn_id: "assistant-b",
    turn_mapping: {
      user: {
        id: "user",
        parent: null,
        children: ["assistant-a", "assistant-b"],
        turn: {
          id: "user",
          role: "user",
          created_at: 1,
          input_items: [
            {
              type: "message",
              role: "user",
              content: [{ content_type: "text", text: "Question" }],
            },
          ],
        },
      },
      "assistant-a": {
        id: "assistant-a",
        parent: "user",
        children: [],
        turn: {
          id: "assistant-a",
          role: "assistant",
          turn_status: "completed",
          environment_id: "env",
          environment: { secrets: { secret: "private-fixture" } },
          output_items: [
            {
              type: "message",
              content: [{ content_type: "text", text: "Answer A" }],
            },
          ],
        },
      },
      "assistant-b": {
        id: "assistant-b",
        parent: "user",
        children: [],
        turn: {
          id: "assistant-b",
          role: "assistant",
          turn_status: "in_progress",
          sibling_turn_ids: ["assistant-a"],
          attempt_placement: 1,
        },
      },
    },
  });
  const history = await sdk.tasks.listTurns("task");
  expect(history.currentTurnId).toBe("assistant-b");
  expect(history.turns).toHaveLength(3);
  expect(history.turns[0]).toMatchObject({
    id: "user",
    status: null,
    parentId: null,
    childIds: ["assistant-a", "assistant-b"],
    messages: ["Question"],
  });
  expect(history.turns[1]).toMatchObject({
    id: "assistant-a",
    parentId: "user",
    messages: ["Answer A"],
    environmentId: "env",
  });
  expect(history.turns[2]).toMatchObject({
    id: "assistant-b",
    status: "in_progress",
    attemptPlacement: 1,
  });
  expect(JSON.stringify(history)).not.toContain("private-fixture");
});

test("logs preserve ordering, blank lines and timestamps without inventing a timezone", async () => {
  const key = {
    name: "setup",
    type: "UserSetupScript",
    created_at: "2026-09-07T03:18:07.481184",
  };
  const requests: { url: string; body: unknown }[] = [];
  const sdk = client(
    {
      logs: [
        { key, line: "first\nsecond" },
        { key, line: "" },
      ],
    },
    requests,
  );
  const logs = await sdk.tasks.getLogs("task/a", "task/a~turn?b");
  expect(logs).toEqual([
    {
      name: "setup",
      type: "UserSetupScript",
      createdAt: key.created_at,
      line: "first\nsecond",
    },
    {
      name: "setup",
      type: "UserSetupScript",
      createdAt: key.created_at,
      line: "",
    },
  ]);
  expect(requests[0]?.url).toBe(
    "https://chatgpt.com/backend-api/wham/tasks/task%2Fa/turns/task%2Fa~turn%3Fb/logs",
  );
});

test("history and log APIs distinguish empty responses from malformed responses", async () => {
  expect(
    await client({ current_turn_id: null, turn_mapping: {} }).tasks.listTurns(
      "task",
    ),
  ).toEqual({ currentTurnId: null, turns: [] });
  expect(await client({ logs: [] }).tasks.getLogs("task", "turn")).toEqual([]);
  await expect(client({}).tasks.listTurns("task")).rejects.toThrow(
    "Invalid task history response",
  );
  await expect(
    client({ logs: [{ line: "missing key" }] }).tasks.getLogs("task", "turn"),
  ).rejects.toThrow("Invalid task logs response");
});

test("task details use the active turn environment, with a legacy fallback", async () => {
  const sdk = client({
    task: { id: "task", environment_id: "old" },
    current_assistant_turn: { environment_id: "current" },
  });
  expect((await sdk.tasks.get("task")).environmentId).toBe("current");
  expect(
    (await client({ task: { environment_id: "legacy" } }).tasks.get("task"))
      .environmentId,
  ).toBe("legacy");
});

test("aborting a follow-up does not retry a request whose outcome is unknown", async () => {
  let calls = 0;
  const abort = new AbortController();
  const sdk = new CodexCloudClient({
    tokens: { accessToken: "test" },
    fetch: async () => {
      calls++;
      abort.abort(new Error("Caller canceled"));
      return new Promise(() => {});
    },
  });
  const signal = abort.signal;
  await expect(
    sdk.tasks.followUp(
      { taskId: "task", turnId: "turn", prompt: "hello" },
      { signal },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
