// The consistent JSON envelope used by every domain endpoint.
//
//   success → { "success": true,  "data": ... }
//   failure → { "success": false, "error": { "code": "...", "message": "..." } }
//
// The Phase 1 health endpoints intentionally return their own small literal
// shapes (see specs/phase1-foundation.md §7) because they are operational
// probes, not domain responses.

import type { FastifyReply } from "fastify";

export interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}

export function createSuccessResponse<TData>(data: TData): ApiSuccessResponse<TData> {
  return { success: true, data };
}

export function createErrorResponse(code: string, message: string): ApiErrorResponse {
  return { success: false, error: { code, message } };
}

/** Sends a successful envelope with the given HTTP status (200 by default). */
export function sendSuccess<TData>(
  reply: FastifyReply,
  data: TData,
  statusCode = 200
): FastifyReply {
  return reply.status(statusCode).send(createSuccessResponse(data));
}

/** Sends a failure envelope. Used by the global error handler. */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string
): FastifyReply {
  return reply.status(statusCode).send(createErrorResponse(code, message));
}