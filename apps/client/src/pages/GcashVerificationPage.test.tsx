import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GcashVerificationPage } from "./GcashVerificationPage";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  fetchDatabaseHealth,
  fetchGcashScreenshot,
  fetchServiceHealth,
  listPendingGcashPayments,
  rejectGcashPayment,
  verifyGcashPayment,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    fetchGcashScreenshot: vi.fn(),
    listPendingGcashPayments: vi.fn(),
    rejectGcashPayment: vi.fn(),
    verifyGcashPayment: vi.fn(),
  };
});

const CLAIM = {
  paymentId: "payment-1",
  receiptNumber: "OR-2026-000001",
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Santos, Maria",
  amountCentavos: 649500,
  paymentDate: "2026-01-05",
  recordedAt: "2026-01-05T10:00:00.000Z",
  recordedByName: "Test Cashier",
  referenceNumber: "GCASH-REF-0001",
  senderGcashNumber: "09171234567",
  senderName: "Maria Santos",
  screenshotFilePath: "gcash-proofs/2026/01/proof.png",
};

const SECOND_CLAIM = {
  ...CLAIM,
  paymentId: "payment-2",
  receiptNumber: "OR-2026-000002",
  referenceNumber: "GCASH-REF-0002",
  subscriberName: "Reyes, Pedro",
};

const PAYMENT_SUMMARY = {
  id: "payment-1",
  receiptNumber: "OR-2026-000001",
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Santos, Maria",
  paymentMethod: "gcash" as const,
  status: "posted" as const,
  amountCentavos: 649500,
  allocatedCentavos: 649500,
  advanceCreditCentavos: 0,
  paymentDate: "2026-01-05",
  notes: null,
  gcashReferenceNumber: "GCASH-REF-0001",
  postedAt: "2026-01-05T10:00:00.000Z",
  postedById: "user-1",
  postedByName: "Test Cashier",
  reversedAt: null,
  reversedById: null,
};

const GCASH_RECORD = {
  paymentId: "payment-1",
  gcashReferenceNumber: "GCASH-REF-0001",
  senderGcashNumber: "09171234567",
  senderName: "Maria Santos",
  screenshotFilePath: "gcash-proofs/2026/01/proof.png",
  verifiedAt: "2026-01-05T11:00:00.000Z",
  verifiedBy: "user-1",
  rejectedAt: null,
  rejectedBy: null,
  rejectionReason: null,
};

function signInAs(role: "admin" | "cashier" | "collector"): void {
  useAuthStore.setState({
    token: "test-token",
    user: { id: "user-1", fullName: "Test User", role },
    isAuthenticated: true,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/payments/gcash"]}>
      <Routes>
        <Route
          path="/payments/gcash"
          element={
            <ProtectedRoute requiredPermission="payments:verify_gcash">
              <GcashVerificationPage />
            </ProtectedRoute>
          }
        />
        <Route path="/unauthorized" element={<div>Not authorized</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("GcashVerificationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(fetchGcashScreenshot).mockResolvedValue(null);
    vi.mocked(listPendingGcashPayments).mockResolvedValue([CLAIM, SECOND_CLAIM]);
    vi.mocked(verifyGcashPayment).mockResolvedValue({
      payment: PAYMENT_SUMMARY,
      gcash: GCASH_RECORD,
      allocations: [{ invoiceId: "invoice-1", invoiceNumber: "INV-2026-01-000001", allocatedAmountCentavos: 649500 }],
      allocatedCentavos: 649500,
      advanceCreditCentavos: 0,
    });
    vi.mocked(rejectGcashPayment).mockResolvedValue({
      payment: { ...PAYMENT_SUMMARY, status: "rejected" },
      gcash: { ...GCASH_RECORD, verifiedAt: null, verifiedBy: null, rejectedAt: "2026-01-05T11:00:00.000Z", rejectedBy: "user-1", rejectionReason: "Reference not found in GCash" },
    });

    signInAs("admin");
  });

  it("lists only the claims the pending-claims endpoint returns", async () => {
    renderPage();

    expect(await screen.findByText("OR-2026-000001")).toBeInTheDocument();
    expect(screen.getByText("OR-2026-000002")).toBeInTheDocument();
    expect(listPendingGcashPayments).toHaveBeenCalledTimes(1);
  });

  it("verifies a claim, which posts it and removes it from the queue", async () => {
    renderPage();

    await userEvent.click(await screen.findByText("OR-2026-000001"));
    await userEvent.click(screen.getByRole("button", { name: /Verify & post payment/i }));

    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Verify and post" }));

    await waitFor(() => {
      expect(verifyGcashPayment).toHaveBeenCalledWith("payment-1");
    });

    // The claim has left the queue and the outcome is reported.
    await waitFor(() => {
      expect(screen.queryByText("OR-2026-000001")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Verified OR-2026-000001/)).toBeInTheDocument();
    expect(screen.getByText(/allocated to 1 invoice/i)).toBeInTheDocument();
  });

  it("requires a reason before rejecting, then leaves the invoice untouched", async () => {
    renderPage();

    await userEvent.click(await screen.findByText("OR-2026-000001"));
    await userEvent.click(screen.getByRole("button", { name: "Reject claim" }));

    const dialog = screen.getByRole("dialog");
    // Submitting with an empty reason must not reach the API.
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject claim" }));

    expect(await within(dialog).findByText(/reason of at least 10 characters/i)).toBeInTheDocument();
    expect(rejectGcashPayment).not.toHaveBeenCalled();

    await userEvent.type(
      within(dialog).getByLabelText("Reason for rejection"),
      "Reference not found in GCash"
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject claim" }));

    await waitFor(() => {
      expect(rejectGcashPayment).toHaveBeenCalledWith("payment-1", "Reference not found in GCash");
    });

    await waitFor(() => {
      expect(screen.queryByText("OR-2026-000001")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Nothing was posted/i)).toBeInTheDocument();
  });

  it("is denied, and never calls the queue, without the verify permission", async () => {
    signInAs("collector");
    renderPage();

    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(listPendingGcashPayments).not.toHaveBeenCalled();
  });
});
