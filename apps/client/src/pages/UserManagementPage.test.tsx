import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { UserManagementPage } from "./UserManagementPage";

// The mock is hoisted above the imports, so its fixture lives inside the factory
// rather than in a module-level constant it could not yet see.
vi.mock("../lib/api-client", () => ({
  listUsers: vi.fn(async () => ({
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        fullName: "Office Administrator",
        username: "admin",
        role: "admin",
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
  })),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  changeUserPassword: vi.fn(),
  setUserActiveState: vi.fn(),
  extractApiErrorMessage: vi.fn(() => "Something went wrong."),
}));

/**
 * The Electron smoke check (`scripts/verify-electron-gui.cjs`) asserts this
 * screen's heading, its add-account button and its role column by their exact
 * strings. This test is the contract: if the copy below changes, the smoke check
 * must change with it, and this test says so out loud.
 */
describe("UserManagementPage copy contract", () => {
  it("renders the heading and add-account button the smoke check asserts", async () => {
    render(
      <MemoryRouter>
        <UserManagementPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "User Management" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add User" })).toBeInTheDocument();
  });

  it("renders the role column the smoke check asserts", async () => {
    render(
      <MemoryRouter>
        <UserManagementPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("columnheader", { name: /role/i })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Office Administrator" })).toBeInTheDocument();
  });
});
