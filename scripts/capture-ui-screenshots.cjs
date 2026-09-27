// Captures the section 9 D7 screenshot set from the running application.
//
// Section 9 deliverable D7 asks for UI evidence of seven named screens. The
// navigation smoke check (`verify-electron-gui.cjs`) proves the wiring; this
// script produces the pictures, and each picture must show real seeded data —
// an empty state is not evidence. It drives the real renderer in the same way
// the smoke check does (real Electron, real login form) and refuses to write a
// file unless the screen it names has actually rendered its data.
//
// Usage (all three services must already be running — see README):
//
//   pnpm --filter client build
//   DATABASE_URL=...bcis_demo pnpm --filter server start     # API on :3003
//   (cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)
//   pnpm screenshots
//
// Environment:
//   BCIS_UI_URL         default http://localhost:5173
//   BCIS_API_URL        default http://localhost:3003
//   BCIS_SHOT_DIR       default docs/testing/screenshots
//   BCIS_OWNER_PASSWORD default DemoPassword1!  (the demo password the seed prints)
//
// The demo accounts and the shared password below are the synthetic logins
// `pnpm db:seed:demo` prints. No real credential is ever read or stored here.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const UI_URL = (process.env.BCIS_UI_URL || "http://localhost:5173").replace(/\/$/, "");
const API_URL = (process.env.BCIS_API_URL || "http://localhost:3003").replace(/\/$/, "");
const SHOT_DIR =
  process.env.BCIS_SHOT_DIR || path.join(__dirname, "..", "docs", "testing", "screenshots");

const DEMO_PASSWORD = process.env.BCIS_OWNER_PASSWORD || "DemoPassword1!";
const OWNER = { username: "demo.owner", password: DEMO_PASSWORD };
const CASHIER = { username: "demo.cashier", password: DEMO_PASSWORD };

/** The subscriber the profile and payment screenshots are taken against. */
const FEATURED_SUBSCRIBER_ACCOUNT_NUMBER = "SUB-20260927-00001";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── API access (for choosing which seeded rows to show) ─────────────────────
//
// This script only reads. It never posts, edits or deletes anything, so taking
// the screenshots cannot change the data they are evidence of.

async function apiRequest(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(`${method} ${urlPath} failed: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload.data;
}

async function signInToApi(account) {
  const data = await apiRequest("POST", "/api/auth/login", {
    body: { username: account.username, password: account.password },
  });
  return data.token;
}

/**
 * Chooses the seeded records the screenshots should show. The IDs are read from
 * the API rather than hardcoded, so the set stays valid if the seed is re-run
 * with a different `--seed`.
 */
async function chooseScreenshotTargets(token) {
  const featured = await apiRequest(
    "GET",
    `/api/subscribers/search?q=${encodeURIComponent(FEATURED_SUBSCRIBER_ACCOUNT_NUMBER)}`,
    { token }
  );
  const subscriber = featured.items[0];
  if (!subscriber) {
    throw new Error(`No subscriber matched ${FEATURED_SUBSCRIBER_ACCOUNT_NUMBER}`);
  }

  const batches = await apiRequest("GET", "/api/collector-batches?pageSize=50", { token });
  // Prefer a closed batch: its reconciliation ran, so the screen shows the
  // variance and the remittance history rather than an empty form.
  const batch =
    batches.items.find((item) => item.status === "closed") ??
    batches.items.find((item) => item.reconciledAt !== null) ??
    batches.items.find((item) => item.status === "remitted") ??
    batches.items[0];
  if (!batch) throw new Error("The demo dataset has no collector batch to reconcile");

  const pendingGcash = await apiRequest(
    "GET",
    "/api/payments?method=gcash&status=pending_verification&pageSize=1",
    { token }
  );
  const gcashPayment = pendingGcash.items[0];
  if (!gcashPayment) throw new Error("The demo dataset has no GCash payment awaiting verification");

  return { subscriber, batch, gcashPayment };
}

// ─── Electron driving ────────────────────────────────────────────────────────

/**
 * React owns the input values, so `el.value = x` is ignored. Use the native
 * setter and dispatch the event React listens for. Same trick the smoke check
 * uses, because the comparisons it makes must be against the real renderer.
 */
function typeIntoField(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return `missing selector ${selector}`;
  const prototype =
    el.tagName === "SELECT"
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  return "ok";
}

/** Clicks the first button whose trimmed text equals `label`. */
function clickButtonByText(label) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent.trim() === label
  );
  if (!button) return `no button labelled "${label}"`;
  button.click();
  return "ok";
}

/** Signs in through the real login form. Returns "" on success, else the error. */
async function signInThroughForm(win, account) {
  await win.loadURL(`${UI_URL}/#/login`);
  await wait(1500);

  const typedUser = await win.webContents.executeJavaScript(
    `(${typeIntoField.toString()})('input[name="username"], input#username, input[type="text"]', ${JSON.stringify(account.username)})`
  );
  const typedPass = await win.webContents.executeJavaScript(
    `(${typeIntoField.toString()})('input[name="password"], input#password, input[type="password"]', ${JSON.stringify(account.password)})`
  );
  if (typedUser !== "ok" || typedPass !== "ok") return `${typedUser} / ${typedPass}`;

  await wait(200);
  await win.webContents.executeJavaScript(`
    (function submit() {
      const form = document.querySelector("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    })()
  `);
  await wait(3000);

  return win.webContents.executeJavaScript(
    'document.querySelector(\'[role="alert"]\')?.textContent?.trim() ?? ""'
  );
}

/**
 * Polls a predicate in the renderer until it is truthy on two consecutive polls.
 * Waiting on the screen's own content, not on a fixed delay, is what stops a
 * screenshot being taken of a skeleton; the second confirmation rejects the
 * moment a filter change replaces the rows it just matched with a loading view.
 */
async function waitForScreen(win, predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let previous = false;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      ready = await win.webContents.executeJavaScript(`Boolean(${predicate})`);
    } catch {
      ready = false;
    }
    if (ready && previous) return true;
    previous = ready;
    await wait(450);
  }
  console.log(`  FAIL  ${description} — predicate never became true`);
  return false;
}

async function bodyText(win) {
  return win.webContents.executeJavaScript("document.body.innerText");
}

async function capture(win, file) {
  const image = await win.webContents.capturePage();
  const target = path.join(SHOT_DIR, file);
  fs.writeFileSync(target, image.toPNG());
  const { size } = fs.statSync(target);
  const kilobytes = Math.round(size / 1024);
  console.log(`  shot  ${file}  (${kilobytes} KB)`);
  return size;
}

/** Non-trivial size: a blank or near-blank PNG of this window compresses small. */
const MINIMUM_PNG_BYTES = 15 * 1024;

/**
 * Drives one screen and writes one PNG. Every screen declares a `ready`
 * predicate and the strings that prove it is showing seeded data; a file is only
 * written when both hold, so the screenshot set can never silently degrade into
 * pictures of empty states.
 */
async function captureScreen(win, screen) {
  console.log(`\n${screen.file} — ${screen.label} (${screen.account.username})`);
  await win.loadURL(`${UI_URL}/${screen.path}`);
  const rendered = await waitForScreen(win, screen.ready, `${screen.label} rendered`);
  if (!rendered) return false;

  if (screen.prepare) {
    const result = await screen.prepare(win);
    if (result !== "ok") {
      console.log(`  FAIL  ${screen.label} — prepare: ${result}`);
      return false;
    }
  }

  const text = (await bodyText(win)).toLowerCase();
  const missing = screen.mustShow.filter(
    (needle) => !text.includes(needle.toLowerCase())
  );
  if (missing.length > 0) {
    console.log(`  FAIL  ${screen.label} — screen did not show: ${JSON.stringify(missing)}`);
    return false;
  }

  // Some screens prove themselves in their table, not in the page around it (a
  // <select> offers "Pending Verification" as an option before any such row has
  // loaded). `requireTableText` closes that gap.
  if (screen.requireTableText) {
    const tableText = await win.webContents.executeJavaScript(
      'document.querySelector("table tbody")?.innerText ?? ""'
    );
    const absent = screen.requireTableText.filter((needle) => !tableText.includes(needle));
    if (absent.length > 0) {
      console.log(`  FAIL  ${screen.label} — table rows did not show: ${JSON.stringify(absent)}`);
      return false;
    }
  }

  const bytes = await capture(win, screen.file);
  if (bytes < MINIMUM_PNG_BYTES) {
    console.log(`  FAIL  ${screen.file} is only ${bytes} bytes — looks blank`);
    return false;
  }
  return true;
}

// ─── Screens ─────────────────────────────────────────────────────────────────
//
// Section 9 D7's seven screens, in the order the deliverable lists them. The
// subscriber, batch and payment ids come from `targets`, chosen above.

function buildScreens(targets) {
  // A screen is only settled once no loading skeleton is on it. The skeleton is
  // `animate-pulse`, so its absence plus real rows is what proves data rendered.
  const settled = (condition) => `!document.querySelector(".animate-pulse") && (${condition})`;
  const tableBodyHas = (text) =>
    `(document.querySelector("table tbody")?.innerText ?? "").includes(${JSON.stringify(text)})`;

  return [
    {
      file: "01-dashboard.png",
      label: "Management Dashboard",
      account: OWNER,
      path: "#/dashboard",
      ready: settled(
        'document.body.innerText.includes("Management Dashboard") &&' +
          " document.querySelectorAll(\"table tbody tr\").length > 0"
      ),
      // Financial balances must be on screen, not just the frame.
      mustShow: ["Management Dashboard", "Total Outstanding AR", "Recent payments"],
    },
    {
      file: "02-subscriber-profile.png",
      label: "Subscriber profile",
      account: OWNER,
      path: `#/subscribers/${targets.subscriber.id}`,
      ready: settled(
        'document.body.innerText.includes("Service Accounts") &&' +
          ' document.body.innerText.includes("Recent Payment History")'
      ),
      mustShow: [
        `${targets.subscriber.lastName}, ${targets.subscriber.firstName}`,
        "Service Accounts",
        "Recent Payment History",
      ],
    },
    {
      file: "03-receive-payment.png",
      label: "Receive payment (cashier)",
      account: CASHIER,
      path: "#/payments/new",
      ready: 'document.body.innerText.includes("Post Payment")',
      // Select the featured account so the balance summary is on screen: the
      // cashier flow's whole point is the outstanding-invoice preview.
      prepare: async (win) => {
        const typed = await win.webContents.executeJavaScript(
          `(${typeIntoField.toString()})('input[placeholder^="Account number"]', ${JSON.stringify(FEATURED_SUBSCRIBER_ACCOUNT_NUMBER)})`
        );
        if (typed !== "ok") return typed;
        const searched = await win.webContents.executeJavaScript(
          `(${clickButtonByText.toString()})('Search')`
        );
        if (searched !== "ok") return searched;
        const listed = await waitForScreen(
          win,
          'document.querySelectorAll("ul button").length > 0',
          "search results"
        );
        if (!listed) return "no search result appeared";
        const chosen = await win.webContents.executeJavaScript(
          'document.querySelector("ul button").click(), "ok"'
        );
        if (chosen !== "ok") return chosen;
        const summary = await waitForScreen(
          win,
          settled(
            'document.body.innerText.includes("Outstanding invoices") &&' +
              " document.querySelectorAll(\"table tbody tr\").length > 0"
          ),
          "outstanding invoice summary"
        );
        return summary ? "ok" : "balance summary never rendered";
      },
      mustShow: ["Post Payment", "Outstanding invoices", "Balance", "Total outstanding"],
    },
    {
      file: "04-gcash-verification-queue.png",
      label: "GCash verification — pending queue",
      account: OWNER,
      path: "#/payments",
      ready: settled('document.body.innerText.includes("Payment History")'),
      // There is no dedicated GCash Verification screen in this build (S7-6 is
      // unsatisfied). The closest real screen is the payment history filtered to
      // the GCash payments still awaiting verification, which is what a verifier
      // works from today. See docs/testing/screenshots/README.md.
      prepare: async (win) => {
        // Match the selects by their option values rather than by position, so a
        // new filter cannot silently make this set the wrong one.
        const setFilter = (optionValue) => `
          (function setFilter() {
            const select = Array.from(document.querySelectorAll("select")).find((candidate) =>
              Array.from(candidate.options).some((option) => option.value === ${JSON.stringify(optionValue)})
            );
            if (!select) return "no select has the option " + ${JSON.stringify(optionValue)};
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
            setter.call(select, ${JSON.stringify(optionValue)});
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return "ok";
          })()
        `;

        const method = await win.webContents.executeJavaScript(setFilter("gcash"));
        if (method !== "ok") return method;
        const status = await win.webContents.executeJavaScript(setFilter("pending_verification"));
        if (status !== "ok") return status;

        const listed = await waitForScreen(
          win,
          settled(tableBodyHas("Pending Verification")),
          "pending GCash rows"
        );
        return listed ? "ok" : "no pending GCash payment was listed";
      },
      // The queue itself must show a pending row, not merely offer the option.
      requireTableText: ["Pending Verification", "GCash"],
      mustShow: ["Payment History", "Pending Verification", "GCash"],
    },
    {
      file: "05-gcash-payment-detail.png",
      label: "GCash verification — a pending payment with its reference",
      account: OWNER,
      path: `#/payments/${targets.gcashPayment.id}`,
      ready: settled(
        'document.body.innerText.includes("Receipt") && document.body.innerText.includes("GCash")'
      ),
      mustShow: ["GCash", "Pending Verification", targets.gcashPayment.gcashReferenceNumber],
    },
    {
      file: "06-collector-reconciliation.png",
      label: "Collector reconciliation",
      account: OWNER,
      path: `#/collector-batches/${targets.batch.id}`,
      ready: settled(
        'document.body.innerText.includes("Expected (collected)") &&' +
          ' document.body.innerText.includes("Variance") &&' +
          " document.querySelectorAll(\"table tbody tr\").length > 0"
      ),
      mustShow: ["Expected (collected)", "Variance", targets.batch.batchNumber],
    },
    {
      file: "07-overdue-accounts.png",
      label: "Overdue accounts",
      account: OWNER,
      path: "#/receivables/overdue",
      ready: settled(
        'document.body.innerText.includes("Overdue Accounts") &&' +
          " document.querySelectorAll(\"table tbody tr\").length > 0"
      ),
      // A real overdue row carries a peso balance; the header does not.
      requireTableText: ["₱"],
      mustShow: ["Overdue Accounts"],
    },
    {
      file: "08-ar-aging.png",
      label: "Accounts receivable aging",
      account: OWNER,
      path: "#/receivables/aging",
      ready: settled(
        'document.body.innerText.includes("Accounts Receivable Aging") &&' +
          " document.querySelectorAll(\"table tbody tr\").length > 0"
      ),
      mustShow: ["Accounts Receivable Aging"],
    },
    {
      file: "09-reports-center.png",
      label: "Reports center",
      account: OWNER,
      path: "#/reports",
      ready: settled(
        'document.body.innerText.includes("Reports Center") &&' +
          " document.querySelectorAll(\"table tbody tr\").length > 0"
      ),
      mustShow: ["Reports Center"],
    },
  ];
}

/** Signs in as each account once, capturing every screen that account owns. */
async function captureAll(win, screens) {
  const results = new Map();
  for (const account of [OWNER, CASHIER]) {
    const accountScreens = screens.filter((screen) => screen.account.username === account.username);
    if (accountScreens.length === 0) continue;

    console.log(`\nSigning in as ${account.username}…`);
    const loginError = await signInThroughForm(win, account);
    if (loginError !== "") {
      for (const screen of accountScreens) results.set(screen.file, false);
      console.log(`  FAIL  login for ${account.username}: ${loginError}`);
      continue;
    }

    for (const screen of accountScreens) {
      results.set(screen.file, await captureScreen(win, screen));
    }
  }
  return results;
}

app.whenReady().then(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  try {
    const token = await signInToApi(OWNER);
    const targets = await chooseScreenshotTargets(token);
    console.log(
      `Targets: subscriber ${targets.subscriber.accountNumber}, ` +
        `batch ${targets.batch.batchNumber}, ` +
        `GCash ${targets.gcashPayment.gcashReferenceNumber}`
    );

    const win = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: true, // a hidden window is not evidence the GUI renders
      webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false },
    });
    await wait(700);

    const screens = buildScreens(targets);
    const results = await captureAll(win, screens);

    const passed = [...results.values()].filter(Boolean).length;
    console.log(`\n${passed}/${screens.length} screenshots captured into ${SHOT_DIR}`);
    for (const screen of screens) {
      if (!results.get(screen.file)) console.log(`  MISSING  ${screen.file} (${screen.label})`);
    }
    app.exit(passed === screens.length ? 0 : 1);
  } catch (error) {
    console.error(`Screenshot capture failed: ${error && error.message ? error.message : error}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => app.quit());
