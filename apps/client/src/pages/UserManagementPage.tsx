import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
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

type ModalMode = "create" | "edit" | "password" | null;

/**
 * Admin-only user management screen.
 * Users are never deleted — only deactivated — because financial records
 * reference them permanently.
 */
export function UserManagementPage(): ReactNode {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedUser, setSelectedUser] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);

  const loadUsers = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await listUsers(1, 100);
      setUsers(page.items);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  function openCreateModal(): void {
    setForm(emptyForm);
    setSelectedUser(null);
    setModalMode("create");
  }

  function openEditModal(user: ManagedUser): void {
    setForm({ fullName: user.fullName, username: user.username, password: "", role: user.role });
    setSelectedUser(user);
    setModalMode("edit");
  }

  function openPasswordModal(user: ManagedUser): void {
    setForm({ ...emptyForm, fullName: user.fullName, username: user.username, role: user.role });
    setSelectedUser(user);
    setModalMode("password");
  }

  function closeModal(): void {
    setModalMode(null);
    setSelectedUser(null);
    setErrorMessage(null);
  }

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

  async function toggleActive(user: ManagedUser): Promise<void> {
    setErrorMessage(null);
    try {
      await setUserActiveState(user.id, !user.isActive);
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
          <p className="text-sm text-slate-600">Create accounts, change roles, deactivate users.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-medium text-slate-700 underline">
            Dashboard
          </Link>
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Add User
          </button>
        </div>
      </header>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Full Name</th>
              <th className="px-4 py-3 font-medium">Username</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Created At</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Loading users…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  No users yet.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">{user.fullName}</td>
                  <td className="px-4 py-3 font-mono">{user.username}</td>
                  <td className="px-4 py-3">{USER_ROLE_LABELS[user.role]}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        user.isActive
                          ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                          : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                      }
                    >
                      {user.isActive ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td className="px-4 py-3">{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td className="space-x-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openEditModal(user)}
                      className="text-slate-700 underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => openPasswordModal(user)}
                      className="text-slate-700 underline"
                    >
                      Reset Password
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleActive(user)}
                      className={
                        user.isActive ? "text-red-700 underline" : "text-emerald-700 underline"
                      }
                    >
                      {user.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalMode !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">
              {modalMode === "create" && "Add User"}
              {modalMode === "edit" && "Edit User"}
              {modalMode === "password" && "Reset Password"}
            </h2>

            {modalMode !== "password" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Full Name</span>
                  <input
                    type="text"
                    value={form.fullName}
                    onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                    required
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Username</span>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    disabled={modalMode === "edit"}
                    required
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Role</span>
                  <select
                    value={form.role}
                    onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
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
                <span className="text-sm font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  minLength={8}
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
                <span className="text-xs text-slate-500">At least 8 characters.</span>
              </label>
            )}

            {errorMessage !== null && (
              <p
                role="alert"
                className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {errorMessage}
              </p>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeModal}
                className="rounded border border-slate-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
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
