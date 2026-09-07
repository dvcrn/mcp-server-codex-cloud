import type { DeviceAuthSession, DeviceAuthStore } from "../src/device-auth.js";
import type { CodexTokens } from "../src/token-store.js";

export class DurableDeviceAuthStore implements DeviceAuthStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  loadSession(): Promise<DeviceAuthSession | undefined> {
    return this.storage.get<DeviceAuthSession>("device-auth");
  }

  saveSession(session: DeviceAuthSession): Promise<void> {
    return this.storage.put("device-auth", session);
  }

  async complete(tokens: CodexTokens): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      await transaction.put("tokens", tokens);
      await transaction.put("device-auth", { status: "authenticated" } satisfies DeviceAuthSession);
    });
  }
}
