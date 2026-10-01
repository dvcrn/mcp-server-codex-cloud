import { CodexCloudClient } from "../src/index.js";

const [environmentConfigId] = process.argv.slice(2);
if (!environmentConfigId) {
  throw new Error("Usage: bun examples/run-task.ts ENVIRONMENT_CONFIG_ID");
}
const client = await CodexCloudClient.fromCodexHome();
try {
  const task = await client.tasks.create({
    environmentConfigId,
    prompt:
      "Count the words in README.md and report the exact count. Do not modify files.",
  });
  console.log({ threadId: task.thread.id, turnId: task.turn.id });
  const completed = await client.tasks.waitFor(task.thread.id, task.turn.id, {
    timeoutMs: 300_000,
  });
  for (const item of completed.items) {
    if (item.type === "agentMessage") {
      console.log(item.text);
    }
  }
} finally {
  client.close();
}
