import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriberDetailPage } from "./SubscriberDetailPage";
import { useAuthStore } from "../stores/auth.store";
import type * as ApiClient from "../lib/api-client";

import { fetchDatabaseHealth, fetchServiceHealth, getSubscriber, listPayments } from "../lib/api-client";

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchServiceHealth: vi.fn(),
    fetchDatabaseHealth: vi.fn(),
    getSubscriber: vi.fn(),
    listPayments: vi.fn(),
    activateServiceAccount: vi.fn(),
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
    vi.mocked(listPayments).mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });

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

const ONE_PAYMENT = {
  id: "payment-1",
  receiptNumber: "OR-2026-000042",
  serviceAccountId: "account-1",
  serviceAccountNumber: "SA-000001",
  subscriberId: "subscriber-1",
  subscriberName: "Santos, Maria",
  paymentMethod: "cash" as const,
  status: "posted" as const,
  amountCentavos: 10000,
  allocatedCentavos: 10000,
  advanceCreditCentavos: 0,
  paymentDate: "2026-03-01",
  notes: null,
  gcashReferenceNumber: null,
  postedAt: "2026-03-01T09:00:00.000Z",
  postedById: "user-1",
  postedByName: "Test Cashier",
  reversedAt: null,
  reversedById: null,
};

/**
 * Defect D2: the profile used to print a stale "Payments are recorded in Phase 5"
 * placeholder on an account that demonstrably has payments. The real history must
 * reach the screen, and a subscriber with none must see an honest empty state.
 */
describe("SubscriberDetailPage payment history", () => {
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

  function renderPage(): void {
    render(
      <MemoryRouter initialEntries={["/subscribers/subscriber-1"]}>
        <Routes>
          <Route path="/subscribers/:id" element={<SubscriberDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders the subscriber's real payments instead of the stale placeholder", async () => {
    vi.mocked(listPayments).mockResolvedValue({
      items: [ONE_PAYMENT],
      page: 1,
      pageSize: 10,
      total: 1,
    });

    renderPage();

    expect(await screen.findByText("OR-2026-000042")).toBeInTheDocument();
    expect(screen.getByText("01/03/2026")).toBeInTheDocument();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("₱100.00")).toBeInTheDocument();
    expect(
      screen.queryByText(/Payments are recorded in Phase 5/)
    ).not.toBeInTheDocument();

    // The fetch is scoped to THIS subscriber, not the whole payment history.
    expect(vi.mocked(listPayments)).toHaveBeenCalledWith({ subscriberId: "subscriber-1", pageSize: 10 });
  });

  it("shows an honest empty state when the subscriber has no payments", async () => {
    vi.mocked(listPayments).mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });

    renderPage();

    expect(
      await screen.findByText("No payments have been recorded for this subscriber yet.")
    ).toBeInTheDocument();
  });
});

/**
 * A pending account has never been in service, so the only move the screen may
 * offer is Activate (or Terminate) — never Suspend, and never Reconnect.
 */
describe("SubscriberDetailPage activation action", () => {
  function renderPage(): void {
    render(
      <MemoryRouter initialEntries={["/subscribers/subscriber-1"]}>
        <Routes>
          <Route path="/subscribers/:id" element={<SubscriberDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  beforeEach(() => {
    vi.mocked(fetchServiceHealth).mockResolvedValue({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "test",
    });
    vi.mocked(fetchDatabaseHealth).mockResolvedValue({ status: "ok", latency_ms: 1, error: null });
    vi.mocked(listPayments).mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });

    // A Billing Clerk holds subscribers:suspend, which guards activation.
    useAuthStore.setState({
      token: "test-token",
      user: { id: "user-1", fullName: "Test Clerk", role: "billing_clerk" },
      isAuthenticated: true,
    });
  });

  it("offers Activate for a pending account", async () => {
    vi.mocked(getSubscriber).mockResolvedValue({
      ...ONE_SUBSCRIBER,
      serviceAccounts: [{ ...ONE_ACCOUNT, status: "pending", activationDate: null }],
    });

    renderPage();

    expect(await screen.findByRole("button", { name: "Activate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("does not offer Activate for an active account", async () => {
    vi.mocked(getSubscriber).mockResolvedValue(ONE_SUBSCRIBER);

    renderPage();

    expect(await screen.findByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
  });
});
