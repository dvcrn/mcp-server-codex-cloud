import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const shutdown of ["eof", "sigterm"] as const) {
  test(`stdio closes its active cloud connection on ${shutdown}`, async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("fixtures/stdio-child.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const ready = Promise.withResolvers<void>();
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY")) {
        ready.resolve();
      }
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    try {
      await ready.promise;
      if (shutdown === "eof") {
        child.stdin.end();
      } else {
        child.kill("SIGTERM");
      }
      expect(await exited).toBe(0);
    } finally {
      child.kill();
    }
  }, 5000);
}
