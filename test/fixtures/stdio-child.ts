import { CodexCloudClient } from "../../src/client.js";
import { startStdioServer } from "../../src/stdio.js";
import { FakeSocket } from "../fake-socket.js";

const keepAlive = setInterval(() => {}, 1000);
const socket = new FakeSocket((request, current) => {
  if (request.method === "initialize") {
    current.reply(request, {});
  }
  if (request.method === "thread/resume") {
    current.reply(request, {
      thread: { id: "thread", status: { type: "idle" } },
    });
  }
});
const close = socket.close.bind(socket);
socket.close = () => {
  clearInterval(keepAlive);
  close();
};
const client = new CodexCloudClient({
  tokens: { accessToken: "test" },
  socketFactory: async () => socket,
});
await startStdioServer(client);
await client.tasks.resume("thread");
console.log("READY");
