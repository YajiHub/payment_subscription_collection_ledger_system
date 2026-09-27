import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import { SelectField } from "../components/form/SelectField";
import { TextField } from "../components/form/TextField";
import { formResolver } from "../components/form/form-resolver";
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

// The three user schemas below mirror `apps/server/src/modules/users/users.handler.ts`
// rule for rule and message for message: `createUserBodySchema`,
// `updateUserBodySchema` and `changePasswordBodySchema` are handler-local and are
// not exported from `@bcis/shared`, so there is nothing shared to import. Keep the
// two files in step. All three cover the same four fields so every mode of the
// dialog has one form type.
const fullNameField = z.string().trim().min(1, "Full name is required").max(100);
const usernameField = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(50)
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username may only contain letters, numbers, dots, dashes, underscores"
  );
const passwordField = z.string().min(8, "Password must be at least 8 characters");
const roleField = z.enum(USER_ROLES);

/** Mirrors `createUserBodySchema`: every field is required. */
const createUserFormSchema = z.object({
  fullName: fullNameField,
  username: usernameField,
  password: passwordField,
  role: roleField,
});

/**
 * Mirrors `updateUserBodySchema`: only the name and the role are sent. The
 * username box is disabled in this mode and no password is captured.
 */
const editUserFormSchema = z.object({
  fullName: fullNameField,
  username: z.string(),
  password: z.string(),
  role: roleField,
});

/** Mirrors `changePasswordBodySchema`: only the new password is sent. */
const resetPasswordFormSchema = z.object({
  fullName: z.string(),
  username: z.string(),
  password: passwordField,
  role: roleField,
});

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

  // Each mode asks a different question, so it validates against its own schema.
  const userFormSchema =
    modalMode === "create"
      ? createUserFormSchema
      : modalMode === "password"
        ? resetPasswordFormSchema
        : editUserFormSchema;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<UserFormState>({
    resolver: formResolver(userFormSchema),
    defaultValues: emptyForm,
  });

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
    reset(emptyForm);
    setSelectedUser(null);
    setModalMode("create");
  }

  const openEditModal = useCallback(
    (user: ManagedUser): void => {
      reset({ fullName: user.fullName, username: user.username, password: "", role: user.role });
      setSelectedUser(user);
      setModalMode("edit");
    },
    [reset]
  );

  const openPasswordModal = useCallback(
    (user: ManagedUser): void => {
      reset({ ...emptyForm, fullName: user.fullName, username: user.username, role: user.role });
      setSelectedUser(user);
      setModalMode("password");
    },
    [reset]
  );

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

  // A rejected username or a refused password reset is the server's answer to a
  // valid-looking form, so it stays a banner rather than a field message.
  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);

    try {
      if (modalMode === "create") {
        await createUser({
          fullName: values.fullName,
          username: values.username,
          password: values.password,
          role: values.role,
        });
      } else if (modalMode === "edit" && selectedUser !== null) {
        await updateUser(selectedUser.id, { fullName: values.fullName, role: values.role });
      } else if (modalMode === "password" && selectedUser !== null) {
        await changeUserPassword(selectedUser.id, values.password);
      }
      closeModal();
      await loadUsers();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  });

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

      {errorMessage !== null && modalMode === null && (
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
            noValidate
            onSubmit={(event) => void onSubmit(event)}
            className="w-full max-w-sm space-y-4 rounded-lg bg-surface p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">
              {modalMode === "create" && "Add User"}
              {modalMode === "edit" && "Edit User"}
              {modalMode === "password" && "Reset Password"}
            </h2>

            {modalMode !== "password" && (
              <>
                <TextField
                  id="userFullName"
                  label="Full Name"
                  required
                  error={errors.fullName?.message}
                  {...register("fullName")}
                />

                <TextField
                  id="userUsername"
                  label="Username"
                  required
                  // React Hook Form drops a disabled field from the submitted
                  // values, so the username can never be rewritten by an edit.
                  disabled={modalMode === "edit"}
                  error={errors.username?.message}
                  {...register("username")}
                />

                <SelectField
                  id="userRole"
                  label="Role"
                  error={errors.role?.message}
                  {...register("role")}
                >
                  {USER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {USER_ROLE_LABELS[role]}
                    </option>
                  ))}
                </SelectField>
              </>
            )}

            {(modalMode === "create" || modalMode === "password") && (
              <TextField
                id="userPassword"
                label="Password"
                type="password"
                required
                hint="At least 8 characters."
                error={errors.password?.message}
                {...register("password")}
              />
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
