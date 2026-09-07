import { fileDeviceAuth, waitForDeviceLogin } from "../src/device-auth.js";
import { MemoryTokenStore } from "../src/token-store.js";

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

try {
  const store = new MemoryTokenStore({ accessToken: "" });
  await waitForDeviceLogin(
    fileDeviceAuth(store),
    (status) => {
      console.log(
        `Open ${status.verificationUrl}\nEnter code: ${status.userCode}\nWaiting for approval...`,
      );
    },
    abort.signal,
  );
  const response = await fetch(new URL("/admin/tokens", url), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify(await store.load()),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Credential upload failed (HTTP ${response.status})`);
  console.log("Authenticated. Credentials saved in Worker KV.");
} catch {
  console.error("Worker authentication did not complete. Run worker:auth to retry.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
