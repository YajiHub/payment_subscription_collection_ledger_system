import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvoiceListPage } from "./InvoiceListPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  fetchDatabaseHealth,
  fetchServiceHealth,
  listInvoices,
  listSubscribers,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    listInvoices: vi.fn(),
    listSubscribers: vi.fn(),
  };
});

const ONE_INVOICE = {
  id: "invoice-1",
  invoiceNumber: "INV-2026-000001",
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Dela Cruz, Juan",
  invoiceType: "monthly_subscription" as const,
  status: "unpaid" as const,
  billingPeriodYear: 2026,
  billingPeriodMonth: 1,
  invoiceDate: "2026-01-01",
  dueDate: "2026-01-15",
  subtotalCentavos: 99900,
  lateFeesCentavos: 0,
  totalAmountCentavos: 99900,
  paidAmountCentavos: 0,
  remainingBalanceCentavos: 99900,
  notes: null,
  voidedByTransactionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  postedAt: null,
  voidedAt: null,
};

/**
 * The invoice list must page on the server (S8-1): the screen asks for one page at
 * a time and shows the total, rather than fetching the whole book and slicing it.
 */
describe("InvoiceListPage pagination", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listSubscribers).mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
    vi.mocked(listInvoices).mockImplementation(async (filters = {}) => ({
      items: [ONE_INVOICE],
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
        <InvoiceListPage />
      </MemoryRouter>
    );

    await screen.findByText("INV-2026-000001");

    expect(listInvoices).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    expect(screen.getByText("120 invoices")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("asks the server for the next page when the operator turns the page", async () => {
    render(
      <MemoryRouter>
        <InvoiceListPage />
      </MemoryRouter>
    );

    await screen.findByText("INV-2026-000001");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(listInvoices).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    });
  });
});
