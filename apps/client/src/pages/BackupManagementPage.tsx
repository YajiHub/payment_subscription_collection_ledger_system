// S5-3 / S8-3 / AT-12: the backup and restore screen.
//
// The server half already exists and is tested: it produces a verified archive,
// records it in `backup_history`, and refuses to restore anything that is not
// verified. This screen is the operator's way in, and it is built around the fact
// that the last button on it destroys the live database.
//
// Two permissions, deliberately separate: `backup:create` lists, produces and
// re-verifies archives; `backup:restore` overwrites the database from one. The
// server enforces both on every request — hiding the controls here is only so an
// operator is not offered a button that would be refused.

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, HardDriveDownload, ShieldCheck } from "lucide-react";

import { roleHasPermission } from "@bcis/shared";
import {
  createBackup,
  extractApiErrorMessage,
  listBackups,
  listUsers,
  restoreBackup,
  verifyBackup,
  type BackupRecord,
} from "../lib/api-client";
import { formatBytes, formatTimestamp } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";

/** How much of a sha256 digest is shown; the whole digest is in the row's title. */
const CHECKSUM_PREFIX_LENGTH = 12;

/** The users a page can name; the backup history never holds more creators than this. */
const USER_DIRECTORY_PAGE_SIZE = 100;

/** The acknowledgement the restore dialog must collect before it does anything. */
const RESTORE_ACKNOWLEDGEMENT =
  "I understand this replaces every record currently in the database.";

/** What the live database holds, named so the confirmation says what it overwrites. */
const OVERWRITTEN_CONTENTS = [
  "subscribers and their service accounts",
  "subscription plans and prices",
  "invoices, ledger entries and running balances",
  "payments, receipts, collector batches and remittances",
  "users, roles and system settings",
  "the audit trail",
] as const;

function shortChecksum(checksum: string): string {
  return checksum.slice(0, CHECKSUM_PREFIX_LENGTH);
}

/**
 * The Administration screen for backups (S5-3).
 *
 * Restoring is destructive, so it is never one unlabelled button: the row opens a
 * dialog that names the archive, states what will be overwritten, and requires the
 * operator to acknowledge that before the restore control becomes usable.
 */
export function BackupManagementPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const mayCreate = user !== null && roleHasPermission(user.role, "backup:create");
  const mayRestore = user !== null && roleHasPermission(user.role, "backup:restore");
  const mayReadUsers = user !== null && roleHasPermission(user.role, "users:read");

  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [busyBackupId, setBusyBackupId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [hasAcknowledgedOverwrite, setHasAcknowledgedOverwrite] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const loadBackups = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setBackups(await listBackups());
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  // A `created_by` is a user id. Naming the person is worth one request when this
  // operator is allowed to read the user list at all; otherwise the id is shown.
  useEffect(() => {
    if (!mayReadUsers) {
      return;
    }

    let isCancelled = false;

    void listUsers(1, USER_DIRECTORY_PAGE_SIZE)
      .then((page) => {
        if (isCancelled) {
          return;
        }
        setCreatorNames(Object.fromEntries(page.items.map((entry) => [entry.id, entry.fullName])));
      })
      .catch(() => {
        // The backup list is still useful without names; leave the ids in place.
      });

    return () => {
      isCancelled = true;
    };
  }, [mayReadUsers]);

  async function handleCreateBackup(): Promise<void> {
    setIsCreating(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const created = await createBackup();
      setStatusMessage(
        `Backup created and verified: ${created.filename} (${formatBytes(created.sizeBytes)}).`
      );
      await loadBackups();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleVerify(backup: BackupRecord): Promise<void> {
    setBusyBackupId(backup.id);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      await verifyBackup(backup.id);
      setStatusMessage(`${backup.filename} passed a fresh integrity check.`);
      await loadBackups();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setBusyBackupId(null);
    }
  }

  function openRestoreDialog(backup: BackupRecord): void {
    setRestoreTarget(backup);
    setHasAcknowledgedOverwrite(false);
  }

  function closeRestoreDialog(): void {
    if (isRestoring) {
      return;
    }
    setRestoreTarget(null);
    setHasAcknowledgedOverwrite(false);
  }

  async function handleRestore(): Promise<void> {
    if (restoreTarget === null || !hasAcknowledgedOverwrite) {
      return;
    }

    setIsRestoring(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const restored = await restoreBackup(restoreTarget.id, { confirm: true });
      setStatusMessage(
        `Database restored from ${restored.filename}. Sign in again if any screen looks stale.`
      );
      setRestoreTarget(null);
      setHasAcknowledgedOverwrite(false);
      await loadBackups();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsRestoring(false);
    }
  }

  function creatorLabel(backup: BackupRecord): string {
    if (backup.createdBy === null) {
      return "Scheduled";
    }
    return creatorNames[backup.createdBy] ?? backup.createdBy;
  }

  const columns: TableColumn<BackupRecord>[] = [
    {
      id: "filename",
      header: "File",
      sortValue: (backup) => backup.filename,
      cell: (backup) => (
        <span className="font-mono text-xs text-content-primary">{backup.filename}</span>
      ),
    },
    {
      id: "size",
      header: "Size",
      align: "right",
      sortValue: (backup) => backup.sizeBytes,
      cellClassName: "tabular-nums",
      cell: (backup) => formatBytes(backup.sizeBytes),
    },
    {
      id: "checksum",
      header: "Checksum",
      sortValue: (backup) => backup.checksum,
      cell: (backup) => (
        <span className="font-mono text-xs text-content-secondary" title={backup.checksum}>
          {shortChecksum(backup.checksum)}
        </span>
      ),
    },
    {
      id: "createdBy",
      header: "Created by",
      sortValue: (backup) => creatorLabel(backup),
      cell: (backup) => creatorLabel(backup),
    },
    {
      id: "createdAt",
      header: "Created at",
      sortValue: (backup) => backup.createdAt,
      cell: (backup) => formatTimestamp(backup.createdAt),
    },
    {
      id: "verification",
      header: "Verification",
      sortValue: (backup) => (backup.verifiedAt === null ? "Not verified" : "Verified"),
      cell: (backup) =>
        backup.verifiedAt === null ? (
          <Badge variant="warning">Not verified</Badge>
        ) : (
          <Badge variant="success">Verified {formatTimestamp(backup.verifiedAt)}</Badge>
        ),
    },
    {
      id: "restoreTestedAt",
      header: "Last restore test",
      sortValue: (backup) => backup.restoreTestedAt ?? "",
      cell: (backup) => formatTimestamp(backup.restoreTestedAt),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (backup) => (
        <div className="flex flex-wrap items-center gap-2">
          {mayCreate && (
            <Button
              variant="outline"
              size="sm"
              isLoading={busyBackupId === backup.id}
              disabled={busyBackupId !== null}
              onClick={() => void handleVerify(backup)}
            >
              Verify
            </Button>
          )}
          {mayRestore && (
            <Button
              variant="outline"
              size="sm"
              disabled={backup.verifiedAt === null}
              title={
                backup.verifiedAt === null
                  ? "Verify this backup before it can be restored"
                  : `Restore the database from ${backup.filename}`
              }
              onClick={() => openRestoreDialog(backup)}
            >
              Restore…
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <AppShell
      pageTitle="Backup &amp; Restore"
      pageDescription="Produce verified database archives and restore the live database from an approved one."
      headerActions={
        mayCreate ? (
          <Button
            size="md"
            leftIcon={<HardDriveDownload className="h-4 w-4" aria-hidden="true" />}
            isLoading={isCreating}
            onClick={() => void handleCreateBackup()}
          >
            Create backup
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadBackups()} />
        )}

        {statusMessage !== null && (
          <div
            role="status"
            className="flex items-center gap-2.5 rounded-xl border border-success-line bg-success-soft px-4 py-3"
          >
            <ShieldCheck className="h-4 w-4 text-success-strong" aria-hidden="true" />
            <span className="text-sm text-success-strong">{statusMessage}</span>
          </div>
        )}

        {isCreating && (
          <div role="status" className="text-sm text-content-secondary">
            Dumping the database and verifying the archive. A large database takes a moment.
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Backup history</CardTitle>
            <CardDescription>
              Every archive this system has produced, newest first, with the integrity check that
              admitted it.
            </CardDescription>
          </CardHeader>

          <CardContent padding="none">
            <DataTable
              columns={columns}
              data={backups}
              getRowId={(backup) => backup.id}
              isLoading={isLoading}
              emptyState={
                <EmptyState
                  icon={<DatabaseBackup className="h-6 w-6" aria-hidden="true" />}
                  title="No backups recorded yet"
                  description="No archive has been produced from this installation. Create one before the activity's restore check."
                />
              }
            />
          </CardContent>
        </Card>
      </div>

      <Modal
        isOpen={restoreTarget !== null}
        onClose={closeRestoreDialog}
        title="Restore the database"
        description={
          restoreTarget === null
            ? undefined
            : `This overwrites the live database with ${restoreTarget.filename}.`
        }
        footer={
          <>
            <Button variant="outline" size="md" disabled={isRestoring} onClick={closeRestoreDialog}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              isLoading={isRestoring}
              disabled={!hasAcknowledgedOverwrite}
              title={
                hasAcknowledgedOverwrite
                  ? undefined
                  : "Tick the acknowledgement above to enable this"
              }
              onClick={() => void handleRestore()}
            >
              Restore and overwrite database
            </Button>
          </>
        }
      >
        {restoreTarget !== null && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-content-secondary">Archive</dt>
              <dd className="font-mono text-xs text-content-primary">{restoreTarget.filename}</dd>
              <dt className="text-content-secondary">Size</dt>
              <dd className="tabular-nums">{formatBytes(restoreTarget.sizeBytes)}</dd>
              <dt className="text-content-secondary">Checksum</dt>
              <dd className="font-mono text-xs break-all">{restoreTarget.checksum}</dd>
              <dt className="text-content-secondary">Verified</dt>
              <dd>{formatTimestamp(restoreTarget.verifiedAt)}</dd>
            </dl>

            <div className="space-y-2 rounded-lg border border-danger-line bg-danger-soft p-3">
              <p className="text-sm font-medium text-danger-strong">
                Restoring replaces everything now in the database:
              </p>
              <ul className="list-inside list-disc space-y-1 text-sm text-danger-strong">
                {OVERWRITTEN_CONTENTS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="text-sm text-danger-strong">
                Any work recorded after this archive was taken is lost. There is no undo.
              </p>
            </div>

            <label className="flex items-start gap-2 text-sm text-content-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={hasAcknowledgedOverwrite}
                onChange={(event) => setHasAcknowledgedOverwrite(event.target.checked)}
              />
              {RESTORE_ACKNOWLEDGEMENT}
            </label>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
