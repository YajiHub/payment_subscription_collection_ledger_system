import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@bcis/shared";
import { BackupManagementPage } from "./BackupManagementPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  createBackup,
  fetchDatabaseHealth,
  fetchServiceHealth,
  listBackups,
  restoreBackup,
  verifyBackup,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    listBackups: vi.fn(),
    createBackup: vi.fn(),
    verifyBackup: vi.fn(),
    restoreBackup: vi.fn(),
  };
});

const VERIFIED_BACKUP = {
  id: "11111111-1111-4111-8111-111111111111",
  filename: "bcis_backup_2026-01-15.sql.gz",
  sizeBytes: 1_572_864,
  checksum: "a3f1c0d9b7e45216aa0c9f8ee1d2b3c4a5f60718293a4b5c6d7e8f9012345678",
  checksumAlgorithm: "sha256",
  createdBy: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-01-15T03:00:00.000Z",
  verifiedAt: "2026-01-15T03:00:12.000Z",
  restoreTestedAt: null,
  notes: "Created and verified by the application",
};

function signInAs(role: UserRole): void {
  useAuthStore.setState({
    token: "test-token",
    user: { id: "user-1", fullName: "Office Administrator", role },
    isAuthenticated: true,
    lockedSession: null,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <BackupManagementPage />
    </MemoryRouter>
  );
}

/**
 * S5-3 / AT-12. Restoring overwrites the live database, so the screen must not
 * offer it as a single unlabelled button, and a user who cannot use the feature
 * must not be shown its controls at all.
 */
describe("BackupManagementPage", () => {
  beforeEach(() => {
    signInAs("admin");
    vi.clearAllMocks();
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listBackups).mockResolvedValue([VERIFIED_BACKUP]);
    vi.mocked(createBackup).mockResolvedValue(VERIFIED_BACKUP);
    vi.mocked(verifyBackup).mockResolvedValue(VERIFIED_BACKUP);
    vi.mocked(restoreBackup).mockResolvedValue(VERIFIED_BACKUP);
  });

  afterEach(() => {
    useAuthStore.setState({
      token: null,
      user: null,
      isAuthenticated: false,
      lockedSession: null,
    });
  });

  it("lists the history with size, checksum, creator and verification state", async () => {
    renderPage();

    expect(await screen.findByText("bcis_backup_2026-01-15.sql.gz")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText("a3f1c0d9b7e4")).toBeInTheDocument();
    expect(screen.getByText(/Verified/)).toBeInTheDocument();
  });

  it("creates a backup and reports the verified result", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create backup" }));

    await waitFor(() => {
      expect(vi.mocked(createBackup)).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Backup created and verified: bcis_backup_2026-01-15.sql.gz (1.5 MB)."
    );
  });

  it("requires the operator to acknowledge the overwrite before restoring", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Restore…" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/overwrites the live database/)).toBeInTheDocument();
    expect(within(dialog).getByText(/users, roles and system settings/)).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: "Restore and overwrite database",
    });
    expect(confirmButton).toBeDisabled();

    // Pressing the unacknowledged control must not reach the API at all.
    await user.click(confirmButton);
    expect(vi.mocked(restoreBackup)).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("checkbox"));
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    await waitFor(() => {
      expect(vi.mocked(restoreBackup)).toHaveBeenCalledWith(VERIFIED_BACKUP.id, { confirm: true });
    });
  });

  it("does not offer a restore of an unverified backup", async () => {
    vi.mocked(listBackups).mockResolvedValue([{ ...VERIFIED_BACKUP, verifiedAt: null }]);
    renderPage();

    const restoreButton = await screen.findByRole("button", { name: "Restore…" });
    expect(restoreButton).toBeDisabled();
    expect(restoreButton).toHaveAttribute("title", "Verify this backup before it can be restored");
  });

  it("hides every control from a user without the backup permissions", async () => {
    signInAs("cashier");
    renderPage();

    expect(await screen.findByText("bcis_backup_2026-01-15.sql.gz")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create backup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore…" })).not.toBeInTheDocument();
  });
});
