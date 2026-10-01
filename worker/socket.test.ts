import { expect, test } from "bun:test";
import { workerSocketFactory } from "./socket.js";

function egress(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Fetcher {
  return { fetch } as Fetcher;
}

test("Worker socket upgrades through egress with protocols and account header", async () => {
  let accepted = false;
  const socket = {
    accept: () => {
      accepted = true;
    },
    close: () => {},
    send: () => {},
    addEventListener: () => {},
  };
  const factory = workerSocketFactory(
    egress(async (input, init) => {
      expect(String(input)).toBe("https://codex-cloud-backend.chatgpt.com/");
      const headers = new Headers(init?.headers);
      expect(headers.get("upgrade")).toBe("websocket");
      expect(headers.get("sec-websocket-protocol")).toBe(
        "codex-app-server, openai-bearer.test",
      );
      expect(headers.get("chatgpt-account-id")).toBe("account");
      expect(init?.redirect).toBe("manual");
      return { status: 101, webSocket: socket } as unknown as Response;
    }),
  );
  expect(
    await factory(
      "wss://codex-cloud-backend.chatgpt.com/",
      ["codex-app-server", "openai-bearer.test"],
      { "ChatGPT-Account-ID": "account" },
      new AbortController().signal,
    ),
  ).toBe(socket);
  expect(accepted).toBe(true);
});

test("Worker rejects an invalid upgrade without returning upstream credentials", async () => {
  const factory = workerSocketFactory(
    egress(async () => Response.json({ echo: "secret" }, { status: 401 })),
  );
  await expect(
    factory(
      "wss://codex-cloud-backend.chatgpt.com/",
      [],
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("authentication failed");
  await expect(
    factory("wss://untrusted.example/", [], {}, new AbortController().signal),
  ).rejects.toThrow("Unsupported");
});
