import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { nodeFetch } from "../src/fetch-node.js";

async function fixture() {
  const server = createServer(async (request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/body" });
      response.end();
      return;
    }
    if (request.url === "/hang") {
      return;
    }
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        method: request.method,
        body,
        authorization: request.headers.authorization,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("native transport sends authenticated JSON and preserves redirect and empty responses", async () => {
  const server = await fixture();
  try {
    const response = await nodeFetch(`${server.url}/body`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: '{"hello":"world"}',
    });
    expect(await response.json()).toEqual({
      method: "POST",
      body: '{"hello":"world"}',
      authorization: "Bearer test",
    });
    const redirect = await nodeFetch(`${server.url}/redirect`);
    expect(redirect.status).toBe(302);
    await redirect.body?.cancel();
    const empty = await nodeFetch(`${server.url}/empty`);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  } finally {
    server.close();
  }
});

test("native transport aborts a hung request", async () => {
  const server = await fixture();
  try {
    await expect(
      nodeFetch(`${server.url}/hang`, { signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow();
  } finally {
    server.close();
  }
});
