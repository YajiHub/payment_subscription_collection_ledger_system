import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "./DashboardPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";
import {
  fetchDatabaseHealth,
  fetchServiceHealth,
  getArAgingReport,
  getCollectorPerformanceReport,
  getDashboardKpis,
  listPayments,
  type CollectorPerformanceReport,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getDashboardKpis: vi.fn(),
    getArAgingReport: vi.fn(),
    listPayments: vi.fn(),
    getCollectorPerformanceReport: vi.fn(),
  };
});

function collectorGroup(collectedCentavos: number) {
  return {
    collectorId: "collector-1",
    collectorName: "Ana Reyes",
    assignedAccountCount: 5,
    paymentCount: 3,
    collectedCentavos,
    cashCentavos: 100000,
    gcashCentavos: 50000,
    batchCount: 1,
    expectedRemittanceCentavos: 176000,
    actualRemittanceCentavos: 175000,
    varianceCentavos: -1000,
  };
}

const PERFORMANCE: CollectorPerformanceReport = {
  fromDate: "2026-01-01",
  toDate: "2026-01-31",
  groups: [collectorGroup(175000)],
  totals: collectorGroup(175000),
};

/**
 * The dashboard's two added blocks and its KPI consolidation (S6-3, section 4.3):
 * a payment-method summary and a collector-performance block, with the KPI strip
 * kept to six compact cards.
 */
describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(getDashboardKpis).mockResolvedValue({
      totalActiveServiceAccounts: 120,
      newServiceAccountsThisMonth: 7,
      suspendedAccounts: 3,
      terminatedAccounts: 1,
      totalInvoicedThisMonthCentavos: 500000,
      totalCollectedThisMonthCentavos: 175000,
      collectionRatePercent: 35,
      totalOutstandingArCentavos: 900000,
      overdueOver30DaysCentavos: 400000,
      overdueOver90DaysCentavos: 120000,
      openCollectorBatches: 2,
      submittedBatchesPendingReconciliation: 0,
      lastBillingRunDate: "2026-01-01",
      lastBillingRunAccountsCount: 120,
    });
    vi.mocked(getArAgingReport).mockResolvedValue({
      asOfDate: "2026-01-31",
      entries: [],
      totals: {
        current: 500000,
        bucket_1_30: 280000,
        bucket_31_60: 100000,
        bucket_61_90: 100000,
        over_90: 120000,
        grandTotal: 900000,
      },
    });
    vi.mocked(listPayments).mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });
    vi.mocked(getCollectorPerformanceReport).mockResolvedValue(PERFORMANCE);

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test User", role: "admin" },
      isAuthenticated: true,
    });
  });

  it("shows the payment-method summary from the server's collected figures", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Payment methods")).toBeInTheDocument();
    expect(screen.getByText("Other methods")).toBeInTheDocument();
    // Cash + GCash + Other add up to the collected total.
    expect(screen.getAllByText("₱1,000.00").length).toBeGreaterThan(0);
    expect(screen.getByText("₱500.00")).toBeInTheDocument();
    expect(screen.getByText("₱250.00")).toBeInTheDocument();
    expect(screen.getAllByText("₱1,750.00").length).toBeGreaterThan(0);
  });

  it("shows the collector-performance block", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Collector performance")).toBeInTheDocument();
    expect(screen.getByText("Ana Reyes")).toBeInTheDocument();
    // The variance of -1000 centavos appears on the collector's row and the totals row.
    expect(screen.getAllByText("-₱10.00")).toHaveLength(2);
  });

  it("keeps the KPI strip to six cards and folds the overdue figures into the AR line", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await screen.findByText("Payment methods");

    for (const label of [
      "Active Accounts",
      "Monthly Invoiced",
      "Monthly Collected",
      "Collection Rate",
      "Total Outstanding AR",
      "Suspended / Terminated",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // The two overdue cards are gone; the figures are stated beside the AR aging chart.
    expect(screen.queryByText("Overdue 30+ Days")).toBeNull();
    expect(screen.queryByText("Overdue 90+ Days")).toBeNull();
    expect(
      screen.getByText(
        (content, element) =>
          element?.tagName === "P" && /Overdue more than 30 days:/.test(content)
      )
    ).toBeInTheDocument();
  });
});
