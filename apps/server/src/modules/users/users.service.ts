// Database operations for user management.
// Route handlers never touch the database directly — they call these functions.

import { count, desc, eq } from "drizzle-orm";

import { db } from "../../db/connection";
import { users } from "../../db/schema/users";
import { ConflictError, NotFoundError } from "../../shared/errors";
import { hashPassword } from "../../shared/password";
import type { UserRole } from "@bcis/shared";

// Everything about a user that is safe to send to a client.
// Note the absence of passwordHash — hashes never leave the server.
export interface UserSummary {
  id: string;
  fullName: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSummaryColumns = {
  id: users.id,
  fullName: users.fullName,
  username: users.username,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export interface PaginatedUsers {
  items: UserSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** Returns one page of users, newest first, plus the total row count. */
export async function listUsers(page: number, pageSize: number): Promise<PaginatedUsers> {
  const offset = (page - 1) * pageSize;

  const items = await db
    .select(userSummaryColumns)
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(pageSize)
    .offset(offset);

  const total = await db
    .select({ value: count() })
    .from(users)
    .then((rows) => rows[0]?.value ?? 0);

  return { items, page, pageSize, total };
}

/** Loads a single user, or throws NotFoundError so the route returns 404. */
export async function getUserById(userId: string): Promise<UserSummary> {
  const user = await db
    .select(userSummaryColumns)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0]);

  if (user === undefined) {
    throw new NotFoundError("User not found");
  }

  return user;
}

export interface CreateUserInput {
  fullName: string;
  username: string;
  password: string;
  role: UserRole;
  createdBy: string;
}

/** Creates a user. Rejects a username that is already taken. */
export async function createUser(input: CreateUserInput): Promise<UserSummary> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing !== undefined) {
    throw new ConflictError("A user with that username already exists");
  }

  const passwordHash = await hashPassword(input.password);

  const created = await db
    .insert(users)
    .values({
      fullName: input.fullName,
      username: input.username,
      passwordHash,
      role: input.role,
      createdBy: input.createdBy,
    })
    .returning(userSummaryColumns)
    .then((rows) => rows[0]);

  // `.returning()` always yields the inserted row; the guard keeps types honest.
  if (created === undefined) {
    throw new NotFoundError("User could not be created");
  }

  return created;
}

export interface UpdateUserInput {
  fullName?: string;
  role?: UserRole;
}

/** Updates a user's display name and/or role. Usernames are immutable. */
export async function updateUser(userId: string, input: UpdateUserInput): Promise<UserSummary> {
  const updated = await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning(userSummaryColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("User not found");
  }

  return updated;
}

/** Admin-initiated password reset. Stores a fresh bcrypt hash. */
export async function changeUserPassword(
  userId: string,
  newPassword: string
): Promise<UserSummary> {
  const passwordHash = await hashPassword(newPassword);

  const updated = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning(userSummaryColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("User not found");
  }

  return updated;
}

/**
 * Soft-enables or soft-disables an account.
 * Users are never deleted, because financial records reference them forever.
 */
export async function setUserActiveState(userId: string, isActive: boolean): Promise<UserSummary> {
  const updated = await db
    .update(users)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning(userSummaryColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("User not found");
  }

  return updated;
}
