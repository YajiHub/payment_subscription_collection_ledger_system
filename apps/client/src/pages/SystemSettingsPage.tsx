import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { SystemSetting } from "@bcis/shared";
import { extractApiErrorMessage, getSystemSettings, updateSystemSettings } from "../lib/api-client";

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
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">System Settings</h1>
          <p className="text-sm text-slate-600">
            Business rules used across billing, receipts, and reports.
          </p>
        </div>
        <Link to="/" className="text-sm font-medium text-slate-700 underline">
          Dashboard
        </Link>
      </header>

      {errorMessage !== null && (
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}
      {savedMessage !== null && (
        <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {savedMessage}
        </p>
      )}

      <form
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(event) => void handleSubmit(event)}
      >
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading settings…</p>
        ) : (
          settings.map((setting) => (
            <label key={setting.key} className="block space-y-1">
              <span className="text-sm font-medium text-slate-800">{setting.key}</span>
              <input
                className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
                value={draftValues[setting.key] ?? ""}
                onChange={(event) =>
                  setDraftValues({ ...draftValues, [setting.key]: event.target.value })
                }
              />
              <span className="block text-xs text-slate-500">{setting.description}</span>
            </label>
          ))
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
            onClick={() => void loadSettings()}
            disabled={isLoading || isSaving}
          >
            Reset
          </button>
          <button
            type="submit"
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={isLoading || isSaving || changedSettings.length === 0}
          >
            {isSaving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </main>
  );
}
