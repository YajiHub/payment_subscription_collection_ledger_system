import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReceivablesAgingPage } from "./ReceivablesAgingPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  downloadArAgingXlsx,
  fetchDatabaseHealth,
  fetchServiceHealth,
  getArAging,
  listAssignableCollectors,
  listPlans,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getArAging: vi.fn(),
    downloadArAgingXlsx: vi.fn(),
    listAssignableCollectors: vi.fn(),
    listPlans: vi.fn(),
  };
});

const EMPTY_REPORT = {
  asOfDate: "2026-01-01",
  entries: [],
  totals: {
    current: 0,
    bucket_1_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    over_90: 0,
    grandTotal: 0,
  },
};

/**
 * The AR aging screen must send the account filters the endpoint honours (S4-6,
 * S6-2). The buckets still reconcile regardless of the filters, which is the
 * server's job; this test pins that the screen actually narrows the query.
 */
describe("ReceivablesAgingPage filters", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(getArAging).mockResolvedValue(EMPTY_REPORT);
    vi.mocked(listAssignableCollectors).mockResolvedValue([
      { id: "collector-1", fullName: "Ana Reyes", isActive: true },
    ]);
    vi.mocked(listPlans).mockResolvedValue([
      {
        id: "plan-1",
        name: "Fiber 100",
        serviceType: "internet",
        speedMbps: 100,
        cablePackageDescription: null,
        monthlyRateCentavos: 99900,
        reconnectionFeeCentavos: 50000,
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "user-1",
      },
    ]);

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Manager", role: "manager" },
      isAuthenticated: true,
    });
  });

  it("sends the collector, area, plan and service type it is given", async () => {
    render(
      <MemoryRouter>
        <ReceivablesAgingPage />
      </MemoryRouter>
    );

    await screen.findByRole("option", { name: "Ana Reyes" });
    await screen.findByRole("option", { name: "Fiber 100" });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Collector" }),
      "collector-1"
    );
    await userEvent.type(screen.getByPlaceholderText("Paste the collection area id"), "area-9");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Plan" }), "plan-1");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Service type" }),
      "bundle"
    );

    const lastCall = vi.mocked(getArAging).mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({
      collectorId: "collector-1",
      areaId: "area-9",
      planId: "plan-1",
      serviceType: "bundle",
    });
  });

  it("passes the same filters to the XLSX export", async () => {
    vi.mocked(downloadArAgingXlsx).mockResolvedValue({ fileName: "x.xlsx", bytes: new ArrayBuffer(0) });

    render(
      <MemoryRouter>
        <ReceivablesAgingPage />
      </MemoryRouter>
    );

    await screen.findByRole("option", { name: "Ana Reyes" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Collector" }),
      "collector-1"
    );
    await userEvent.click(screen.getByRole("button", { name: "Export XLSX" }));

    const lastCall = vi.mocked(downloadArAgingXlsx).mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({
      collectorId: "collector-1",
      areaId: undefined,
      planId: undefined,
      serviceType: undefined,
    });
  });
});
