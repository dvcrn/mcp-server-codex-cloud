import { CodexAuthFileTokenStore } from "../src/token-store.js";

const target = process.env.CODEX_WORKER_URL;
const admin = process.env.ADMIN_TOKEN;
if (!target || !admin) throw new Error("Set CODEX_WORKER_URL and ADMIN_TOKEN");
const url = new URL("/admin/tokens", target);
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("Worker URL must use HTTPS without userinfo");
const authFile = process.env.CODEX_AUTH_FILE;
const store = new CodexAuthFileTokenStore(authFile ? { authFile } : {});
const tokens = await store.load();
if (!tokens.refreshToken) throw new Error("The Codex login must contain a refresh token");
const response = await fetch(url, {
  method: "POST",
  redirect: "error",
  headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
  body: JSON.stringify(tokens),
});
if (!response.ok) throw new Error(`Credential seeding failed with HTTP ${response.status}`);
console.log(
  "Worker credentials seeded. Use a dedicated Codex login for the Worker to avoid refresh races with local clients.",
);
