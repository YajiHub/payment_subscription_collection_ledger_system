// S5-4 — the account name a session must remember, and the defect that came of not
// remembering it.
//
// The server answers a sign-in with the identity it authenticated — id, name, role —
// and deliberately not the account name it was called by. The lock screen needs that
// name to send the password back for the SAME account, so the sign-in path has to
// carry it onto the user record. It did not: every lock refused to unlock and told
// the operator to sign in again, even seconds after locking.
//
// The axios instance is mocked, so this suite exercises the request/response mapping
// in api-client without a server.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("axios", () => {
  const instance = {
    defaults: {} as Record<string, unknown>,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return {
    default: { create: () => instance },
    AxiosError: class AxiosError extends Error {},
  };
});

import { authenticatedUser, login, unlockSession, type LoginResult } from "./api-client";

/** The server's answer to a successful sign-in: note the absent `username`. */
function signedInResponse(user: LoginResult["user"]) {
  return { data: { success: true, data: { token: "test-token", user } } };
}

/**
 * What the API really sends: the identity, and no account name.
 *
 * The role is a legacy spelling here only because `LoginResult` still types it that
 * way; the server actually answers with a system role such as `administrator`.
 */
const SERVER_USER: LoginResult["user"] = { id: "user-1", fullName: "Ana Reyes", role: "admin" };

describe("the user record a session keeps", () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.get.mockReset();
  });

  it("carries the account name a sign-in was accepted for", async () => {
    mocks.post.mockResolvedValue(signedInResponse(SERVER_USER));

    const result = await login("ana.reyes", "correct-horse");

    expect(mocks.post).toHaveBeenCalledWith("/api/auth/login", {
      username: "ana.reyes",
      password: "correct-horse",
    });
    // Without this the lock screen cannot unlock: it has no name to send back.
    expect(result.user.username).toBe("ana.reyes");
  });

  it("carries it on the unlock path too, which is the same exchange", async () => {
    mocks.post.mockResolvedValue(signedInResponse(SERVER_USER));

    const result = await unlockSession("ana.reyes", "correct-horse");

    expect(result.user.username).toBe("ana.reyes");
  });

  it("keeps the server's own spelling when the server supplies a name", () => {
    // A server that does return the name is the authority on how it is written; the
    // typed name is only a fallback for one that does not.
    const user = authenticatedUser({ ...SERVER_USER, username: "Ana.Reyes" }, "ana.reyes");

    expect(user.username).toBe("Ana.Reyes");
  });
});
