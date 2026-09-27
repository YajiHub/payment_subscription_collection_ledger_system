import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SuspensionOperationsPage } from "./SuspensionOperationsPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  fetchDatabaseHealth,
  fetchServiceHealth,
  getSuspensionCandidates,
  runSuspensionCandidates,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getSuspensionCandidates: vi.fn(),
    runSuspensionCandidates: vi.fn(),
  };
});

const ONE_CANDIDATE = {
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Dela Cruz, Juan",
  oldestDueDate: "2025-11-01",
  daysPastDue: 62,
  totalOverdueCentavos: 199800,
};

const PREVIEW = {
  thresholdDays: 30,
  asOfDate: "2026-01-01",
  candidates: [ONE_CANDIDATE],
  candidateCount: 1,
  totalOverdueCentavos: 199800,
};

/**
 * Previewing is a read; running is the write. S4-7 and the audit's own words
 * require an operator to see the effect before causing it, so the preview must
 * never suspend anything and the run must be reachable only after a preview.
 */
describe("SuspensionOperationsPage", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(getSuspensionCandidates).mockResolvedValue(PREVIEW);
    vi.mocked(runSuspensionCandidates).mockResolvedValue({
      thresholdDays: 30,
      asOfDate: "2026-01-01",
      suspended: [ONE_CANDIDATE],
      failed: [],
    });

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Admin", role: "admin" },
      isAuthenticated: true,
    });
  });

  it("previews the candidates without suspending anything", async () => {
    render(
      <MemoryRouter>
        <SuspensionOperationsPage />
      </MemoryRouter>
    );

    // Before a preview, the run is not reachable at all.
    expect(screen.getByRole("button", { name: "Run suspension" })).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", { name: "Preview candidates (no changes)" })
    );

    // The candidate is listed, and the panel makes clear nothing happened.
    expect(await screen.findByText("SA-000001")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing has been suspended/i)
    ).toBeInTheDocument();

    // Previewing must not have mutated anything.
    expect(runSuspensionCandidates).not.toHaveBeenCalled();
  });

  it("only runs the suspensions after the preview and a confirmation", async () => {
    render(
      <MemoryRouter>
        <SuspensionOperationsPage />
      </MemoryRouter>
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Preview candidates (no changes)" })
    );
    await screen.findByText("SA-000001");

    const runButton = screen.getByRole("button", { name: "Run suspension" });
    expect(runButton).toBeEnabled();

    await userEvent.click(runButton);
    // Opening the confirmation still changes nothing.
    expect(runSuspensionCandidates).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Suspend 1 account/ }));

    expect(runSuspensionCandidates).toHaveBeenCalledWith({ thresholdDays: undefined });
  });

  it("withholds the run from a role that may not suspend", async () => {
    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Manager", role: "manager" },
      isAuthenticated: true,
    });

    render(
      <MemoryRouter>
        <SuspensionOperationsPage />
      </MemoryRouter>
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Preview candidates (no changes)" })
    );
    await screen.findByText("SA-000001");

    expect(screen.getByRole("button", { name: "Run suspension" })).toBeDisabled();
    expect(screen.getByText(/not perform it/i)).toBeInTheDocument();
  });
});
