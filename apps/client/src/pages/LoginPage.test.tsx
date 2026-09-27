import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "./LoginPage";
import { login } from "../lib/api-client";

vi.mock("../lib/api-client", () => ({
  login: vi.fn(async () => ({
    token: "test-token",
    user: { id: "u1", fullName: "Office Administrator", role: "admin" },
  })),
  extractApiErrorMessage: vi.fn(() => "Something went wrong."),
}));

/** The text a screen reader is told explains why a field is invalid. */
function describedTextFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.mocked(login).mockClear();
  });

  it("shows the empty-field message beside the field and focuses the first one", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "Login" }));

    const username = screen.getByLabelText("Username");
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(username)).toContain("Username is required");
    expect(username).toHaveFocus();
    expect(login).not.toHaveBeenCalled();
  });

  it("signs in with the credentials that were typed", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith("admin", "correct-horse");
    });
  });
});
