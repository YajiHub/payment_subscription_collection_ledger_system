// Electron GUI smoke check.
//
// Loads the real renderer, signs in through the real login form, captures a
// screenshot of each screen, and asserts that the navigation menu offers each
// role exactly the screens its permissions allow.
//
// This exists because the renderer is the one part of the system with no unit
// tests, and because a navigation bug hid the entire User Management screen from
// the Administrator while every API test still passed. It checks the wiring, not
// the pixels.
//
// Usage (the UI must already be served — see docs/known-limitations.md):
//
//   pnpm --filter client build
//   (cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)
//   pnpm verify:gui
//
// Environment:
//   BCIS_UI_URL               default http://localhost:5173
//   BCIS_ADMIN_USERNAME       default admin
//   BCIS_ADMIN_PASSWORD       default Admin@1234!
//   BCIS_VERIFY_ROLE_USERNAME optional: a non-admin account to check the denials
//   BCIS_VERIFY_ROLE_PASSWORD
//   BCIS_GUI_SHOT_DIR         default apps/client/out/gui-shots
//
// Exit code 0 means every assertion held; 1 means at least one failed.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const UI_URL = (process.env.BCIS_UI_URL || "http://localhost:5173").replace(/\/$/, "");
const SHOT_DIR =
  process.env.BCIS_GUI_SHOT_DIR ||
  path.join(__dirname, "..", "apps", "client", "out", "gui-shots");

const ADMIN_USERNAME = process.env.BCIS_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.BCIS_ADMIN_PASSWORD || "Admin@1234!";
const ROLE_USERNAME = process.env.BCIS_VERIFY_ROLE_USERNAME || "";
const ROLE_PASSWORD = process.env.BCIS_VERIFY_ROLE_PASSWORD || "";

/** Links the Administrator must be offered, in addition to the whole menu. */
const ADMIN_REQUIRED_LINKS = [
  "Subscribers",
  "Subscription Plans",
  "Billing Runs",
  "Payment Ledger",
  "Post Payment",
  "Collector Batches",
  "Dashboard",
  "Reports Center",
  "AR Aging Analysis",
  "Overdue Accounts",
  // Section 4.2 / S4-9: the Services section, whose screens already exist.
  "Service Accounts",
  "Suspension & Reconnection",
  "User Management",
  "Audit Trail",
  "System Settings",
  // Section 4.4 / S5-3: the backup and restore screen holds real controls, so the
  // Administrator must be offered it and a lower-privileged role must not.
  "Backup & Restore",
];

/**
 * The whole menu in the order section 4.2 requires, for the Administrator who
 * holds every permission. Dashboard first, then the eight remaining sections.
 */
const ADMIN_MENU_ORDER = [
  "Dashboard",
  "Subscribers",
  "Add Subscriber",
  "Billing Runs",
  "Invoices",
  "Subscription Plans",
  "Post Payment",
  "Payment Ledger",
  "Collector Batches",
  "AR Aging Analysis",
  "Overdue Accounts",
  "Service Accounts",
  "Suspension & Reconnection",
  "Reports Center",
  "User Management",
  "Audit Trail",
  "System Settings",
  "Backup & Restore",
];

/** The section headings every menu offers, in order. */
const SECTION_HEADINGS = [
  "Subscribers",
  "Billing",
  "Payments",
  "Collections",
  "Receivables",
  "Services",
  "Reports",
  "Administration",
];

/** Links no non-administrator may be offered, whatever else they may see. */
const NON_ADMIN_FORBIDDEN_LINKS = ["User Management", "System Settings"];

const failures = [];
const checks = [];

function check(description, condition, detail) {
  checks.push({ description, passed: Boolean(condition) });
  if (condition) {
    console.log(`  PASS  ${description}`);
  } else {
    console.log(`  FAIL  ${description}${detail ? ` -> ${detail}` : ""}`);
    failures.push(description);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// React owns the input values, so `el.value = x` is ignored. Use the native
// setter and dispatch the event React listens for.
function typeIntoField(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return `missing selector ${selector}`;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
}

async function uiIsReachable() {
  try {
    const response = await fetch(`${UI_URL}/`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function buildWindow() {
  return new BrowserWindow({
    width: 1440,
    height: 1000,
    show: true, // a hidden window is not evidence the GUI works
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  });
}

async function capture(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`  shot  ${path.relative(process.cwd(), file)}`);
}

async function readNavLinks(win) {
  return win.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll("nav a")).map((a) => a.textContent.trim())'
  );
}

/**
 * The section headings of the menu, in the order they appear on screen. A
 * section that is its own screen (Dashboard, Subscribers) renders as a link
 * instead of a heading, so those two are read from the link list.
 */
async function readNavSectionLabels(win) {
  return win.webContents.executeJavaScript(`
    Array.from(document.querySelector("nav")?.children ?? [])
      .filter((child) => child.tagName === "DIV")
      .map((section) => (section.firstElementChild?.textContent ?? "").trim())
  `);
}

async function signIn(win, username, password) {
  await win.loadURL(`${UI_URL}/#/login`);
  await wait(2000);

  const typedUser = await win.webContents.executeJavaScript(
    `(${typeIntoField.toString()})('input[name="username"], input#username, input[type="text"]', ${JSON.stringify(username)})`
  );
  const typedPass = await win.webContents.executeJavaScript(
    `(${typeIntoField.toString()})('input[name="password"], input#password, input[type="password"]', ${JSON.stringify(password)})`
  );

  if (typedUser !== "ok" || typedPass !== "ok") {
    return { typed: false, hash: "", error: `${typedUser} / ${typedPass}` };
  }

  await wait(250);

  const submitted = await win.webContents.executeJavaScript(`
    (function submit() {
      const form = document.querySelector("form");
      if (!form) return "no form";
      form.requestSubmit ? form.requestSubmit() : form.submit();
      return "ok";
    })()
  `);
  if (submitted !== "ok") return { typed: true, hash: "", error: submitted };

  await wait(4000);

  // A rejected login leaves an alert on the page; distinguish it from success.
  const errorText = await win.webContents.executeJavaScript(
    'document.querySelector(\'[role="alert"]\')?.textContent?.trim() ?? ""'
  );

  return {
    typed: true,
    hash: await win.webContents.executeJavaScript("window.location.hash"),
    error: errorText,
  };
}

async function verifyAdministrator(win) {
  console.log(`\nAdministrator (${ADMIN_USERNAME})`);
  const session = await signIn(win, ADMIN_USERNAME, ADMIN_PASSWORD);

  check("login form accepted the credentials", session.typed && session.error === "", session.error);
  check("login lands the Administrator on the management dashboard", session.hash === "#/dashboard", `got ${session.hash}`);
  await capture(win, "01-admin-dashboard");

  const navLinks = await readNavLinks(win);
  console.log(`  nav: ${JSON.stringify(navLinks)}`);

  for (const link of ADMIN_REQUIRED_LINKS) {
    check(`dashboard menu offers "${link}"`, navLinks.includes(link));
  }

  // Section 4.2 fixes the order, not just the contents of the menu.
  check(
    "the menu reads in the order section 4.2 requires",
    JSON.stringify(navLinks) === JSON.stringify(ADMIN_MENU_ORDER),
    JSON.stringify(navLinks)
  );

  const sectionLabels = await readNavSectionLabels(win);
  check(
    "every section of section 4.2 is present, Dashboard first",
    JSON.stringify(sectionLabels) === JSON.stringify(["Dashboard", ...SECTION_HEADINGS]),
    JSON.stringify(sectionLabels)
  );

  // The regression that prompted this check: the dashboard must not be a dead end.
  await win.loadURL(`${UI_URL}/#/users`);
  await wait(2500);
  const userScreen = await win.webContents.executeJavaScript(`
    (function inspect() {
      const buttons = Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim());
      const rows = document.querySelectorAll("tbody tr").length;
      const heading = document.querySelector("h1")?.textContent?.trim() ?? "";
      const columnHeaders = Array.from(document.querySelectorAll("thead th")).map((th) =>
        (th.textContent ?? "").trim()
      );
      return { heading, buttons, rows, columnHeaders };
    })()
  `);
  await capture(win, "02-admin-users");

  // These strings must match what UserManagementPage.tsx actually renders. The
  // page keeps "User Management" / "Add User"; if it is ever renamed, rename it
  // here too rather than letting the screen and this check disagree.
  check("User Management screen is reachable", userScreen.heading === "User Management", `heading ${userScreen.heading}`);
  check('User Management offers "Add User"', userScreen.buttons.includes("Add User"), JSON.stringify(userScreen.buttons));
  check(
    "User Management renders the role matrix column",
    userScreen.columnHeaders.includes("Role"),
    JSON.stringify(userScreen.columnHeaders)
  );
  check("User Management lists at least the signed-in account", userScreen.rows >= 1, `${userScreen.rows} rows`);
  check(
    "each listed user offers Edit and Deactivate",
    userScreen.buttons.includes("Edit") && userScreen.buttons.includes("Deactivate")
  );
}

async function verifyNonAdministratorRole(win) {
  console.log(`\nNon-administrator (${ROLE_USERNAME})`);
  const session = await signIn(win, ROLE_USERNAME, ROLE_PASSWORD);

  check("role account signed in", session.typed && session.error === "", session.error);
  check(
    "a non-administrator is not sent to the management dashboard",
    session.hash !== "#/dashboard",
    `got ${session.hash}`
  );
  await capture(win, "03-role-home");

  const navLinks = await readNavLinks(win);
  console.log(`  nav: ${JSON.stringify(navLinks)}`);

  for (const link of NON_ADMIN_FORBIDDEN_LINKS) {
    check(`menu withholds "${link}" from this role`, !navLinks.includes(link));
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  if (!(await uiIsReachable())) {
    console.error(
      `Cannot reach the renderer at ${UI_URL}.\n` +
        "Build and serve it first:\n" +
        "  pnpm --filter client build\n" +
        "  (cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)"
    );
    app.exit(1);
    return;
  }

  const win = buildWindow();
  win.webContents.on("console-message", (_event, _level, message) => {
    if (/error|failed|refused|cors/i.test(message)) console.log(`  [renderer] ${message}`);
  });

  await wait(700);
  check("an Electron window is visible", win.isVisible(), JSON.stringify(win.getBounds()));

  try {
    await verifyAdministrator(win);
    if (ROLE_USERNAME && ROLE_PASSWORD) {
      await verifyNonAdministratorRole(win);
    } else {
      console.log(
        "\nSkipping the non-administrator check: set BCIS_VERIFY_ROLE_USERNAME and " +
          "BCIS_VERIFY_ROLE_PASSWORD to include it."
      );
    }
  } catch (error) {
    check("the check ran to completion", false, error && error.message ? error.message : String(error));
  }

  const passed = checks.length - failures.length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (failures.length > 0) {
    console.log("Failed:");
    for (const failure of failures) console.log(`  - ${failure}`);
  }

  app.exit(failures.length > 0 ? 1 : 0);
});

app.on("window-all-closed", () => app.quit());