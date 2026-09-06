import { CodexCloudClient } from "../src/index.js";

const [environmentId] = process.argv.slice(2);
if (!environmentId) throw new Error("Usage: bun examples/run-task.ts ENVIRONMENT_ID");

const client = await CodexCloudClient.fromCodexHome();
const created = await client.tasks.create({
  environmentId,
  branch: "main",
  prompt: "Count the words in README.md and report the exact count. Do not modify files.",
});
console.log(created.url);

const completed = await client.tasks.waitFor(created.id);
console.log(completed.messages.join("\n"));
