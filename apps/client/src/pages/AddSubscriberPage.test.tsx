import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddSubscriberPage } from "./AddSubscriberPage";
import { createSubscriber, listPlans } from "../lib/api-client";

vi.mock("../lib/api-client", () => ({
  listPlans: vi.fn(async () => [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Fiber 100",
      serviceType: "internet",
      speedMbps: 100,
      cablePackageDescription: null,
      monthlyRateCentavos: 150000,
      reconnectionFeeCentavos: 50000,
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "u1",
    },
  ]),
  createSubscriber: vi.fn(async () => ({ id: "sub-1" })),
  extractApiErrorMessage: vi.fn(() => "Something went wrong."),
  getApiBaseUrl: vi.fn(() => "http://localhost:3003"),
  fetchServiceHealth: vi.fn(async () => ({ version: "test" })),
  fetchDatabaseHealth: vi.fn(async () => ({ latency_ms: 1, error: null })),
}));

function describedTextFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

async function fillHouseholdStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("First Name"), "Juan");
  await user.type(screen.getByLabelText("Last Name"), "Dela Cruz");
  await user.type(screen.getByLabelText("Primary Phone"), "09171234567");
  await user.type(screen.getByLabelText("Service Address"), "12 Mabini Street");
  await user.type(screen.getByLabelText("Barangay"), "Poblacion");
  await user.type(screen.getByLabelText("Municipality"), "Bolinao");
  await user.type(screen.getByLabelText("Province"), "Pangasinan");
}

describe("AddSubscriberPage", () => {
  beforeEach(() => {
    vi.mocked(listPlans).mockClear();
    vi.mocked(createSubscriber).mockClear();
  });

  it("reports each empty required field beside itself and focuses the first", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSubscriberPage />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));

    const firstName = screen.getByLabelText("First Name");
    const lastName = screen.getByLabelText("Last Name");

    expect(firstName).toHaveAttribute("aria-invalid", "true");
    expect(firstName).toHaveFocus();
    expect(describedTextFor(firstName)).toContain("This field is required");
    expect(lastName).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(lastName)).toContain("This field is required");
    // Step 1 is refused, so the service step is not reached.
    expect(screen.queryByRole("heading", { name: "First Service Account" })).not.toBeInTheDocument();
  });

  it("refuses an implausibly short service address with a message beside it", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSubscriberPage />
      </MemoryRouter>
    );

    await fillHouseholdStep(user);
    await user.clear(screen.getByLabelText("Service Address"));
    await user.type(screen.getByLabelText("Service Address"), "abc");
    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));

    const address = screen.getByLabelText("Service Address");
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(address)).not.toBe("");
    expect(screen.queryByRole("heading", { name: "First Service Account" })).not.toBeInTheDocument();
  });

  it("asks for a plan beside the picker instead of in a banner", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSubscriberPage />
      </MemoryRouter>
    );

    await fillHouseholdStep(user);
    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));
    await screen.findByRole("heading", { name: "First Service Account" });
    await user.click(screen.getByRole("button", { name: "Save Subscriber" }));

    const plan = screen.getByLabelText("Service Plan");
    await waitFor(() => {
      expect(plan).toHaveAttribute("aria-invalid", "true");
    });
    expect(describedTextFor(plan)).toContain("Choose a service plan");
    expect(plan).toHaveFocus();
    expect(createSubscriber).not.toHaveBeenCalled();
  });

  it("posts the same subscriber body the screen always sent, with blank optionals left out", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSubscriberPage />
      </MemoryRouter>
    );

    await fillHouseholdStep(user);
    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));
    await screen.findByRole("heading", { name: "First Service Account" });
    await user.selectOptions(screen.getByLabelText("Service Plan"), "11111111-1111-4111-8111-111111111111");
    await user.click(screen.getByRole("button", { name: "Save Subscriber" }));

    await waitFor(() => {
      expect(createSubscriber).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(createSubscriber).mock.calls[0]?.[0];
    const body: unknown = JSON.parse(JSON.stringify(captured));

    expect(body).toEqual({
      firstName: "Juan",
      lastName: "Dela Cruz",
      primaryPhone: "09171234567",
      serviceAddress: "12 Mabini Street",
      serviceBarangay: "Poblacion",
      serviceMunicipality: "Bolinao",
      serviceProvince: "Pangasinan",
      serviceAccount: { planId: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("sends the optional fields it was given, and refuses an invalid email beside the field", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSubscriberPage />
      </MemoryRouter>
    );

    await fillHouseholdStep(user);
    await user.type(screen.getByLabelText("Middle Name (optional)"), "Reyes");
    await user.type(screen.getByLabelText("Email (optional)"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));

    const email = screen.getByLabelText("Email (optional)");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(email)).not.toBe("");
    expect(createSubscriber).not.toHaveBeenCalled();

    await user.clear(email);
    await user.type(email, "juan@example.com");
    await user.click(screen.getByRole("button", { name: "Next: Service Account" }));
    await screen.findByRole("heading", { name: "First Service Account" });
    await user.selectOptions(screen.getByLabelText("Service Plan"), "11111111-1111-4111-8111-111111111111");
    await user.click(screen.getByRole("button", { name: "Save Subscriber" }));

    await waitFor(() => {
      expect(createSubscriber).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(createSubscriber).mock.calls[0]?.[0];
    const body: unknown = JSON.parse(JSON.stringify(captured));

    expect(body).toMatchObject({
      middleName: "Reyes",
      emailAddress: "juan@example.com",
      serviceAccount: { planId: "11111111-1111-4111-8111-111111111111" },
    });
  });
});
