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
    <main className="flex min-h-screen items-center justify-center bg-canvas p-8">
      <form
        // The browser's own bubble is replaced by this screen's field messages,
        // so native validation is switched off and Zod decides.
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-surface p-8 shadow-sm"
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">BCIS Sign In</h1>
          <p className="text-sm text-content-secondary">Enter your office credentials to continue.</p>
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
