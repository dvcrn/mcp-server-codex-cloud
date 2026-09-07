import { setTimeout as delay } from "node:timers/promises";
import { type DeviceAuthStatus, deviceAuthStatusSchema } from "../src/device-auth.js";
import { waitForDeviceLogin } from "../src/device-login.js";

const base = process.env.CODEX_WORKER_URL;
const token = process.env.ADMIN_TOKEN;
if (!base || !token) throw new Error("CODEX_WORKER_URL and ADMIN_TOKEN are required");
const url = new URL(base);
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("CODEX_WORKER_URL must be an HTTPS URL without credentials");
const abort = new AbortController();
const cancel = () => abort.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

async function request(action: "start" | "status"): Promise<DeviceAuthStatus> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(new URL(`/admin/auth/${action}`, url), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    });
    if (response.status === 409) {
      await response.body?.cancel();
      await delay(2000, undefined, { signal: abort.signal });
      continue;
    }
    if (!response.ok) throw new Error(`Worker auth request failed (HTTP ${response.status})`);
    return deviceAuthStatusSchema.parse(await response.json());
  }
  throw new Error("Worker is busy; retry auth when active requests finish");
}

try {
  await waitForDeviceLogin(
    { start: () => request("start"), poll: () => request("status") },
    (status) => {
      console.log(
        `Open ${status.verificationUrl}\nEnter code: ${status.userCode}\nWaiting for approval...`,
      );
    },
    abort.signal,
  );
  console.log("Authenticated. Credentials saved in the Worker.");
} catch {
  console.error("Worker device auth did not complete. Run worker:auth to retry.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
