// A reusable picker for choosing service accounts to put in a collector batch.
//
// It searches subscribers by name/account number and offers each subscriber's
// service accounts as checkboxes. All data comes from the API client — the renderer
// never reaches the database directly.

import type { ReactNode } from "react";
import { useState } from "react";

import {
  extractApiErrorMessage,
  searchSubscribers,
  type ServiceAccount,
} from "../lib/api-client";

interface ServiceAccountPickerProps {
  /** The service account ids already selected. */
  selectedIds: string[];
  /** Called with the new selection whenever an account is toggled. */
  onChange: (ids: string[]) => void;
}

interface SubscriberOption {
  id: string;
  name: string;
  accountNumber: string;
  serviceAccounts: ServiceAccount[];
}

export function ServiceAccountPicker({
  selectedIds,
  onChange,
}: ServiceAccountPickerProps): ReactNode {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SubscriberOption[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function handleSearch(): Promise<void> {
    if (query.trim() === "") {
      setOptions([]);
      return;
    }

    setIsSearching(true);
    setErrorMessage(null);
    try {
      const page = await searchSubscribers(query.trim());
      setOptions(
        page.items.map((subscriber) => ({
          id: subscriber.id,
          name: `${subscriber.lastName}, ${subscriber.firstName}`,
          accountNumber: subscriber.accountNumber,
          serviceAccounts: subscriber.serviceAccounts,
        }))
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSearching(false);
    }
  }

  function toggle(serviceAccountId: string): void {
    if (selectedIds.includes(serviceAccountId)) {
      onChange(selectedIds.filter((id) => id !== serviceAccountId));
      return;
    }
    onChange([...selectedIds, serviceAccountId]);
  }

  return (
    <div className="space-y-3 rounded border border-slate-200 p-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSearch();
            }
          }}
          placeholder="Search a subscriber by name, account number, or phone"
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={() => void handleSearch()}
          className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
        >
          {isSearching ? "Searching…" : "Search"}
        </button>
      </div>

      {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}

      {options.length > 0 && (
        <ul className="space-y-2">
          {options.map((option) => (
            <li key={option.id} className="rounded border border-slate-100 p-2">
              <p className="text-sm font-medium">
                {option.name}{" "}
                <span className="font-mono text-xs text-slate-500">{option.accountNumber}</span>
              </p>
              {option.serviceAccounts.length === 0 ? (
                <p className="text-xs text-slate-500">No service accounts.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {option.serviceAccounts.map((account) => (
                    <li key={account.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(account.id)}
                          onChange={() => toggle(account.id)}
                        />
                        <span className="font-mono text-xs">{account.serviceAccountNumber}</span>
                        <span>{account.planName}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {selectedIds.length} service account{selectedIds.length === 1 ? "" : "s"} selected.
      </p>
    </div>
  );
}