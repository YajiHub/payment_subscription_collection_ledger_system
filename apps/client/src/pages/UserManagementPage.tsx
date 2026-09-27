import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { USER_ROLE_LABELS, USER_ROLES, type UserRole } from "@bcis/shared";
import {
  changeUserPassword,
  createUser,
  extractApiErrorMessage,
  listUsers,
  setUserActiveState,
  updateUser,
  type ManagedUser,
} from "../lib/api-client";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { EmptyState } from "../components/ui/EmptyState";

interface UserFormState {
  fullName: string;
  username: string;
  password: string;
  role: UserRole;
}

const emptyForm: UserFormState = {
  fullName: "",
  username: "",
  password: "",
  role: "cashier",
};

/** The page size the screen opens with. Server-side paging caps it at 200. */
const DEFAULT_PAGE_SIZE = 20;

type ModalMode = "create" | "edit" | "password" | null;

/**
 * Admin-only user management screen.
 * Users are never deleted — only deactivated — because financial records
 * reference them permanently.
 */
export function UserManagementPage(): ReactNode {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedUser, setSelectedUser] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);

  const loadUsers = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listUsers(page, pageSize);
      setUsers(result.items);
      setTotal(result.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  function openCreateModal(): void {
    setForm(emptyForm);
    setSelectedUser(null);
    setModalMode("create");
  }

  const openEditModal = useCallback((user: ManagedUser): void => {
    setForm({ fullName: user.fullName, username: user.username, password: "", role: user.role });
    setSelectedUser(user);
    setModalMode("edit");
  }, []);

  const openPasswordModal = useCallback((user: ManagedUser): void => {
    setForm({ ...emptyForm, fullName: user.fullName, username: user.username, role: user.role });
    setSelectedUser(user);
    setModalMode("password");
  }, []);

  function closeModal(): void {
    setModalMode(null);
    setSelectedUser(null);
    setErrorMessage(null);
  }

  const toggleActive = useCallback(
    async (user: ManagedUser): Promise<void> => {
      setErrorMessage(null);
      try {
        await setUserActiveState(user.id, !user.isActive);
        await loadUsers();
      } catch (error) {
        setErrorMessage(extractApiErrorMessage(error));
      }
    },
    [loadUsers]
  );

  const columns = useMemo<TableColumn<ManagedUser>[]>(
    () => [
      {
        id: "fullName",
        header: "Full Name",
        sortValue: (user) => user.fullName,
        cell: (user) => user.fullName,
      },
      {
        id: "username",
        header: "Username",
        cellClassName: "font-mono",
        sortValue: (user) => user.username,
        cell: (user) => user.username,
      },
      {
        id: "role",
        header: "Role",
        sortValue: (user) => user.role,
        cell: (user) => USER_ROLE_LABELS[user.role],
      },
      {
        id: "isActive",
        header: "Status",
        sortValue: (user) => (user.isActive ? 1 : 0),
        cell: (user) => (
          <span
            className={
              user.isActive
                ? "rounded-full bg-success-soft px-2 py-0.5 text-xs text-success-strong"
                : "rounded-full bg-canvas px-2 py-0.5 text-xs text-content-secondary"
            }
          >
            {user.isActive ? "Active" : "Deactivated"}
          </span>
        ),
      },
      {
        id: "createdAt",
        header: "Created At",
        sortValue: (user) => user.createdAt,
        cell: (user) => new Date(user.createdAt).toLocaleDateString(),
      },
      {
        id: "actions",
        header: "Actions",
        cellClassName: "space-x-3",
        cell: (user) => (
          <>
            <button
              type="button"
              onClick={() => openEditModal(user)}
              className="text-content-primary underline"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => openPasswordModal(user)}
              className="text-content-primary underline"
            >
              Reset Password
            </button>
            <button
              type="button"
              onClick={() => void toggleActive(user)}
              className={user.isActive ? "text-danger-strong underline" : "text-success-strong underline"}
            >
              {user.isActive ? "Deactivate" : "Activate"}
            </button>
          </>
        ),
      },
    ],
    [openEditModal, openPasswordModal, toggleActive]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    try {
      if (modalMode === "create") {
        await createUser({
          fullName: form.fullName,
          username: form.username,
          password: form.password,
          role: form.role,
        });
      } else if (modalMode === "edit" && selectedUser !== null) {
        await updateUser(selectedUser.id, { fullName: form.fullName, role: form.role });
      } else if (modalMode === "password" && selectedUser !== null) {
        await changeUserPassword(selectedUser.id, form.password);
      }
      closeModal();
      await loadUsers();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">User Management</h1>
          <p className="text-sm text-content-secondary">Create accounts, change roles, deactivate users.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-medium text-content-primary underline">
            Dashboard
          </Link>
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong"
          >
            Add User
          </button>
        </div>
      </header>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
        >
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <DataTable
          columns={columns}
          data={users}
          getRowId={(user) => user.id}
          isLoading={isLoading}
          emptyState={
            <EmptyState
              title="No users yet"
              description="Add the first staff account to let a colleague sign in."
            />
          }
          pagination={{
            page,
            pageSize,
            total,
            rowNoun: "user",
            onPageChange: setPage,
            onPageSizeChange: (nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            },
          }}
        />
      </div>

      {modalMode !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-sm space-y-4 rounded-lg bg-surface p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">
              {modalMode === "create" && "Add User"}
              {modalMode === "edit" && "Edit User"}
              {modalMode === "password" && "Reset Password"}
            </h2>

            {modalMode !== "password" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-content-primary">Full Name</span>
                  <input
                    type="text"
                    value={form.fullName}
                    onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                    required
                    className="w-full rounded border border-line-strong px-3 py-2 text-sm"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium text-content-primary">Username</span>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    disabled={modalMode === "edit"}
                    required
                    className="w-full rounded border border-line-strong px-3 py-2 text-sm disabled:bg-canvas"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium text-content-primary">Role</span>
                  <select
                    value={form.role}
                    onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}
                    className="w-full rounded border border-line-strong px-3 py-2 text-sm"
                  >
                    {USER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {USER_ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {(modalMode === "create" || modalMode === "password") && (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-content-primary">Password</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  minLength={8}
                  required
                  className="w-full rounded border border-line-strong px-3 py-2 text-sm"
                />
                <span className="text-xs text-content-secondary">At least 8 characters.</span>
              </label>
            )}

            {errorMessage !== null && (
              <p
                role="alert"
                className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
              >
                {errorMessage}
              </p>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeModal}
                className="rounded border border-line-strong px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
