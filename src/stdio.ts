import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { CodexCloudClient } from "./client.js";
import { createMcpServer } from "./mcp.js";

/** Serves MCP on process stdio and closes cloud resources when the connection ends. */
export async function startStdioServer(
  client: CodexCloudClient,
): Promise<void> {
  const server = createMcpServer(client);
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    process.stdin.removeListener("end", close);
    process.stdin.removeListener("close", close);
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    client.close();
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.server.onclose = close;
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    close();
    throw error;
  }
}
