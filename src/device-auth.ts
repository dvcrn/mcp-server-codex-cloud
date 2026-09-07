import { z } from "zod";
import type { Fetch } from "./auth.js";
import type { CodexTokens } from "./token-store.js";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const authBase = "https://auth.openai.com";
const lifetimeMs = 15 * 60_000;
const nonempty = z.string().min(1);
const startSchema = z.object({
  device_auth_id: nonempty,
  user_code: nonempty,
  interval: z.union([z.number(), z.string()]).optional(),
});
const approvalSchema = z.object({ authorization_code: nonempty, code_verifier: nonempty });
const credentialsSchema = z.object({
  access_token: nonempty,
  refresh_token: nonempty,
  id_token: nonempty.optional(),
});

export type DeviceAuthSession =
  | {
      status: "pending";
      deviceId: string;
      userCode: string;
      expiresAt: number;
      intervalMs: number;
      nextPollAt: number;
    }
  | { status: "authenticated" | "expired" | "failed" };

export const deviceAuthStatusSchema = z.union([
  z.object({ status: z.enum(["idle", "authenticated", "expired", "failed"]) }),
  z.object({
    status: z.literal("pending"),
    verificationUrl: z.url(),
    userCode: nonempty,
    expiresAt: z.iso.datetime(),
    retryAfterSeconds: z.number().positive().finite(),
  }),
]);
export type DeviceAuthStatus = z.infer<typeof deviceAuthStatusSchema>;

export interface DeviceAuthStore {
  loadSession(): Promise<DeviceAuthSession | undefined>;
  saveSession(session: DeviceAuthSession): Promise<void>;
  complete(tokens: CodexTokens): Promise<void>;
}

// Callers serialize operations to protect one-use authorization code exchanges.
export class DeviceAuth {
  constructor(
    private readonly store: DeviceAuthStore,
    private readonly upstreamFetch: Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<DeviceAuthStatus> {
    const current = await this.status();
    if (current.status === "pending") return current;
    const response = await this.post("/api/accounts/deviceauth/usercode", { client_id: clientId });
    if (!response.ok) throw new Error("Device authorization could not be started");
    const parsed = startSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid device authorization response");
    const rawInterval = Number(parsed.data.interval ?? 5);
    const intervalMs =
      Number.isFinite(rawInterval) && rawInterval > 0
        ? Math.min(lifetimeMs, Math.max(1000, rawInterval * 1000))
        : 5000;
    const now = this.now();
    const session: DeviceAuthSession = {
      status: "pending",
      deviceId: parsed.data.device_auth_id,
      userCode: parsed.data.user_code,
      expiresAt: now + lifetimeMs,
      intervalMs,
      nextPollAt: now + intervalMs,
    };
    await this.store.saveSession(session);
    return this.view(session);
  }

  async status(): Promise<DeviceAuthStatus> {
    const session = await this.session();
    return session ? this.view(session) : { status: "idle" };
  }

  async poll(): Promise<DeviceAuthStatus> {
    const session = await this.session();
    if (!session) return { status: "idle" };
    if (session.status !== "pending" || this.now() < session.nextPollAt) return this.view(session);
    session.nextPollAt = this.now() + session.intervalMs;
    await this.store.saveSession(session);
    const response = await this.post("/api/accounts/deviceauth/token", {
      device_auth_id: session.deviceId,
      user_code: session.userCode,
    });
    session.nextPollAt = this.now() + session.intervalMs;
    await this.store.saveSession(session);
    if (response.status === 403 || response.status === 404 || response.status >= 500)
      return this.view(session);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z
        .object({ error: z.union([z.string(), z.object({ code: z.string() })]) })
        .safeParse(body);
      const code = error.success
        ? typeof error.data.error === "string"
          ? error.data.error
          : error.data.error.code
        : undefined;
      if (code === "deviceauth_authorization_pending") return this.view(session);
      if (code === "slow_down" || response.status === 429) {
        session.intervalMs += 5000;
        session.nextPollAt = this.now() + session.intervalMs;
        await this.store.saveSession(session);
        return this.view(session);
      }
      return this.finish("failed");
    }
    const approval = approvalSchema.safeParse(body);
    if (!approval.success) return this.finish("failed");
    // An interrupted one-use code exchange must require a fresh login, never replay the code.
    await this.finish("failed");
    const tokenResponse = await this.upstreamFetch(`${authBase}/oauth/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: approval.data.authorization_code,
        code_verifier: approval.data.code_verifier,
        redirect_uri: `${authBase}/deviceauth/callback`,
      }).toString(),
    });
    if (!tokenResponse.ok) return { status: "failed" };
    const credentials = credentialsSchema.safeParse(await tokenResponse.json().catch(() => null));
    if (!credentials.success) return { status: "failed" };
    const accountId = readAccountId(credentials.data.access_token);
    if (!accountId) return { status: "failed" };
    const tokens: CodexTokens = {
      accessToken: credentials.data.access_token,
      refreshToken: credentials.data.refresh_token,
      accountId,
      lastRefresh: new Date(this.now()).toISOString(),
      ...(credentials.data.id_token ? { idToken: credentials.data.id_token } : {}),
    };
    await this.store.complete(tokens);
    return { status: "authenticated" };
  }

  private async session(): Promise<DeviceAuthSession | undefined> {
    const session = await this.store.loadSession();
    if (session?.status === "pending" && this.now() >= session.expiresAt) {
      await this.finish("expired");
      return { status: "expired" };
    }
    return session;
  }

  private async finish(status: "failed" | "expired"): Promise<DeviceAuthStatus> {
    await this.store.saveSession({ status });
    return { status };
  }

  private view(session: DeviceAuthSession): DeviceAuthStatus {
    if (session.status !== "pending") return { status: session.status };
    return {
      status: "pending",
      verificationUrl: `${authBase}/codex/device`,
      userCode: session.userCode,
      expiresAt: new Date(session.expiresAt).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((session.nextPollAt - this.now()) / 1000)),
    };
  }

  private post(path: string, body: Record<string, string>): Promise<Response> {
    return this.upstreamFetch(`${authBase}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function readAccountId(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    const parsed = z
      .object({ "https://api.openai.com/auth": z.object({ chatgpt_account_id: nonempty }) })
      .safeParse(payload);
    return parsed.success
      ? parsed.data["https://api.openai.com/auth"].chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}
