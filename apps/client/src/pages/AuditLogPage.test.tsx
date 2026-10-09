// The audit trail's filter box, and the defect that came of querying on every
// keystroke: typing a user id sent a half-typed value, the API rightly refused it,
// and the operator was shown "A valid user id is required" while still typing.
//
// The fix keeps what is TYPED apart from what is APPLIED. This suite pins that: the
// trail must not be queried as a filter is typed, and the Filter button must query it.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@bcis/shared";
import { AuditLogPage } from "./AuditLogPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import { fetchDatabaseHealth, fetchServiceHealth, listAuditLogs } from "../lib/api-client";
import type { AuditLogFilters } from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    listAuditLogs: vi.fn(),
    // The shell's status badge polls these; without a stub they would reach for a
    // server that is not there.
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
  };
});

function signInAs(role: UserRole): void {
  useAuthStore.setState({
    token: "test-token",
    user: { id: "user-1", fullName: "Office Administrator", role },
    isAuthenticated: true,
    lockedSession: null,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AuditLogPage />
    </MemoryRouter>
  );
}

const EMPTY_PAGE = { items: [], page: 1, pageSize: 25, total: 0 };

/** The filters the page sent on its nth request. */
function filtersSentOn(call: number): AuditLogFilters {
  return vi.mocked(listAuditLogs).mock.calls[call]?.[0] ?? {};
}

describe("AuditLogPage filters", () => {
  beforeEach(() => {
    signInAs("admin");
    vi.clearAllMocks();
    vi.mocked(listAuditLogs).mockResolvedValue(EMPTY_PAGE);
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
  });

  afterEach(() => {
    useAuthStore.setState({
      token: null,
      user: null,
      isAuthenticated: false,
      lockedSession: null,
    });
  });

  it("does not query the trail while a filter is being typed", async () => {
    const user = userEvent.setup();
    renderPage();

    // The page's own first load, and nothing else.
    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Performed by"), "demo.cash");

    // Nine keystrokes, still one request: no half-typed value is ever sent, so the
    // API never has cause to answer "A valid user id is required" mid-typing.
    expect(listAuditLogs).toHaveBeenCalledTimes(1);
  });

  it("queries by username, and only when the operator asks", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Performed by"), "demo.cashier");
    await user.click(screen.getByRole("button", { name: "Filter" }));

    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(2));
    expect(filtersSentOn(1)).toMatchObject({ performedByUsername: "demo.cashier" });
  });

  it("sends no user filter when the box is empty", async () => {
    renderPage();

    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(1));
    expect(filtersSentOn(0).performedByUsername).toBeUndefined();
  });

  it("clears the applied filter as well as the typed one", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Performed by"), "demo.cashier");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(listAuditLogs).toHaveBeenCalledTimes(3));
    expect(filtersSentOn(2).performedByUsername).toBeUndefined();
    expect(screen.getByLabelText("Performed by")).toHaveValue("");
  });
});
