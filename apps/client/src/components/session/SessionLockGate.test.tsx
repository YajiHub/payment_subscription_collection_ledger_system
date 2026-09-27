import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionLockGate } from "./SessionLockGate";
import { useAuthStore } from "../../stores/auth.store";
import {
  extractApiErrorMessage,
  getSystemSettings,
  lockSession,
  unlockSession,
} from "../../lib/api-client";

const LOCKED_USER = {
  id: "user-1",
  fullName: "Office Administrator",
  username: "ana",
  role: "admin",
} as const;

/** The setting the server returns: one minute is the shortest usable idle period. */
const IDLE_TIMEOUT_MINUTES = 1;
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60_000;

vi.mock("../../lib/api-client", () => ({
  getSystemSettings: vi.fn(async () => [
    {
      key: "session_idle_timeout_minutes",
      value: String(IDLE_TIMEOUT_MINUTES),
      description: "Minutes of inactivity before the client locks the workstation",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: null,
    },
  ]),
  unlockSession: vi.fn(),
  lockSession: vi.fn(async () => undefined),
  extractApiErrorMessage: vi.fn(() => "Invalid user or password"),
}));

/** The protected screen behind the gate; its text must never survive a lock. */
const PROTECTED_CONTENT = "Invoice INV-000001 balance ₱1,998.00";

function renderGate(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SessionLockGate>
        <p>{PROTECTED_CONTENT}</p>
      </SessionLockGate>
    </MemoryRouter>
  );
}

function signIn(): void {
  useAuthStore.setState({
    token: "test-token",
    user: { ...LOCKED_USER },
    isAuthenticated: true,
    lockedSession: null,
  });
}

/** Lets the settled promises behind a click run before the next assertion. */
async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Settles the settings request that decides how long the idle period is. */
async function settleSettingsFetch(): Promise<void> {
  await flushPromises();
}

async function idlePastTheTimeout(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 1);
  });
}

/** Locks by waiting out the idle period, the way an operator walking away would. */
async function idleIntoTheLock(): Promise<void> {
  renderGate();
  await settleSettingsFetch();
  await idlePastTheTimeout();
}

/**
 * S5-4. The lock is only a control if the screen behind it is genuinely gone, the
 * password is checked by the server, and moving away from the lock screen — a
 * reload — does not hand the workstation back.
 *
 * `fireEvent` rather than `userEvent` throughout: these tests run on fake timers so
 * the idle period can be waited out, and userEvent's own delays hang against them.
 */
describe("SessionLockGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(unlockSession).mockReset();
    vi.mocked(extractApiErrorMessage).mockReturnValue("Invalid user or password");
    signIn();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({
      token: null,
      user: null,
      isAuthenticated: false,
      lockedSession: null,
    });
  });

  it("locks the workstation after the idle period and renders no protected content", async () => {
    renderGate();

    expect(screen.getByText(PROTECTED_CONTENT)).toBeInTheDocument();

    await settleSettingsFetch();
    await idlePastTheTimeout();

    expect(useAuthStore.getState().lockedSession?.user.fullName).toBe("Office Administrator");
    expect(screen.queryByText(PROTECTED_CONTENT)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Office Administrator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("drops the token and revokes it on the server when it locks", async () => {
    await idleIntoTheLock();

    expect(useAuthStore.getState().token).toBeNull();
    expect(vi.mocked(lockSession)).toHaveBeenCalledWith("test-token");
  });

  it("does not unlock on a wrong password and says so", async () => {
    vi.mocked(unlockSession).mockRejectedValue(new Error("401"));

    await idleIntoTheLock();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "not-the-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await flushPromises();

    expect(vi.mocked(unlockSession)).toHaveBeenCalledWith("ana", "not-the-password");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid user or password");
    expect(useAuthStore.getState().lockedSession).not.toBeNull();
    expect(screen.queryByText(PROTECTED_CONTENT)).not.toBeInTheDocument();
  });

  it("unlocks with the correct password, which the server is the one to accept", async () => {
    vi.mocked(unlockSession).mockResolvedValue({
      token: "renewed-token",
      user: { id: "user-1", fullName: "Office Administrator", username: "ana", role: "admin" },
    });

    await idleIntoTheLock();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await flushPromises();

    expect(vi.mocked(unlockSession)).toHaveBeenCalledWith("ana", "correct-horse");
    expect(useAuthStore.getState().token).toBe("renewed-token");
    expect(useAuthStore.getState().lockedSession).toBeNull();
    expect(screen.getByText(PROTECTED_CONTENT)).toBeInTheDocument();
  });

  it("stays locked when the application is reloaded over the same session", async () => {
    const firstRender = renderGate();
    await settleSettingsFetch();
    await idlePastTheTimeout();

    // The persisted record is what a reload rehydrates from. There is no token in
    // it, so even a client that threw the lock record away could not get back in
    // without the password.
    const persisted = JSON.parse(localStorage.getItem("bcis-auth") ?? "{}") as {
      state?: { token?: string | null; lockedSession?: unknown };
    };
    expect(persisted.state?.lockedSession).not.toBeNull();
    expect(persisted.state?.token).toBeNull();

    // A reload throws the renderer away and builds it again. The workstation must
    // still be behind the lock screen.
    firstRender.unmount();
    renderGate();

    expect(screen.getByRole("dialog", { name: "Office Administrator" })).toBeInTheDocument();
    expect(screen.queryByText(PROTECTED_CONTENT)).not.toBeInTheDocument();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("does not lock while nobody is signed in", async () => {
    useAuthStore.setState({
      token: null,
      user: null,
      isAuthenticated: false,
      lockedSession: null,
    });

    renderGate();
    await settleSettingsFetch();
    await idlePastTheTimeout();

    expect(useAuthStore.getState().lockedSession).toBeNull();
    expect(screen.getByText(PROTECTED_CONTENT)).toBeInTheDocument();
    expect(vi.mocked(getSystemSettings)).not.toHaveBeenCalled();
  });
});
