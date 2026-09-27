import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlanManagementPage } from "./PlanManagementPage";
import { createPlan, listPlans } from "../lib/api-client";
import { useAuthStore } from "../stores/auth.store";

vi.mock("../lib/api-client", () => ({
  listPlans: vi.fn(async () => []),
  createPlan: vi.fn(async () => ({ id: "pl-9" })),
  retirePlan: vi.fn(),
  updatePlan: vi.fn(),
  getPlan: vi.fn(),
  extractApiErrorMessage: vi.fn(() => "Something went wrong."),
  getApiBaseUrl: vi.fn(() => "http://localhost:3003"),
  fetchServiceHealth: vi.fn(async () => ({ version: "test" })),
  fetchDatabaseHealth: vi.fn(async () => ({ latency_ms: 1, error: null })),
}));

function describedTextFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join("");
}

async function openPlanForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <MemoryRouter>
      <PlanManagementPage />
    </MemoryRouter>
  );

  await user.click(await screen.findByRole("button", { name: "Add Plan" }));
  await screen.findByRole("dialog", { name: "Add Plan" });
}

describe("PlanManagementPage", () => {
  beforeEach(() => {
    vi.mocked(listPlans).mockClear();
    vi.mocked(createPlan).mockClear();
    useAuthStore.setState({
      token: "test-token",
      user: { id: "u1", fullName: "Office Administrator", role: "admin" },
      isAuthenticated: true,
    });
  });

  it("reports the missing name and rate beside their fields and focuses the name", async () => {
    const user = userEvent.setup();
    await openPlanForm(user);

    await user.click(screen.getByRole("button", { name: "Save Plan" }));

    const name = screen.getByLabelText("Plan Name");
    const rate = screen.getByLabelText("Monthly Rate (₱)");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();
    expect(describedTextFor(name)).toContain("This field is required");
    expect(rate).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(rate)).toContain("Enter the monthly rate");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("refuses a negative monthly rate with the message the server would give", async () => {
    const user = userEvent.setup();
    await openPlanForm(user);

    await user.type(screen.getByLabelText("Plan Name"), "Fiber 100");
    await user.type(screen.getByLabelText("Monthly Rate (₱)"), "-5");
    await user.click(screen.getByRole("button", { name: "Save Plan" }));

    const rate = screen.getByLabelText("Monthly Rate (₱)");
    expect(rate).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(rate)).toContain("Number must be greater than or equal to 0");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("posts the same plan body the screen always sent, converting pesos to centavos", async () => {
    const user = userEvent.setup();
    await openPlanForm(user);

    await user.type(screen.getByLabelText("Plan Name"), "Fiber 100");
    await user.type(screen.getByLabelText("Speed (Mbps)"), "100");
    await user.type(screen.getByLabelText("Monthly Rate (₱)"), "999.5");
    await user.type(screen.getByLabelText("Reconnection Fee (₱)"), "50");
    await user.click(screen.getByRole("button", { name: "Save Plan" }));

    await waitFor(() => {
      expect(createPlan).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(createPlan).mock.calls[0]?.[0];
    const body: unknown = JSON.parse(JSON.stringify(captured));

    expect(body).toEqual({
      name: "Fiber 100",
      serviceType: "internet",
      speedMbps: 100,
      monthlyRateCentavos: 99950,
      reconnectionFeeCentavos: 5000,
    });
  });

  // The screen's own conversion is `Math.round(parseFloat(pesos) * 100)`, and it
  // is deliberately unchanged: a third decimal place is rounded to the nearest
  // centavo rather than refused. `Math.round` rounds a .5 fraction up, which for
  // the non-negative amounts this form accepts is away from zero, so ₱0.125
  // (12.5 centavos) becomes 13 centavos.
  it("keeps the screen's rounding of a third decimal place", async () => {
    const user = userEvent.setup();
    await openPlanForm(user);

    await user.type(screen.getByLabelText("Plan Name"), "Fiber 100");
    await user.type(screen.getByLabelText("Monthly Rate (₱)"), "0.125");
    await user.click(screen.getByRole("button", { name: "Save Plan" }));

    await waitFor(() => {
      expect(createPlan).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(createPlan).mock.calls[0]?.[0];

    expect(captured?.monthlyRateCentavos).toBe(13);
  });
});
