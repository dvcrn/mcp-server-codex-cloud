import { setTimeout as delay } from "node:timers/promises";
import type { Fetch } from "./auth.js";
import { DeviceAuth, type DeviceAuthSession, type DeviceAuthStatus } from "./device-auth.js";
import type { TokenStore } from "./token-store.js";

export function fileDeviceAuth(tokenStore: TokenStore, upstreamFetch: Fetch = fetch): DeviceAuth {
  let session: DeviceAuthSession | undefined;
  return new DeviceAuth(
    {
      loadSession: async () => session,
      saveSession: async (next) => {
        session = next;
      },
      complete: async (tokens) => {
        await tokenStore.save(tokens);
        session = { status: "authenticated" };
      },
    },
    upstreamFetch,
  );
}

export async function waitForDeviceLogin(
  auth: Pick<DeviceAuth, "start" | "poll">,
  showCode: (status: Extract<DeviceAuthStatus, { status: "pending" }>) => void,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let status = await auth.start();
  if (status.status === "pending") showCode(status);
  while (status.status === "pending") {
    const remainingMs = Date.parse(status.expiresAt) - Date.now();
    if (remainingMs <= 0) throw new Error("Device authorization expired; start auth again");
    await delay(Math.min(status.retryAfterSeconds * 1000, remainingMs), undefined, { signal });
    signal.throwIfAborted();
    status = await auth.poll();
  }
  if (status.status !== "authenticated")
    throw new Error("Device authorization failed; start auth again");
}
