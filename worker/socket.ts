import { AuthenticationError, CodexCloudError } from "../src/errors.js";
import type { CloudSocket, SocketFactory } from "../src/rpc.js";

/** Opens the cloud socket through the Worker's configured egress binding. */
export function workerSocketFactory(egress: Fetcher): SocketFactory {
  return async (url, protocols, headers, signal) => {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== "wss:"
      || endpoint.hostname !== "codex-cloud-backend.chatgpt.com"
    ) {
      throw new CodexCloudError("Unsupported cloud socket upstream");
    }
    endpoint.protocol = "https:";
    const response = await egress.fetch(endpoint.toString(), {
      headers: {
        ...headers,
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": protocols.join(", "),
      },
      redirect: "manual",
      signal,
    });
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      await response.body?.cancel();
      if (response.status === 401) {
        throw new AuthenticationError("Cloud WebSocket authentication failed");
      }
      throw new CodexCloudError(
        `Cloud WebSocket upgrade failed with HTTP ${response.status}`,
      );
    }
    socket.accept();
    return socket as CloudSocket;
  };
}
