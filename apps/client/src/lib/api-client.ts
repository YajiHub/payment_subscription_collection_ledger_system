// The ONLY place in the renderer that performs HTTP.
//
// The sandboxed renderer has no database driver and no raw sockets: every piece
// of data the UI shows must arrive through a function in this file.
// Domain endpoints answer with the { success, data } envelope; helpers below
// unwrap it so callers work with the payload directly.

import axios, { AxiosError } from "axios";

import type { UserRole } from "@bcis/shared";
import { API_BASE_URL, HTTP_TIMEOUT_MS } from "./constants";
import { useAuthStore } from "../stores/auth.store";

const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

// Attach the bearer token to every request once the user is logged in.
httpClient.interceptors.request.use((requestConfig) => {
  const token = useAuthStore.getState().token;
  if (token !== null) {
    requestConfig.headers.Authorization = `Bearer ${token}`;
  }
  return requestConfig;
});

// A 401 means the session is no longer valid — clear it so the UI redirects to login.
httpClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

interface ApiSuccessEnvelope<TData> {
  success: true;
  data: TData;
}

interface ApiErrorEnvelope {
  success: false;
  error: { code: string; message: string };
}

/** Turns any thrown error into a message a human can read in the UI. */
export function extractApiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data as ApiErrorEnvelope | undefined;
    if (body?.error?.message !== undefined) {
      return body.error.message;
    }
    if (error.code === "ECONNABORTED") {
      return "The server took too long to respond.";
    }
    return "Unable to reach the server. Check that it is running.";
  }
  return "Something went wrong. Please try again.";
}

function unwrap<TData>(envelope: ApiSuccessEnvelope<TData>): TData {
  return envelope.data;
}

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

export interface AuthenticatedUserProfile {
  id: string;
  fullName: string;
  username: string;
  role: UserRole;
  isActive: boolean;
}

export interface LoginResult {
  token: string;
  user: { id: string; fullName: string; role: UserRole };
}

/** POST /api/auth/login — exchanges credentials for a token. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<LoginResult>>("/api/auth/login", {
    username,
    password,
  });
  return unwrap(response.data);
}

/** POST /api/auth/logout — revokes the current token on the server. */
export async function logout(): Promise<void> {
  await httpClient.post("/api/auth/logout");
}

/** GET /api/auth/me — the profile of the currently authenticated user. */
export async function fetchCurrentUser(): Promise<AuthenticatedUserProfile> {
  const response =
    await httpClient.get<ApiSuccessEnvelope<AuthenticatedUserProfile>>("/api/auth/me");
  return unwrap(response.data);
}

export interface ManagedUser {
  id: string;
  fullName: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedUsers {
  items: ManagedUser[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateUserInput {
  fullName: string;
  username: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserInput {
  fullName?: string;
  role?: UserRole;
}

/** GET /api/users — one page of users (Admin only). */
export async function listUsers(page = 1, pageSize = 20): Promise<PaginatedUsers> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaginatedUsers>>("/api/users", {
    params: { page, pageSize },
  });
  return unwrap(response.data);
}

/** POST /api/users — creates a user (Admin only). */
export async function createUser(input: CreateUserInput): Promise<ManagedUser> {
  const response = await httpClient.post<ApiSuccessEnvelope<ManagedUser>>("/api/users", input);
  return unwrap(response.data);
}

/** PUT /api/users/:id — updates a user's name and/or role (Admin only). */
export async function updateUser(id: string, input: UpdateUserInput): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(`/api/users/${id}`, input);
  return unwrap(response.data);
}

/** PUT /api/users/:id/password — resets a user's password (Admin only). */
export async function changeUserPassword(id: string, password: string): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(
    `/api/users/${id}/password`,
    { password }
  );
  return unwrap(response.data);
}

/** PUT /api/users/:id/deactivate — activates or deactivates a user (Admin only). */
export async function setUserActiveState(id: string, isActive: boolean): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(
    `/api/users/${id}/deactivate`,
    { isActive }
  );
  return unwrap(response.data);
}
