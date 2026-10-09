import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CollectorBatchDetailPage } from "./CollectorBatchDetailPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  fetchDatabaseHealth,
  fetchServiceHealth,
  getCollectorBatch,
  listBatchRemittances,
  type BatchAssignmentSummary,
  type CollectorBatchDetail,
} from "../lib/api-client";
import type { CollectorBatchStatus } from "@bcis/shared";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getCollectorBatch: vi.fn(),
    listBatchRemittances: vi.fn(),
    addBatchAssignments: vi.fn(),
    recordCollection: vi.fn(),
    voidCollection: vi.fn(),
    submitBatch: vi.fn(),
    recordBatchRemittance: vi.fn(),
    reconcileBatch: vi.fn(),
    closeBatch: vi.fn(),
    cancelCollectorBatch: vi.fn(),
  };
});

/** One assignment; its result decides which per-row buttons appear. */
function makeAssignment(
  collectionResult: BatchAssignmentSummary["collectionResult"],
  index = 1
): BatchAssignmentSummary {
  return {
    id: `assignment-${index}`,
    serviceAccountId: `account-${index}`,
    serviceAccountNumber: `SA-00000${index}`,
    subscriberId: `subscriber-${index}`,
    subscriberName: "Dela Cruz, Juan",
    planName: "Fiber 100",
    outstandingBalanceCentavos: 100000,
    collectionResult,
    collectedAmountCentavos: collectionResult === null ? null : 100000,
    collectedMethod: collectionResult === null ? null : "cash",
    paymentId: collectionResult === null ? null : "payment-1",
    collectorNotes: null,
    voidedAt: null,
    voidReason: null,
  };
}

/** A batch in a given lifecycle state, with everything the detail screen reads. */
function makeBatch(status: CollectorBatchStatus): CollectorBatchDetail {
  return {
    id: "batch-1",
    batchNumber: "CB-20250124-0001",
    collectorId: "collector-1",
    collectorName: "Ana Reyes",
    status,
    collectionDate: "2025-01-24",
    expectedReceivableCentavos: 200000,
    expectedRemittanceCentavos: 100000,
    actualRemittanceCentavos: null,
    varianceCentavos: null,
    varianceNotes: null,
    assignmentCount: 1,
    collectedCount: status === "in_progress" ? 1 : 0,
    createdAt: "2025-01-24T00:00:00.000Z",
    submittedAt: null,
    reconciledAt: null,
    closedAt: null,
    assignments:
      status === "in_progress"
        ? [makeAssignment("collected"), makeAssignment(null, 2)]
        : [makeAssignment(null)],
    collectedTotalCentavos: 0,
    outstandingTotalCentavos: 100000,
    methodSummary: {
      expectedReceivableCentavos: 100000,
      cashCollectedCentavos: 0,
      gcashCollectedCentavos: 0,
      nonCashCollectedCentavos: 0,
      collectedTotalCentavos: 0,
      uncollectedCentavos: 100000,
    },
  };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/collector-batches/batch-1"]}>
      <Routes>
        <Route path="/collector-batches/:id" element={<CollectorBatchDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** The batch-level and row-level action labels the screen is offering right now. */
function offeredActionButtons(): string[] {
  const labels = [
    "Add accounts",
    "Record Collection",
    "Void",
    "Submit run",
    "Record remittance",
    "Reconcile",
    "Close batch",
    "Cancel batch",
  ];
  return labels.filter((label) => screen.queryByRole("button", { name: label }) !== null);
}

const EXPECTED_BUTTONS: Record<CollectorBatchStatus, string[]> = {
  open: ["Add accounts", "Record Collection", "Submit run", "Cancel batch"],
  in_progress: ["Record Collection", "Void", "Submit run"],  submitted: ["Record remittance"],
  remitted: ["Record remittance", "Reconcile"],
  reconciled: ["Close batch"],
  closed: [],
  cancelled: [],
};

describe("CollectorBatchDetailPage lifecycle actions", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listBatchRemittances).mockResolvedValue([]);

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Admin", role: "admin" },
      isAuthenticated: true,
    });
  });

  it.each(Object.keys(EXPECTED_BUTTONS) as CollectorBatchStatus[])(
    "offers only the actions legal from %s",
    async (status) => {
      vi.mocked(getCollectorBatch).mockResolvedValue(makeBatch(status));

      renderPage();

      await screen.findByText("CB-20250124-0001");
      expect(offeredActionButtons()).toEqual(EXPECTED_BUTTONS[status]);
    }
  );

  it("shows a shortage warning for a shortfall and none when the totals match", async () => {
    vi.mocked(getCollectorBatch).mockResolvedValue(makeBatch("submitted"));

    renderPage();
    await screen.findByText("CB-20250124-0001");

    await userEvent.click(screen.getByRole("button", { name: "Record remittance" }));

    const amountInput = await screen.findByPlaceholderText("4500.00");

    // ₱500.00 handed in against ₱1,000.00 collected is a ₱500.00 shortage.
    await userEvent.type(amountInput, "500");
    expect(screen.getByText(/Shortage/)).toBeInTheDocument();
    expect(screen.queryByText(/Balanced/)).not.toBeInTheDocument();

    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, "1000");
    expect(screen.getByText(/Balanced/)).toBeInTheDocument();
    expect(screen.queryByText(/Shortage/)).not.toBeInTheDocument();
  });

  it("submits the run with no amount at all", async () => {
    const { submitBatch } = await import("../lib/api-client");
    vi.mocked(submitBatch).mockResolvedValue({
      batchId: "batch-1",
      status: "submitted",
      submittedAt: "2025-01-24T09:00:00.000Z",
      assignmentCount: 1,
      expectedRemittanceCentavos: 100000,
    });
    vi.mocked(getCollectorBatch).mockResolvedValue(makeBatch("in_progress"));

    renderPage();
    await screen.findByText("CB-20250124-0001");

    await userEvent.click(screen.getByRole("button", { name: "Submit run" }));
    // The dialog's own confirm button shares the label; the last one is the dialog.
    const confirmButtons = screen.getAllByRole("button", { name: "Submit run" });
    await userEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

    expect(submitBatch).toHaveBeenCalledWith("batch-1");
  });
});
