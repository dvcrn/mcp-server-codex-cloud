import WebSocket from "ws";
import { AuthenticationError, CodexCloudError } from "./errors.js";
import type { CloudSocket, SocketFactory } from "./rpc.js";

/** Opens the cloud app-server socket using Node-compatible WebSocket headers. */
export const nodeSocketFactory: SocketFactory = (
  url,
  protocols,
  headers,
  signal,
) =>
  new Promise<CloudSocket>((resolve, reject) => {
    signal.throwIfAborted();
    const socket = new WebSocket(url, protocols, { headers });
    const abort = () => {
      socket.terminate();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("open", () => {
      signal.removeEventListener("abort", abort);
      resolve(socket as CloudSocket);
    });
    socket.once("unexpected-response", (_request, response) => {
      signal.removeEventListener("abort", abort);
      response.resume();
      socket.terminate();
      reject(
        response.statusCode === 401
          ? new AuthenticationError("Cloud WebSocket authentication failed")
          : new CodexCloudError(
              `Cloud WebSocket upgrade failed with HTTP ${response.statusCode}`,
            ),
      );
    });
    socket.once("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new CodexCloudError("Cloud WebSocket connection failed"));
    });
  });
