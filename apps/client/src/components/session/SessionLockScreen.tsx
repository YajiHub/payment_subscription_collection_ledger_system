// S5-4: the locked-workstation screen.
//
// This is a screen, not an overlay drawn on top of one. The gate that renders it
// stops rendering the application entirely, so no page, table, invoice or receipt
// is present in the DOM while the workstation is locked — there is nothing behind
// this screen to read, screenshot or tab onto.

import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";

import { getRoleLabel } from "@bcis/shared";
import { extractApiErrorMessage, unlockSession as requestUnlock } from "../../lib/api-client";
import { formatTimestamp } from "../../lib/format";
import { useAuthStore } from "../../stores/auth.store";
import { Button } from "../ui/Button";
import { TextField } from "../form/TextField";

/**
 * Who is locked out, why, and the box their password goes in.
 *
 * The password is sent straight to the server's unlock endpoint and is never kept
 * anywhere in the renderer: the state below is cleared on success, and nothing here
 * logs or displays it.
 */
export function SessionLockScreen(): ReactNode {
  const navigate = useNavigate();
  const lockedSession = useAuthStore((state) => state.lockedSession);
  const restoreSession = useAuthStore((state) => state.unlockSession);
  const signOut = useAuthStore((state) => state.logout);

  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  if (lockedSession === null) {
    return null;
  }

  const { user, lockedAt } = lockedSession;

  async function handleUnlock(): Promise<void> {
    if (lockedSession === null) {
      return;
    }

    if (password.length === 0) {
      setErrorMessage("Enter your password to unlock this workstation.");
      return;
    }

    const username = lockedSession.user.username;

    if (username === undefined || username.length === 0) {
      setErrorMessage(
        "This workstation was signed in before the idle lock was added. Sign in again to continue."
      );
      return;
    }

    setErrorMessage(null);
    setIsUnlocking(true);

    try {
      const result = await requestUnlock(username, password);
      setPassword("");
      restoreSession(result.token, result.user);
    } catch (error) {
      setPassword("");
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsUnlocking(false);
    }
  }

  function handleSignOut(): void {
    signOut();
    navigate("/login", { replace: true });
  }

  return (
    <main
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-lock-title"
      className="flex min-h-screen items-center justify-center bg-canvas p-8"
    >
      <section className="w-full max-w-md space-y-5 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-content-secondary">
            <Lock className="h-4 w-4" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Workstation locked
            </span>
          </div>
          <h1 id="session-lock-title" className="text-xl font-semibold text-content-primary">
            {user.fullName}
          </h1>
          <p className="text-sm text-content-secondary">
            {getRoleLabel(user.role)} · signed in here. Locked at {formatTimestamp(lockedAt)}.
          </p>
          <p className="text-sm text-content-secondary">
            Enter this account&apos;s password to return to work. Anyone else needs to sign in.
          </p>
        </header>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleUnlock();
          }}
        >
          <TextField
            id="unlock-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {errorMessage !== null && (
            <p
              role="alert"
              className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
            >
              {errorMessage}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="submit" size="md" isLoading={isUnlocking}>
              Unlock
            </Button>
            <Button type="button" variant="link" size="md" onClick={handleSignOut}>
              Sign in as someone else
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
