// The single source of truth for the logged-in user on the client side.
// Components read from here; they never decode JWT themselves.
//
// This state is a UX convenience only. Every request is re-checked by the
// server, which is the real authority on who may do what.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { UserRole } from "@bcis/shared";

export interface AuthenticatedClientUser {
  id: string;
  fullName: string;
  role: UserRole;
  /**
   * The account name this session was signed in with.
   *
   * Optional because a session persisted by an earlier build has no such record;
   * the lock screen handles that by asking for a fresh sign-in. The server is still
   * the only party that decides whether a password is correct — this is just the
   * name to send back to it.
   */
  username?: string;
}

/**
 * Who is expected back at a locked workstation (S5-4).
 *
 * This is a display record, not a credential: it exists so the lock screen can
 * name the person returning and offer them a password box. It is deliberately not
 * what keeps the session shut — locking revokes the token on the server, so even a
 * renderer that threw this record away gets no further than the sign-in screen.
 */
export interface LockedSession {
  user: AuthenticatedClientUser;
  /** ISO time the workstation was locked, shown so an operator can see how long it sat. */
  lockedAt: string;
}

interface AuthState {
  token: string | null;
  user: AuthenticatedClientUser | null;
  isAuthenticated: boolean;
  /** Set while the workstation is locked; cleared by unlocking, logging out or signing in. */
  lockedSession: LockedSession | null;
  login: (token: string, user: AuthenticatedClientUser) => void;
  /** Clears the live session but leaves a locked workstation locked. */
  endSession: () => void;
  /** Signs the user out completely, including any lock screen still standing. */
  logout: () => void;
  /** Covers the screen and drops the token; the identity is kept for the lock screen. */
  lockSession: () => void;
  /** Restores a session after the server has re-verified the password. */
  unlockSession: (token: string, user: AuthenticatedClientUser) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      lockedSession: null,
      login: (token, user) => set({ token, user, isAuthenticated: true, lockedSession: null }),
      // A rejected token ends the session the renderer was holding. It must not
      // also throw away a lock screen: the workstation stays locked until the
      // password is typed, whatever a late 401 from a request in flight says.
      endSession: () => set({ token: null, user: null, isAuthenticated: false }),
      logout: () => set({ token: null, user: null, isAuthenticated: false, lockedSession: null }),
      lockSession: () => {
        const user = get().user;
        set({
          token: null,
          user: null,
          isAuthenticated: false,
          lockedSession: user === null ? null : { user, lockedAt: new Date().toISOString() },
        });
      },
      unlockSession: (token, user) =>
        set({ token, user, isAuthenticated: true, lockedSession: null }),
    }),
    {
      name: "bcis-auth", // localStorage key
      // `isAuthenticated` is persisted too: without it a page reload restored the
      // token and user but reset the flag to false, and ProtectedRoute bounced the
      // user back to /login even though their session was still valid.
      //
      // `lockedSession` is persisted for the same reason in reverse: moving away
      // from the lock screen — a reload, a navigation — must not quietly hand the
      // workstation back. It only ever survives as far as the password prompt.
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        lockedSession: state.lockedSession,
      }),
    }
  )
);
