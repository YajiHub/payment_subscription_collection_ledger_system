import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriberDetailPage } from "./SubscriberDetailPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import { fetchDatabaseHealth, fetchServiceHealth, getSubscriber } from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getSubscriber: vi.fn(),
  };
});

const ONE_ACCOUNT = {
  id: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  planId: "plan-1",
  planName: "Fiber 25Mbps",
  serviceType: "internet" as const,
  monthlyRateCentavos: 99900,
  status: "active" as const,
  activationDate: "2026-01-01",
  suspensionDate: null,
  terminationDate: null,
  assignedCollectorId: null,
  consecutiveOverdueMonths: 0,
  balanceCentavos: 649500,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ONE_SUBSCRIBER = {
  id: "subscriber-1",
  accountNumber: "SUB-20260101-00001",
  firstName: "Maria",
  lastName: "Santos",
  middleName: null,
  primaryPhone: "09171234567",
  secondaryPhone: null,
  emailAddress: null,
  serviceAddress: "12 Mabini Street",
  serviceBarangay: "Poblacion",
  serviceMunicipality: "Cabuyao",
  serviceProvince: "Laguna",
  internalNotes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-1",
  updatedBy: null,
  serviceAccounts: [ONE_ACCOUNT],
};

/**
 * Defect S7-6/D1: the profile used to print an em dash for every balance because
 * the API hardcoded `balanceCentavos: null`. The ledger figure must reach the screen.
 */
describe("SubscriberDetailPage balance", () => {
  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(getSubscriber).mockResolvedValue(ONE_SUBSCRIBER);

    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Cashier", role: "cashier" },
      isAuthenticated: true,
    });
  });

  it("renders the ledger balance instead of an em dash", async () => {
    render(
      <MemoryRouter initialEntries={["/subscribers/subscriber-1"]}>
        <Routes>
          <Route path="/subscribers/:id" element={<SubscriberDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("₱6,495.00")).toBeInTheDocument();
    expect(screen.getByText("Current balance")).toBeInTheDocument();
  });
});
