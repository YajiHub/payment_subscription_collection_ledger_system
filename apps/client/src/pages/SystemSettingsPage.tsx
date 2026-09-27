import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { SystemSetting } from "@bcis/shared";
import { extractApiErrorMessage, getSystemSettings, updateSystemSettings } from "../lib/api-client";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Skeleton } from "../components/ui/Skeleton";

const fieldClass =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Admin-only system settings screen.
 * The business rules here (late fee, due day, company details) are stored in the
 * database, not hardcoded, so they can be changed without a code change.
 */
export function SystemSettingsPage(): ReactNode {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const loadSettings = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const items = await getSystemSettings();
      setSettings(items);
      setDraftValues(Object.fromEntries(items.map((setting) => [setting.key, setting.value])));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const changedSettings = settings
    .filter((setting) => draftValues[setting.key] !== setting.value)
    .map((setting) => ({ key: setting.key, value: draftValues[setting.key] ?? setting.value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setSavedMessage(null);

    if (changedSettings.length === 0) {
      setSavedMessage("No changes to save.");
      return;
    }

    setIsSaving(true);
    try {
      const updated = await updateSystemSettings(changedSettings);
      setSettings(updated);
      setDraftValues(Object.fromEntries(updated.map((setting) => [setting.key, setting.value])));
      setSavedMessage(`Saved ${changedSettings.length} setting(s).`);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

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
      <div className="max-w-3xl space-y-5">
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
            <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
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
                  <label key={setting.key} className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">{setting.key}</span>
                    <input
                      className={fieldClass}
                      value={draftValues[setting.key] ?? ""}
                      onChange={(event) =>
                        setDraftValues({ ...draftValues, [setting.key]: event.target.value })
                      }
                    />
                    <span className="block text-xs text-content-secondary">{setting.description}</span>
                  </label>
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
