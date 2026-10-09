// Tests for password hashing. Pure — no server or database required.

import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";

import { hashPassword } from "../src/shared/password";
import { config } from "../src/config";

describe("password hashing", () => {
  it("produces a bcrypt hash that verifies against the original password", async () => {
    const hash = await hashPassword("super-secret-password");

    expect(hash).not.toBe("super-secret-password");
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare("super-secret-password", hash)).toBe(true);
  });

  it("never produces the same hash twice for the same password (salted)", async () => {
    const first = await hashPassword("same-password");
    const second = await hashPassword("same-password");

    expect(first).not.toBe(second);
    expect(await bcrypt.compare("same-password", first)).toBe(true);
    expect(await bcrypt.compare("same-password", second)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await bcrypt.compare("incorrect-password", hash)).toBe(false);
  });

  it("uses the configured cost factor rather than a hardcoded one", async () => {
    const hash = await hashPassword("cost-factor-probe");
    expect(bcrypt.getRounds(hash)).toBe(config.BCRYPT_ROUNDS);
  });
});