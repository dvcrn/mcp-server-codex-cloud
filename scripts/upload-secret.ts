const token = process.env.ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error("ADMIN_TOKEN must contain at least 32 characters");
const child = Bun.spawn(["bun", "run", "wrangler", "secret", "put", "ADMIN_TOKEN"], {
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});
child.stdin.write(token);
child.stdin.end();
process.exitCode = await child.exited;
