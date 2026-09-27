import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { UserManagementPage } from "./UserManagementPage";
import { createUser } from "../lib/api-client";

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

/** The text a screen reader is told explains why a field is invalid. */
function describedTextFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

/** Opens the add-account dialog and waits for it. */
async function openAddUserDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <MemoryRouter>
      <UserManagementPage />
    </MemoryRouter>
  );

  await user.click(await screen.findByRole("button", { name: "Add User" }));
  await screen.findByRole("heading", { name: "Add User" });
}

describe("UserManagementPage form", () => {
  it("reports every empty field beside itself and focuses the first", async () => {
    const user = userEvent.setup();
    await openAddUserDialog(user);

    await user.click(screen.getByRole("button", { name: "Save" }));

    const fullName = screen.getByLabelText("Full Name");
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");

    expect(fullName).toHaveAttribute("aria-invalid", "true");
    expect(fullName).toHaveFocus();
    expect(describedTextFor(fullName)).toContain("Full name is required");
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(username)).toContain("Username must be at least 3 characters");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(password)).toContain("Password must be at least 8 characters");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("posts the same new-user body the screen always sent", async () => {
    const user = userEvent.setup();
    await openAddUserDialog(user);

    await user.type(screen.getByLabelText("Full Name"), "Maria Santos");
    await user.type(screen.getByLabelText("Username"), "msantos");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(createUser).toHaveBeenCalledWith({
        fullName: "Maria Santos",
        username: "msantos",
        password: "correct-horse",
        role: "cashier",
      });
    });
  });
});
