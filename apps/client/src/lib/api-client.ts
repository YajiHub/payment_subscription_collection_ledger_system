// The ONLY place in the renderer that performs HTTP.
//
// The sandboxed renderer has no database driver and no raw sockets: every piece
// of data the UI shows must arrive through a function in this file.

import axios from "axios";

import { API_BASE_URL, HTTP_TIMEOUT_MS } from "./constants";

const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

export interface ServiceHealth {
  status: "ok";
  timestamp: string;
  version: string;
}

export interface DatabaseHealth {
  status: "ok" | "error";
  latency_ms: number;
  error?: string | null;
}

/** Asks the API server whether the process is alive. Throws when unreachable. */
export async function fetchServiceHealth(): Promise<ServiceHealth> {
  const response = await httpClient.get<ServiceHealth>("/health");
  return response.data;
}

/** Asks the API server to confirm it can reach PostgreSQL. */
export async function fetchDatabaseHealth(): Promise<DatabaseHealth> {
  const response = await httpClient.get<DatabaseHealth>("/health/db");
  return response.data;
}