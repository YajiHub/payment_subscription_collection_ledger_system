import type { ReactNode } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";

import { extractApiErrorMessage, login } from "../lib/api-client";
import { useAuthStore } from "../stores/auth.store";
import { TextField } from "../components/form/TextField";
import { formResolver } from "../components/form/form-resolver";

/**
 * The sign-in rules.
 *
 * The server validates the login body with a schema of its own
 * (`apps/server/src/modules/auth/auth.handler.ts`, `loginBodySchema`) which is not
 * exported from `@bcis/shared`, so this mirrors it rule for rule and message for
 * message. Keep the two in step.
 */
const loginFormSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.input<typeof loginFormSchema>;

/**
 * The sign-in screen.
 * There is deliberately no "Remember me": sessions last one working day.
 */
export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.login);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: formResolver(loginFormSchema),
    defaultValues: { username: "", password: "" },
  });

  // What the server rejects — a wrong password, a locked account — is not a field
  // error the client could have predicted, so it stays a banner above the button.
  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);
    try {
      const result = await login(values.username, values.password);
      setSession(result.token, result.user);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#071322] via-[#0b1c33] to-[#040c17] p-6 sm:p-10">
      <div className="w-full max-w-md space-y-6">
        <form
          // The browser's own bubble is replaced by this screen's field messages,
          // so native validation is switched off and Zod decides.
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="w-full space-y-5 rounded-2xl border border-white/10 bg-surface/95 p-8 sm:p-10 shadow-2xl backdrop-blur-md"
        >
          <header className="space-y-2 text-center">
            <div className="mx-auto inline-flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent border border-accent/20">
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
              ISP Operations
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-content-primary">BCIS Sign In</h1>
            <p className="text-sm text-content-secondary">Enter your office credentials to access billing and ledger.</p>
          </header>

          <TextField
            id="username"
            label="Username"
            required
            autoComplete="username"
            error={errors.username?.message}
            {...register("username")}
          />

          <TextField
            id="password"
            label="Password"
            type="password"
            required
            autoComplete="current-password"
            error={errors.password?.message}
            {...register("password")}
          />

          {errorMessage !== null && (
            <p
              role="alert"
              className="rounded-xl border border-danger-line bg-danger-soft px-3.5 py-2.5 text-sm text-danger-strong"
            >
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-xl bg-gradient-to-r from-accent to-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-accent/25 hover:from-blue-600 hover:to-accent focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-60 transition-all cursor-pointer"
          >
            {isSubmitting ? "Signing in…" : "Login"}
          </button>
        </form>

        <p className="text-center text-xs text-white/40">
          BCIS · Subscription &amp; Collection Ledger System
        </p>
      </div>
    </main>
  );
}
