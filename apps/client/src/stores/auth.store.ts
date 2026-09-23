// The single source of truth for the logged-in user on the client side.
// Components read from here; they never decode JWTs themselves.
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
}

interface AuthState {
  token: string | null;
  user: AuthenticatedClientUser | null;
  isAuthenticated: boolean;
  login: (token: string, user: AuthenticatedClientUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      login: (token, user) => set({ token, user, isAuthenticated: true }),
      logout: () => set({ token: null, user: null, isAuthenticated: false }),
    }),
    {
      name: "bcis-auth", // localStorage key
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
);
