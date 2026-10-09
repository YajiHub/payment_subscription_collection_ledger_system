import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { z } from "zod";

import type { SystemSetting } from "@bcis/shared";
import { extractApiErrorMessage, getSystemSettings, updateSystemSettings } from "../lib/api-client";
import { AppShell } from "../components/layout/AppShell";
import { TextField } from "../components/form/TextField";
import { formResolver } from "../components/form/form-resolver";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * The settings rules.
 *
 * `PUT /api/system/settings` validates `{ settings: [{ key, value }] }` against a
 * handler-local schema (`apps/server/src/modules/system/system.handler.ts`,
 * `updateSystemSettingsBodySchema`), which is not exported from `@bcis/shared`.
 * The only rule it puts on a value is a length cap, mirrored here; the rest of the
 * schema describes the envelope this screen builds from the rows it was given.
 *
 * Every key is recorded as a field of its own, so a value the server would refuse
 * is reported under the box it was typed into. Setting keys are snake_case, which
 * makes them safe React Hook Form field names.
 */
const settingsFormSchema = z.record(
  z.string().max(1000, "A setting value is at most 1000 characters")
);

type SettingsFormValues = z.infer<typeof settingsFormSchema>;

/**
 * The rows the administrator actually changed, in the shape the API expects.
 *
 * One function, so the button's disabled state and the request body can never
 * disagree about whether there is anything to save.
 */
function collectChangedSettings(
  settings: readonly SystemSetting[],
  draftValues: Readonly<Record<string, string | undefined>>
): { key: string; value: string }[] {
  return settings
    .filter((setting) => draftValues[setting.key] !== setting.value)
    .map((setting) => ({ key: setting.key, value: draftValues[setting.key] ?? setting.value }));
}

/**
 * Admin-only system settings screen.
 * The business rules here (late fee, due day, company details) are stored in the
 * database, not hardcoded, so they can be changed without a code change.
 */
export function SystemSettingsPage(): ReactNode {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<SettingsFormValues>({
    resolver: formResolver(settingsFormSchema),
    defaultValues: {},
  });

  const draftValues = watch();

  const loadSettings = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const items = await getSystemSettings();
      setSettings(items);
      reset(Object.fromEntries(items.map((setting) => [setting.key, setting.value])));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [reset]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const changedSettings = collectChangedSettings(settings, draftValues);

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);
    setSavedMessage(null);

    const changes = collectChangedSettings(settings, values);

    if (changes.length === 0) {
      setSavedMessage("No changes to save.");
      return;
    }

    setIsSaving(true);
    try {
      const updated = await updateSystemSettings(changes);
      setSettings(updated);
      reset(Object.fromEntries(updated.map((setting) => [setting.key, setting.value])));
      setSavedMessage(`Saved ${changes.length} setting(s).`);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  });

  return (
    <AppShell
      pageTitle="System Settings"
      pageDescription="Business rules used across billing, receipts, and reports."
      headerActions={
        <Link
          to="/"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Dashboard
        </Link>
      }
    >
      <div className="w-full max-w-5xl space-y-6">
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadSettings()} />
        )}
        {savedMessage !== null && (
          <div
            role="status"
            className="flex items-center gap-2.5 rounded-xl border border-success-line bg-success-soft px-4 py-3"
          >
            <span className="text-sm text-success-strong">{savedMessage}</span>
          </div>
        )}

        <Card>
          <CardContent>
            <form noValidate className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
              {isLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-3 w-64" />
                    </div>
                  ))}
                </div>
              ) : (
                settings.map((setting) => (
                  <TextField
                    key={setting.key}
                    id={`setting-${setting.key}`}
                    label={setting.key}
                    className="font-mono"
                    hint={setting.description}
                    error={errors[setting.key]?.message}
                    {...register(setting.key)}
                  />
                ))
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={() => void loadSettings()}
                  disabled={isLoading || isSaving}
                >
                  Reset
                </Button>
                <Button
                  type="submit"
                  size="md"
                  isLoading={isSaving}
                  disabled={isLoading || isSaving || changedSettings.length === 0}
                >
                  Save changes
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
