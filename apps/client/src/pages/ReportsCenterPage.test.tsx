import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_REPORT_TYPES,
  REPORT_TYPE_LABELS,
  type UserRole,
} from "@bcis/shared";

import { ReportsCenterPage } from "./ReportsCenterPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  exportReportXlsx,
  fetchDatabaseHealth,
  fetchServiceHealth,
  getAuditLogReport,
  getDailyCollectionReport,
  getWeeklyCollectionReport,
  listAssignableCollectors,
  listPlans,
  type ReportExportParams,
} from "../lib/api-client";

// Only the endpoints these tests exercise are stubbed; the rest of the real module
// stays in place so an accidental call still type-checks and fails loudly.
vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getDailyCollectionReport: vi.fn(),
    getAuditLogReport: vi.fn(),
    getWeeklyCollectionReport: vi.fn(),
    exportReportPdf: vi.fn(),
    exportReportXlsx: vi.fn(),
    listAssignableCollectors: vi.fn(),
    listPlans: vi.fn(),
  };
});

function signInAs(role: UserRole): void {
  useAuthStore.setState({
    token: "test-token",
    user: { id: "user-1", fullName: "Test User", role },
    isAuthenticated: true,
  });
}

function renderReportsCenter(): void {
  render(
    <MemoryRouter>
      <ReportsCenterPage />
    </MemoryRouter>
  );
}

const EMPTY_DAILY_COLLECTION = {
  date: "2026-01-01",
  items: [],
  totals: {
    paymentCount: 0,
    cashTotalCentavos: 0,
    gcashTotalCentavos: 0,
    grandTotalCentavos: 0,
  },
};

/**
 * The test suite the Reports Center exists to satisfy (S6-1, S6-5, S6-6): every
 * report in the shared catalogue is reachable, the extended union is merged rather
 * than silently dropped, and a capped report or export says so.
 */

describe("ReportsCenterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listAssignableCollectors).mockResolvedValue([]);
    vi.mocked(listPlans).mockResolvedValue([]);
    vi.mocked(getDailyCollectionReport).mockResolvedValue(EMPTY_DAILY_COLLECTION);
    vi.mocked(getWeeklyCollectionReport).mockResolvedValue({
      fromDate: "2026-01-05",
      toDate: "2026-01-11",
      weekStartDate: "2026-01-05",
      periods: [],
      totals: {
        paymentCount: 0,
        cashTotalCentavos: 0,
        gcashTotalCentavos: 0,
        grandTotalCentavos: 0,
      },
    });

    // jsdom has no object-URL implementation; the export path needs one to save a file.
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:report") });
      Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn() });
    }
    // The download anchor would try to navigate; jsdom has no download support.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  it("lists all eighteen report types, the six originals merged with the twelve added", async () => {
    signInAs("admin");
    renderReportsCenter();

    expect(ALL_REPORT_TYPES).toHaveLength(18);

    for (const reportType of ALL_REPORT_TYPES) {
      expect(
        await screen.findByRole("button", { name: REPORT_TYPE_LABELS[reportType] })
      ).toBeInTheDocument();
    }
  });

  it("hides the audit reports from a role that holds reports:export but not audit:read", async () => {
    signInAs("manager");
    renderReportsCenter();

    // The manager may export reports, but the audit reports need audit:read to view.
    expect(
      screen.queryByRole("button", { name: REPORT_TYPE_LABELS.audit_log })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: REPORT_TYPE_LABELS.user_activity })
    ).not.toBeInTheDocument();
    // Everything else is still there.
    expect(
      await screen.findByRole("button", { name: REPORT_TYPE_LABELS.revenue_by_area })
    ).toBeInTheDocument();
  });

  it("renders only the filters each report's query actually applies (S6-2)", async () => {
    signInAs("admin");
    renderReportsCenter();

    // daily_collection: a single day, no range and no account filters.
    expect(await screen.findByLabelText("Date")).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.queryByLabelText("Collector")).toBeNull();

    // weekly_collection: an inclusive range plus the account filters.
    await userEvent.click(
      screen.getByRole("button", { name: REPORT_TYPE_LABELS.weekly_collection })
    );
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("Collector")).toBeInTheDocument();
    expect(screen.getByLabelText("Service type")).toBeInTheDocument();

    // ar_aging: the schema accepts a range but the query builds no date condition
    // from it, so the range controls must be absent.
    await userEvent.click(screen.getByRole("button", { name: REPORT_TYPE_LABELS.ar_aging }));
    expect(screen.getByLabelText("As of")).toBeInTheDocument();
    expect(screen.getByLabelText("Collector")).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.queryByLabelText("To")).toBeNull();

    // collector_assignment: a current snapshot, so no date controls at all.
    await userEvent.click(
      screen.getByRole("button", { name: REPORT_TYPE_LABELS.collector_assignment })
    );
    expect(screen.queryByLabelText("As of")).toBeNull();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.getByLabelText("Plan")).toBeInTheDocument();

    // audit_log: a range plus the audit filters, never the account filters.
    await userEvent.click(screen.getByRole("button", { name: REPORT_TYPE_LABELS.audit_log }));
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("Performed by (user id)")).toBeInTheDocument();
    expect(screen.getByLabelText("Entity type")).toBeInTheDocument();
    expect(screen.queryByLabelText("Collector")).toBeNull();
  });

  it("sends the filters the report honours and leaves the rest out", async () => {
    signInAs("admin");
    renderReportsCenter();

    await userEvent.click(
      await screen.findByRole("button", { name: REPORT_TYPE_LABELS.weekly_collection })
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-05" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-11" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => {
      expect(getWeeklyCollectionReport).toHaveBeenCalled();
    });

    const request = vi.mocked(getWeeklyCollectionReport).mock.calls.at(-1)?.[0] as
      | ReportExportParams
      | undefined;
    expect(request).toMatchObject({ fromDate: "2026-01-05", toDate: "2026-01-11" });
    // A filter this report does not honour was never populated.
    expect(request?.performedBy).toBeUndefined();
    expect(request?.entityType).toBeUndefined();
  });

  it("states how many rows a capped on-screen report omitted instead of showing a silent subset", async () => {
    signInAs("admin");
    const capRows = [
      {
        performedAt: "2026-01-15T09:30:00.000Z",
        performedBy: "user-1",
        performedByUsername: "admin",
        action: "payment.posted",
        entityType: "payment",
        entityId: "payment-1",
        description: "Posted a payment",
        clientIpAddress: "127.0.0.1",
      },
      {
        performedAt: "2026-01-15T09:31:00.000Z",
        performedBy: "user-1",
        performedByUsername: "admin",
        action: "payment.posted",
        entityType: "payment",
        entityId: "payment-2",
        description: "Posted a payment",
        clientIpAddress: "127.0.0.1",
      },
    ];
    vi.mocked(getAuditLogReport).mockResolvedValue({
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      totalRows: 5,
      isTruncated: true,
      rowLimit: 2,
      rows: capRows,
    });

    renderReportsCenter();

    await userEvent.click(
      await screen.findByRole("button", { name: REPORT_TYPE_LABELS.audit_log })
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    const notice = await screen.findByRole("status");
    // The exact wording is the contract: what is shown, the true total, the cap,
    // and the number the cap omitted.
    expect(notice).toHaveTextContent("Showing the first 2 of 5 entries");
    expect(notice).toHaveTextContent("2-row cap omitted 3");
  });

  it("says so when an export was truncated by the row cap", async () => {
    signInAs("admin");
    vi.mocked(exportReportXlsx).mockResolvedValue({
      fileName: "audit-log.xlsx",
      bytes: new ArrayBuffer(0),
      rowLimit: 5000,
      totalRows: 9000,
      isTruncated: true,
    });

    renderReportsCenter();

    await userEvent.click(await screen.findByRole("button", { name: "Export XLSX" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Export truncated");
    expect(notice).toHaveTextContent("first 5,000 of 9,000 rows");
  });

  it("renders no truncation notice when the export was complete", async () => {
    signInAs("admin");
    vi.mocked(exportReportXlsx).mockResolvedValue({
      fileName: "daily-collection.xlsx",
      bytes: new ArrayBuffer(0),
      rowLimit: 5000,
      totalRows: 12,
      isTruncated: false,
    });

    renderReportsCenter();

    await userEvent.click(await screen.findByRole("button", { name: "Export XLSX" }));

    await waitFor(() => {
      expect(exportReportXlsx).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
