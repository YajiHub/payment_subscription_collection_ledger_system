import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import type { UserRole } from "@bcis/shared";
import { AppNavigation } from "./AppNavigation";
import { useAuthStore } from "../stores/auth.store";

/**
 * The navigation contract (spec S7-8, section 4.2): Dashboard first, then the
 * eight remaining top-level sections in order, a Services section that reaches the
 * service-account and suspension screens, and a menu that only offers what the
 * signed-in role may actually open.
 */

const SECTION_HEADINGS = [
  "Subscribers",
  "Billing",
  "Payments",
  "Collections",
  "Receivables",
  "Services",
  "Reports",
  "Administration",
] as const;

const ADMIN_LINK_ORDER = [
  "Dashboard",
  "Subscribers",
  "Add Subscriber",
  "Billing Runs",
  "Invoices",
  "Subscription Plans",
  "Post Payment",
  "Payment Ledger",
  // S7-6: the GCash verification queue under Payments.
  "GCash Verification",
  "Collector Batches",
  "AR Aging Analysis",
  "Overdue Accounts",
  "Service Accounts",
  "Suspension & Reconnection",
  "Reports Center",
  "User Management",
  "Audit Trail",
  "System Settings",
  // S5-3: the backup and restore screen lives in Administration.
  "Backup & Restore",
] as const;

function signInAs(role: UserRole | null): void {
  useAuthStore.setState({
    token: role === null ? null : "test-token",
    user: role === null ? null : { id: "user-1", fullName: "Test User", role },
    isAuthenticated: role !== null,
  });
}

function renderNavigation(initialEntries = ["/"]): void {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppNavigation />
    </MemoryRouter>,
  );
}

function linkLabels(): string[] {
  return screen
    .queryAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "");
}

describe("AppNavigation", () => {
  beforeEach(() => {
    signInAs("admin");
  });

  it("lists every section of section 4.2 in order, Dashboard first", () => {
    renderNavigation();

    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    // Each section is one div whose first child is the heading — or, for a
    // section that is its own screen, the link carrying the section's name.
    const sectionLabels = Array.from(nav.children)
      .filter((child) => child.tagName === "DIV")
      .map((section) => section.firstElementChild?.textContent?.trim() ?? "");

    expect(sectionLabels).toEqual(["Dashboard", ...SECTION_HEADINGS]);
    expect(linkLabels()).toEqual([...ADMIN_LINK_ORDER]);
  });

  it("offers a Services section that reaches service accounts and suspension", () => {
    renderNavigation();

    expect(linkLabels()).toContain("Service Accounts");
    expect(linkLabels()).toContain("Suspension & Reconnection");
  });

  it("points every link at the route that screen lives on", () => {
    renderNavigation();

    const hrefByLabel = new Map(
      screen.getAllByRole("link").map((link) => [
        link.textContent?.trim() ?? "",
        link.getAttribute("href"),
      ]),
    );

    expect(hrefByLabel.get("Dashboard")).toBe("/dashboard");
    expect(hrefByLabel.get("Service Accounts")).toBe("/services/accounts");
    expect(hrefByLabel.get("Suspension & Reconnection")).toBe("/services/suspension");
    expect(hrefByLabel.get("Collector Batches")).toBe("/collector-batches");
    expect(hrefByLabel.get("GCash Verification")).toBe("/payments/gcash");
  });

  it("withholds the screens a role may not open", () => {
    // The Collector works batches and reads accounts; nothing here is theirs to
    // cashier, configure or administer.
    signInAs("collector");
    renderNavigation();

    const labels = linkLabels();

    expect(labels).not.toContain("User Management");
    expect(labels).not.toContain("Audit Trail");
    expect(labels).not.toContain("System Settings");
    expect(labels).not.toContain("Backup & Restore");
    expect(labels).not.toContain("Subscription Plans");
    expect(labels).not.toContain("Post Payment");
    expect(labels).not.toContain("Dashboard");
    expect(labels).toContain("Collector Batches");
    expect(labels).toContain("Service Accounts");
    // The Collector holds no GCash verification permission, so the queue is absent.
    expect(labels).not.toContain("GCash Verification");
  });

  it("offers the GCash verification queue to a role that may verify", () => {
    signInAs("cashier");
    renderNavigation();

    expect(linkLabels()).toContain("GCash Verification");
  });

  it("offers the Administrator a deliberate lock beside the log-out control", () => {
    renderNavigation();

    expect(screen.getByRole("button", { name: "Lock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("offers nothing but logout when nobody is signed in", () => {
    signInAs(null);
    renderNavigation();

    expect(linkLabels()).toEqual([]);
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("highlights Post Payment without highlighting Payment Ledger when on /payments/new", () => {
    renderNavigation(["/payments/new"]);

    const postPaymentLink = screen.getByRole("link", { name: "Post Payment" });
    const paymentLedgerLink = screen.getByRole("link", { name: "Payment Ledger" });

    expect(postPaymentLink).toHaveAttribute("aria-current", "page");
    expect(paymentLedgerLink).not.toHaveAttribute("aria-current");
  });

  it("highlights GCash Verification without highlighting Payment Ledger when on /payments/gcash", () => {
    renderNavigation(["/payments/gcash"]);

    const gcashLink = screen.getByRole("link", { name: "GCash Verification" });
    const paymentLedgerLink = screen.getByRole("link", { name: "Payment Ledger" });

    expect(gcashLink).toHaveAttribute("aria-current", "page");
    expect(paymentLedgerLink).not.toHaveAttribute("aria-current");
  });

  it("highlights Payment Ledger when on /payments", () => {
    renderNavigation(["/payments"]);

    const paymentLedgerLink = screen.getByRole("link", { name: "Payment Ledger" });
    const postPaymentLink = screen.getByRole("link", { name: "Post Payment" });
    const gcashLink = screen.getByRole("link", { name: "GCash Verification" });

    expect(paymentLedgerLink).toHaveAttribute("aria-current", "page");
    expect(postPaymentLink).not.toHaveAttribute("aria-current");
    expect(gcashLink).not.toHaveAttribute("aria-current");
  });

  it("highlights Add Subscriber without highlighting Subscribers landing when on /subscribers/new", () => {
    renderNavigation(["/subscribers/new"]);

    const addSubscriberLink = screen.getByRole("link", { name: "Add Subscriber" });
    const subscribersLink = screen.getByRole("link", { name: "Subscribers" });

    expect(addSubscriberLink).toHaveAttribute("aria-current", "page");
    expect(subscribersLink).not.toHaveAttribute("aria-current");
  });
});
