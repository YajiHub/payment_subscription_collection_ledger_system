// The single place passwords are turned into bcrypt hashes.
// bcrypt is deliberately slow; the cost factor comes from config so it can be
// raised over time without editing code.

import bcrypt from "bcrypt";

import { config } from "../config";

/** Hashes a plain password for storage. The plain value is never persisted. */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, config.BCRYPT_ROUNDS);
}
