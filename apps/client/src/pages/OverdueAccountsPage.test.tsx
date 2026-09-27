import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OverdueAccountsPage } from "./OverdueAccountsPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import {
  fetchDatabaseHealth,
  fetchServiceHealth,
  getOverdueAccounts,
  listAssignableCollectors,
  listPlans,
} from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getOverdueAccounts: vi.fn(),
    listAssignableCollectors: vi.fn(),
    listPlans: vi.fn(),
    suspendOverdueAccounts: vi.fn(),
  };
});

/**
 * The overdue screen must send every filter the endpoint honours (S4-5, S6-2):
 * collector, area, plan, service type and the delinquency age, alongside the two
 * thresholds it already had. A filter the endpoint reads but the screen never
 * sends is the defect the audit found, so the request is asserted field by field.
 */
describe("OverdueAccountsPage filters", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(getOverdueAccounts).mockResolvedValue({ items: [], totalOverdueCentavos: 0 });
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
      user: { id: "user-1", fullName: "Test Admin", role: "admin" },
      isAuthenticated: true,
    });
  });

  it("sends the collector, area, plan, service type and delinquency age it is given", async () => {
    render(
      <MemoryRouter>
        <OverdueAccountsPage />
      </MemoryRouter>
    );

    await screen.findByRole("option", { name: "Ana Reyes" });
    await screen.findByRole("option", { name: "Fiber 100" });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Collector" }),
      "collector-1"
    );
    await userEvent.type(
      screen.getByPlaceholderText("Paste the collection area id"),
      "area-9"
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Plan" }), "plan-1");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Service type" }),
      "internet"
    );
    await userEvent.type(screen.getByPlaceholderText("e.g. 90"), "90");

    expect(getOverdueAccounts).toHaveBeenLastCalledWith({
      noPaymentInDays: undefined,
      minConsecutiveOverdueMonths: undefined,
      minOverdueDays: 90,
      collectorId: "collector-1",
      areaId: "area-9",
      planId: "plan-1",
      serviceType: "internet",
    });
  });

  it("omits every filter when nothing is filled in", async () => {
    render(
      <MemoryRouter>
        <OverdueAccountsPage />
      </MemoryRouter>
    );

    await screen.findByRole("option", { name: "Ana Reyes" });

    expect(getOverdueAccounts).toHaveBeenLastCalledWith({
      noPaymentInDays: undefined,
      minConsecutiveOverdueMonths: undefined,
      minOverdueDays: undefined,
      collectorId: undefined,
      areaId: undefined,
      planId: undefined,
      serviceType: undefined,
    });
  });
});
