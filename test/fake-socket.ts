import type { CloudSocket } from "../src/rpc.js";

export interface FakeRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export class FakeSocket implements CloudSocket {
  public readonly sent: FakeRequest[] = [];
  public closed = false;
  readonly #listeners = new Map<
    string,
    ((event: { data: unknown }) => void)[]
  >();

  public constructor(
    private readonly handle: (request: FakeRequest, socket: FakeSocket) => void,
  ) {}

  /** Delivers client requests asynchronously to the simulated backend. */
  public send(data: string): void {
    const request = JSON.parse(data) as FakeRequest;
    this.sent.push(request);
    queueMicrotask(() => this.handle(request, this));
  }

  /** Registers handlers for simulated socket events. */
  public addEventListener(
    type: string,
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  /** Delivers a peer message to registered listeners. */
  public emit(message: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  /** Sends a response with the original request identifier. */
  public reply(request: FakeRequest, result: unknown): void {
    this.emit({ id: request.id, result });
  }

  /** Emits closure so pending requests can settle. */
  public close(): void {
    this.closed = true;
    for (const listener of this.#listeners.get("close") ?? []) {
      listener({ data: undefined });
    }
  }
}
