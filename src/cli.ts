#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CodexCloudClient } from "./client.js";
import { fileDeviceAuth, waitForDeviceLogin } from "./device-login.js";
import { createMcpServer } from "./mcp.js";
import { CodexAuthFileTokenStore } from "./token-store.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "auth-file": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== "auth"))
    throw new Error("Unknown command");
  const authFile =
    values["auth-file"] ?? join(homedir(), ".config", "mcp-server-codex-cloud", "auth.json");
  const tokenStore = new CodexAuthFileTokenStore({ authFile });
  if (values.help) {
    process.stdout.write(
      "mcp-server-codex-cloud [auth] [--auth-file PATH]\nUses ~/.config/mcp-server-codex-cloud/auth.json by default.\nRun auth to sign in using a device code. Without a command, communicates MCP over stdio.\n",
    );
  } else if (positionals[0] === "auth") {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const auth = fileDeviceAuth(tokenStore, (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
        }),
      );
      await waitForDeviceLogin(
        auth,
        (status) => {
          process.stdout.write(
            `Open ${status.verificationUrl}\nEnter code: ${status.userCode}\nWaiting for approval...\n`,
          );
        },
        abort.signal,
      );
      process.stdout.write(`Credentials saved to ${authFile}\n`);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } else {
    await tokenStore.load();
    const client = new CodexCloudClient({ tokenStore });
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
  }
} catch {
  process.stderr.write(
    "Codex Cloud command failed. Run auth to sign in, or check --help and --auth-file.\n",
  );
  process.exitCode = 1;
}
