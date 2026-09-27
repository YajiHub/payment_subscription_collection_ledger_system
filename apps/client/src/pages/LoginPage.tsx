import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { extractApiErrorMessage, login } from "../lib/api-client";
import { useAuthStore } from "../stores/auth.store";

/**
 * The sign-in screen.
 * There is deliberately no "Remember me": sessions last one working day.
 */
export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.login);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result = await login(username, password);
      setSession(result.token, result.user);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-8">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-surface p-8 shadow-sm"
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">BCIS Sign In</h1>
          <p className="text-sm text-content-secondary">Enter your office credentials to continue.</p>
        </header>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-content-primary">Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            className="w-full rounded border border-line-strong px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-content-primary">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded border border-line-strong px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        {errorMessage !== null && (
          <p
            role="alert"
            className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
          >
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong disabled:opacity-60"
        >
          {isSubmitting ? "Signing in…" : "Login"}
        </button>
      </form>
    </main>
  );
}
