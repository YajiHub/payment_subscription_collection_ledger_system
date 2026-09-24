// Registers the Zod request compilers for Fastify.
//
// The server validates every request with Zod. Two mechanisms cooperate:
//
//   • Most existing routes validate inside the handler with `parseOrThrow`, which
//     runs before any service or database call and always answers 400 with the
//     first human-readable problem. That kept a single, readable validation style
//     across the whole codebase.
//   • A route may declare its Zod schema in the route table itself
//     (`schema: { body, querystring, params }`). Those schemas are compiled here,
//     so Fastify rejects an invalid request BEFORE the handler runs.
//
// This function is called directly (not through `server.register`) so the
// compilers are set on the root instance that every route belongs to.

import type { FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

export function validationPlugin(server: FastifyInstance): void {
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
}
