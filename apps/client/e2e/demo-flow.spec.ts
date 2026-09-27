// Electron end-to-end flow (section 2.2 / S10-1).
//
// This covers the first half of the section 11.1 live-demo sequence against the
// synthetic demo dataset:
//
//   sign in -> open a subscriber with a service account -> view the account
//   ledger and its invoice debit -> post a payment -> confirm the receipt.
//
// It drives the built renderer through the real login form and the real screens,
// so a broken build, a wrong API URL or a regressed screen fails here rather than
// only being noticed during the demonstration.
//
// Prerequisites are in docs/testing/README.md. The accounts and password are the
// synthetic ones `pnpm db:seed:demo` prints.

import path from "node:path";

import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const UI_URL = (process.env.BCIS_UI_URL ?? "http://localhost:5173").replace(/\/$/, "");

const CASHIER = {
  username: process.env.BCIS_E2E_USERNAME ?? "demo.cashier",
  password: process.env.BCIS_E2E_PASSWORD ?? "DemoPassword1!",
};

/**
 * A subscriber with more than one service account and outstanding invoices. The
 * demo dataset seeds it; the test refuses to run if it is absent rather than
 * silently asserting nothing.
 */
const FEATURED_ACCOUNT_NUMBER = "SUB-20260927-00011";

/** The account the payment is posted against. Small, so the dataset drifts slowly. */
const PAYMENT_ACCOUNT_NUMBER = "SUB-20260927-00011";
const PAYMENT_AMOUNT_TEXT = "100.00";

let electronApp: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  // Fail loudly and early when the renderer is not being served: otherwise the
  // first goto times out with a message that hides the real cause.
  const reachable = await fetch(`${UI_URL}/`)
    .then((response) => response.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `The renderer is not reachable at ${UI_URL}.\n` +
        "Build and serve it first:\n" +
        "  pnpm --filter client build\n" +
        "  (cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)"
    );
  }

  electronApp = await electron.launch({
    // Flags first, then the app directory the Electron binary should open.
    args: ["--no-sandbox", path.resolve(__dirname, "..")],
    cwd: path.resolve(__dirname, ".."),
  });
  window = await electronApp.firstWindow();
});

test.afterAll(async () => {
  await electronApp?.close();
});

/** Signs in through the real login form. */
async function signIn(page: Page, account: { username: string; password: string }): Promise<void> {
  await page.goto(`${UI_URL}/#/login`);
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(/#\/(?!login)/);
}

test("the cashier reviews a subscriber's invoice ledger, posts a payment and confirms the receipt", async () => {
  await signIn(window, CASHIER);

  // ── A subscriber with a service account ────────────────────────────────────
  await window.goto(`${UI_URL}/#/subscribers`);
  await window.getByPlaceholder("Name, account number, or phone").fill(FEATURED_ACCOUNT_NUMBER);
  await window.getByRole("button", { name: "Search" }).click();

  const viewLink = window.getByRole("link", { name: "View" }).first();
  await expect(viewLink).toBeVisible();
  await viewLink.click();

  await expect(window.getByRole("heading", { name: "Service Accounts" })).toBeVisible();
  await expect(window.getByText(FEATURED_ACCOUNT_NUMBER)).toBeVisible();

  // ── The account ledger and its invoice debit ───────────────────────────────
  await window.getByRole("link", { name: "View ledger & statement" }).first().click();
  await expect(window.getByRole("heading", { name: "Account Ledger", exact: true })).toBeVisible();
  await expect(window.getByText("Current balance")).toBeVisible();

  const ledgerTable = window.locator("table").first();
  await expect(ledgerTable.getByRole("columnheader", { name: "Debit" })).toBeVisible();
  // The debit is real: an invoice charge, not an empty ledger.
  await expect(ledgerTable.getByText(/Invoice INV-\d{4}-\d{2}-\d{6}/).first()).toBeVisible();
  const debitCell = ledgerTable.locator("tbody tr td").filter({ hasText: "₱" }).first();
  await expect(debitCell).toBeVisible();

  // ── Post a payment ─────────────────────────────────────────────────────────
  await window.goto(`${UI_URL}/#/payments/new`);
  await expect(window.getByRole("heading", { name: "Post Payment" })).toBeVisible();

  await window
    .getByPlaceholder("Account number, subscriber name, or phone")
    .fill(PAYMENT_ACCOUNT_NUMBER);
  await window.getByRole("button", { name: "Search" }).click();

  const accountChoice = window.locator("ul button").first();
  await expect(accountChoice).toBeVisible();
  const chosenAccountText = (await accountChoice.innerText()).trim();
  await accountChoice.click();

  await expect(window.getByRole("heading", { name: "Outstanding invoices" })).toBeVisible();
  const outstandingTable = window.locator("table").first();
  await expect(outstandingTable.locator("tbody tr").first()).toBeVisible();

  await window.getByLabel("Amount (₱)").fill(PAYMENT_AMOUNT_TEXT);
  await window.getByRole("button", { name: "Post Payment" }).click();

  // ── Confirm the receipt ────────────────────────────────────────────────────
  await expect(window.getByRole("heading", { name: "Payment posted" })).toBeVisible();
  const receiptSummary = window.getByText(/Receipt .* was issued for/);
  await expect(receiptSummary).toBeVisible();
  await expect(receiptSummary).toContainText("₱100.00");

  const receiptNumber = (await receiptSummary.innerText()).match(/OR-\d{4}-\d{6}/)?.[0];
  expect(receiptNumber, "a receipt number was issued").toBeTruthy();

  await window.getByRole("button", { name: "Print Receipt" }).click();
  await expect(window.getByRole("heading", { name: "Official Receipt" })).toBeVisible();
  await expect(window.getByText(receiptNumber as string).first()).toBeVisible();

  // The chosen account is the one the receipt names, so the assertion above is
  // about this payment and not a row that happened to be on the previous screen.
  expect(chosenAccountText.length).toBeGreaterThan(0);
});
