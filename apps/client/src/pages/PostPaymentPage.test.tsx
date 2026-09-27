import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostPaymentPage } from "./PostPaymentPage";
import { getServiceAccountPaymentSummary, postPayment, searchSubscribers } from "../lib/api-client";
import { POSTABLE_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@bcis/shared";

vi.mock("../lib/api-client", () => ({
  searchSubscribers: vi.fn(async () => ({
    items: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        accountNumber: "SA-0001",
        firstName: "Juan",
        lastName: "Dela Cruz",
        middleName: null,
        primaryPhone: "09171234567",
        secondaryPhone: null,
        emailAddress: null,
        serviceAddress: "12 Mabini Street",
        serviceBarangay: "Poblacion",
        serviceMunicipality: "Bolinao",
        serviceProvince: "Pangasinan",
        internalNotes: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdBy: "u1",
        updatedBy: null,
        serviceAccounts: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            serviceAccountNumber: "SA-0001",
            planName: "Fiber 100",
          },
        ],
      },
    ],
    page: 1,
    pageSize: 20,
    total: 1,
  })),
  getServiceAccountPaymentSummary: vi.fn(async () => ({
    serviceAccountId: "33333333-3333-4333-8333-333333333333",
    outstandingInvoices: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        invoiceNumber: "INV-2026-0001",
        invoiceDate: "2026-01-01",
        dueDate: "2026-01-15",
        status: "unpaid",
        totalAmountCentavos: 150000,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 150000,
      },
    ],
    outstandingTotalCentavos: 150000,
    creditBalanceCentavos: 0,
  })),
  postPayment: vi.fn(async (input: { paymentMethod: string; amountCentavos: number }) => ({
    payment: {
      id: "55555555-5555-4555-8555-555555555555",
      // The mock server behaves like the real one: a GCash payment comes back
      // claimed rather than received, with nothing allocated.
      receiptNumber: input.paymentMethod === "gcash" ? "OR-2026-000002" : "OR-2026-000001",
      status: input.paymentMethod === "gcash" ? "pending_verification" : "posted",
      amountCentavos: input.amountCentavos,
    },
    allocations: [],
    allocatedCentavos: input.paymentMethod === "gcash" ? 0 : input.amountCentavos,
    advanceCreditCentavos: 0,
  })),
  uploadGcashScreenshot: vi.fn(),
  extractApiErrorMessage: vi.fn(() => "Something went wrong."),
}));

/** The text a screen reader is told explains why a field is invalid. */
function describedTextFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

/** Opens the payment section by finding and selecting one service account. */
async function openPaymentSection(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <MemoryRouter>
      <PostPaymentPage />
    </MemoryRouter>
  );

  await user.type(
    screen.getByPlaceholderText("Account number, subscriber name, or phone"),
    "Dela Cruz"
  );
  await user.click(screen.getByRole("button", { name: "Search" }));
  await user.click(await screen.findByRole("button", { name: /SA-0001/ }));
  await screen.findByRole("heading", { name: "3. Payment" });
}

describe("PostPaymentPage", () => {
  beforeEach(() => {
    vi.mocked(searchSubscribers).mockClear();
    vi.mocked(getServiceAccountPaymentSummary).mockClear();
    vi.mocked(postPayment).mockClear();
  });

  it("focuses the date field and reports it when the payment date is cleared", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    fireEvent.change(screen.getByLabelText("Amount (₱)"), { target: { value: "500.00" } });
    fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    const paymentDate = screen.getByLabelText("Payment date");
    expect(paymentDate).toHaveAttribute("aria-invalid", "true");
    expect(describedTextFor(paymentDate)).toContain("Payment date must be a calendar date");
    expect(postPayment).not.toHaveBeenCalled();
  });

  // Zero, negative, non-numeric and over-precise amounts are all refused before
  // anything reaches the API. `0` and `0.00` are refused by the rule the server
  // itself applies to a payment amount; the rest never parse into centavos.
  it.each([
    ["nothing typed", ""],
    ["zero", "0"],
    ["zero with centavos", "0.00"],
    ["a negative amount", "-5"],
    ["a fractional centavo", "10.005"],
    ["a word", "abc"],
  ])("refuses %s", async (_case, amountText) => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    const amount = screen.getByLabelText("Amount (₱)");
    if (amountText !== "") {
      await user.type(amount, amountText);
    }
    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    await waitFor(() => {
      expect(amount).toHaveAttribute("aria-invalid", "true");
    });
    expect(describedTextFor(amount)).not.toBe("");
    expect(postPayment).not.toHaveBeenCalled();
  });

  it("names the zero-amount refusal in the server's own words", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    await user.type(screen.getByLabelText("Amount (₱)"), "0");
    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    await waitFor(() => {
      expect(describedTextFor(screen.getByLabelText("Amount (₱)"))).toContain(
        "Payment amount must be greater than zero"
      );
    });
  });

  it("converts pesos to whole centavos and posts the same body the screen always sent", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    fireEvent.change(screen.getByLabelText("Amount (₱)"), { target: { value: "999.50" } });
    fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "2026-02-01" } });

    // The preview still reads the amount the clerk typed.
    const previewHeading = await screen.findByText("This payment will be applied as follows:");
    expect(previewHeading).toBeInTheDocument();
    expect(within(previewHeading.parentElement as HTMLElement).getByText("₱999.50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    await waitFor(() => {
      expect(postPayment).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(postPayment).mock.calls[0]?.[0];
    const body: unknown = JSON.parse(JSON.stringify(captured));

    expect(body).toEqual({
      serviceAccountId: "33333333-3333-4333-8333-333333333333",
      paymentMethod: "cash",
      amountCentavos: 99950,
      paymentDate: "2026-02-01",
    });
  });

  it("asks for the reference beside the field and posts the GCash block in the same shape", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    fireEvent.change(screen.getByLabelText("Amount (₱)"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "2026-02-01" } });
    await user.click(screen.getByRole("button", { name: "GCash" }));

    // A GCash payment without a reference is a field error, not a banner.
    await user.click(screen.getByRole("button", { name: "Post Payment" }));
    const reference = screen.getByLabelText("Reference number");
    await waitFor(() => {
      expect(reference).toHaveAttribute("aria-invalid", "true");
    });
    expect(describedTextFor(reference)).toContain("A GCash reference number is required");
    expect(postPayment).not.toHaveBeenCalled();

    await user.type(reference, " 1234567890 ");
    await user.type(screen.getByLabelText("Sender name"), "Maria Santos");
    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    await waitFor(() => {
      expect(postPayment).toHaveBeenCalledTimes(1);
    });
    const captured = vi.mocked(postPayment).mock.calls[0]?.[0];
    const body: unknown = JSON.parse(JSON.stringify(captured));

    expect(body).toEqual({
      serviceAccountId: "33333333-3333-4333-8333-333333333333",
      paymentMethod: "gcash",
      amountCentavos: 10000,
      paymentDate: "2026-02-01",
      gcash: {
        referenceNumber: "1234567890",
        senderName: "Maria Santos",
      },
    });
  });

  it("offers every payment method the API accepts, under its own label", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    for (const method of POSTABLE_PAYMENT_METHODS) {
      expect(screen.getByRole("button", { name: PAYMENT_METHOD_LABELS[method] })).toBeInTheDocument();
    }
  });

  // Every method the API accepts has to validate and post, not just the two the
  // counter used to offer.
  it.each(["bank_transfer", "check", "other"] as const)(
    "posts a %s payment the same way it posts cash",
    async (method) => {
      const user = userEvent.setup();
      await openPaymentSection(user);

      fireEvent.change(screen.getByLabelText("Amount (₱)"), { target: { value: "250" } });
      fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "2026-02-01" } });
      await user.click(screen.getByRole("button", { name: PAYMENT_METHOD_LABELS[method] }));
      // Only a GCash payment asks for a reference.
      expect(screen.queryByLabelText("Reference number")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Post Payment" }));

      await waitFor(() => {
        expect(postPayment).toHaveBeenCalledTimes(1);
      });
      const captured = vi.mocked(postPayment).mock.calls[0]?.[0];
      const body: unknown = JSON.parse(JSON.stringify(captured));

      expect(body).toEqual({
        serviceAccountId: "33333333-3333-4333-8333-333333333333",
        paymentMethod: method,
        amountCentavos: 25000,
        paymentDate: "2026-02-01",
      });
      expect(await screen.findByRole("heading", { name: "Payment posted" })).toBeInTheDocument();
    }
  );

  it("tells the cashier a GCash claim is awaiting verification, not that the account is settled", async () => {
    const user = userEvent.setup();
    await openPaymentSection(user);

    fireEvent.change(screen.getByLabelText("Amount (₱)"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "2026-02-01" } });
    await user.click(screen.getByRole("button", { name: PAYMENT_METHOD_LABELS.gcash }));
    await user.type(screen.getByLabelText("Reference number"), "1234567890");
    await user.click(screen.getByRole("button", { name: "Post Payment" }));

    expect(
      await screen.findByRole("heading", { name: "GCash payment awaiting verification" })
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Nothing has been applied to the account");
    expect(screen.getByText(/No invoice balance has moved/)).toBeInTheDocument();
    // The claim must not read as "nothing was owed", which is what an empty
    // allocation list means for a payment that has actually posted.
    expect(screen.queryByText("No invoices were outstanding.")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payment posted" })).not.toBeInTheDocument();
  });
});
