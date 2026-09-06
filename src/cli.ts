#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CodexCloudClient } from "./client.js";
import { createMcpServer } from "./mcp.js";

try {
  const { values } = parseArgs({
    options: { "auth-file": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(
      "mcp-server-codex-cloud [--auth-file PATH]\nUses ~/.codex/auth.json by default. Communicates MCP over stdio.\n",
    );
  } else {
    const client = await CodexCloudClient.fromCodexHome(
      values["auth-file"] ? { authFile: values["auth-file"] } : {},
    );
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
  }
} catch {
  process.stderr.write("Could not start Codex Cloud MCP. Check arguments and Codex credentials.\n");
  process.exitCode = 1;
}
