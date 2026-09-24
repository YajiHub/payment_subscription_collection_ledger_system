// CORS: a packaged Electron client loads its page from file:// and reports its
// origin as the literal string "null". The API must accept it when the operator
// has added "null" to CORS_ORIGIN, and must keep refusing everything else.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { parseAllowedOrigins, securityPlugin } from "../src/shared/plugins/security.plugin";

const servers: FastifyInstance[] = [];

async function createServerWithOrigins(allowedOrigins: readonly string[]): Promise<FastifyInstance> {
  const server = Fastify();
  await securityPlugin(server, { allowedOrigins });
  server.get("/probe", async () => ({ ok: true }));
  await server.ready();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("parseAllowedOrigins", () => {
  it("splits a comma-separated list, trimming whitespace and dropping blanks", () => {
    expect(parseAllowedOrigins("http://localhost:5173, null ,")).toEqual([
      "http://localhost:5173",
      "null",
    ]);
  });

  it("returns a single origin unchanged", () => {
    expect(parseAllowedOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });
});

describe("CORS allow-list", () => {
  it("allows a packaged Electron client, whose origin is the string null", async () => {
    const server = await createServerWithOrigins(["http://localhost:5173", "null"]);

    const response = await server.inject({
      method: "GET",
      url: "/probe",
      headers: { origin: "null" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("null");
  });

  it("refuses an origin that is not on the list and never echoes it", async () => {
    const server = await createServerWithOrigins(["http://localhost:5173"]);

    const response = await server.inject({
      method: "GET",
      url: "/probe",
      headers: { origin: "http://evil.example" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a request with no Origin header, which is not a browser request", async () => {
    const server = await createServerWithOrigins(["http://localhost:5173"]);

    const response = await server.inject({ method: "GET", url: "/probe" });

    expect(response.statusCode).toBe(200);
  });
});