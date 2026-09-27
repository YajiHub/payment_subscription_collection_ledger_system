import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentHistoryPage } from "./PaymentHistoryPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import { fetchDatabaseHealth, fetchServiceHealth, listPayments } from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    listPayments: vi.fn(),
  };
});

const ONE_PAYMENT = {
  id: "payment-1",
  receiptNumber: "OR-2026-000001",
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Dela Cruz, Juan",
  paymentMethod: "cash" as const,
  status: "posted" as const,
  amountCentavos: 99900,
  allocatedCentavos: 99900,
  advanceCreditCentavos: 0,
  paymentDate: "2026-01-05",
  notes: null,
  gcashReferenceNumber: null,
  postedAt: "2026-01-05T10:00:00.000Z",
  postedById: "user-1",
  postedByName: "Test User",
  reversedAt: null,
  reversedById: null,
};

/**
 * The payment history must page on the server (S8-1): the screen asks for one page
 * at a time and shows the total, rather than fetching every payment and slicing it.
 */
describe("PaymentHistoryPage pagination", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listPayments).mockImplementation(async (filters = {}) => ({
      items: [ONE_PAYMENT],
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 50,
      total: 120,
    }));

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test User", role: "admin" },
      isAuthenticated: true,
    });
  });

  it("requests the first page and shows the server's total in the footer", async () => {
    render(
      <MemoryRouter>
        <PaymentHistoryPage />
      </MemoryRouter>
    );

    await screen.findByText("OR-2026-000001");

    expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    expect(screen.getByText("120 payments")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("asks the server for the next page when the operator turns the page", async () => {
    render(
      <MemoryRouter>
        <PaymentHistoryPage />
      </MemoryRouter>
    );

    await screen.findByText("OR-2026-000001");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(listPayments).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    });
  });
});
