# Phase 8 — Reports and Management Dashboard

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 8: Reports and Management Dashboard. Create the
> dashboard KPI endpoint (active subscribers, revenue this month, outstanding AR, overdue accounts).
> Implement the required reports: Daily Collection Summary, Monthly Billing Summary, AR Aging Report,
> Subscriber Ledger/SOA, Collector Remittance Report. Export to PDF (using pdf-lib or Puppeteer)
> and XLSX (using ExcelJS). Add a print-preview screen in Electron. Use the spec at
> specs/phase8-reports-dashboard.md."

---

## 1. Overview

Reports turn the financial data into decisions. The Management Dashboard gives the owner/manager
a real-time pulse of the business. Individual reports answer specific operational questions.

All reports have two output modes:
1. **On-screen** — rendered in the React UI, fast, filterable
2. **Export** — PDF for printing and archiving, XLSX for further analysis in spreadsheets

**Instructor checkpoint:** CP5 — Reports/Security

---

## 2. Dashboard KPIs

The dashboard is the first screen after login for Admin and Manager roles.

```typescript
// apps/server/src/modules/dashboard/dashboard.service.ts
// Returns all KPI numbers in a single query bundle.
// These numbers should be fast to compute — add database indexes if needed.

export interface DashboardKPIs {
  // Subscriber metrics
  totalActiveServiceAccounts: number;
  newServiceAccountsThisMonth: number;
  suspendedAccounts: number;
  terminatedAccounts: number;

  // Revenue metrics (current calendar month)
  totalInvoicedThisMonthCentavos: number;
  totalCollectedThisMonthCentavos: number;
  collectionRatePercent: number; // (collected / invoiced) * 100

  // AR metrics (as of today)
  totalOutstandingArCentavos: number;
  overdueOver30DaysCentavos: number;  // invoices > 30 days past due
  overdueOver90DaysCentavos: number;  // invoices > 90 days past due

  // Collection operations
  openCollectorBatches: number;
  submittedBatchesPendingReconciliation: number;

  // Last billing run info
  lastBillingRunDate: string | null;
  lastBillingRunAccountsCount: number | null;
}
```

---

## 3. Required Reports

### R1: Daily Collection Summary
**Purpose:** Shows all payments collected on a specific day — for end-of-day cash count.

| Column | Source |
|--------|--------|
| Receipt # | `payments.receipt_number` |
| Time | `payments.posted_at` |
| Subscriber | `subscribers.full_name` |
| Service Account | `service_accounts.service_account_number` |
| Method | `payments.payment_method` |
| Amount | `payments.amount_centavos` |
| Posted By | `users.full_name` |

**Totals row:** Cash Total | GCash Total | Grand Total

**Use case:** End-of-day cashier reconciliation with physical cash.

---

### R2: Monthly Billing Summary
**Purpose:** Shows all invoices generated for a billing period — for management review.

| Column | Source |
|--------|--------|
| Invoice # | `invoices.invoice_number` |
| Subscriber | subscriber name |
| Service Account | account number |
| Plan | plan name |
| Invoice Date | `invoices.invoice_date` |
| Due Date | `invoices.due_date` |
| Amount | `invoices.total_amount_centavos` |
| Paid | `invoices.paid_amount_centavos` |
| Balance | `invoices.remaining_balance_centavos` |
| Status | `invoices.status` |

**Totals row:** Total Invoiced | Total Paid | Total Outstanding

---

### R3: AR Aging Report
*Defined in Phase 7 — this is the export version.*

Columns: Subscriber | Account # | Plan | Current | 1-30 Days | 31-60 Days | 61-90 Days | 90+ Days | Total

Totals row per column.

**For PDF:** Landscape orientation, page breaks by aging bucket summary.

---

### R4: Subscriber Statement of Account (SOA)
*Defined in Phase 6 — this is the formatted print version.*

Individual subscriber financial history document. Printed and handed to subscriber on request.

---

### R5: Collector Remittance Report
**Purpose:** Shows what a collector collected and submitted — used during reconciliation.

| Section | Data |
|---------|------|
| Header | Batch number, collector name, collection date |
| Line items | Subscriber | Account | Collected | Method | Result |
| Summary | Expected remittance, Actual remittance, Variance |
| Sign-off | Collector signature, Office receiver signature |

---

### R6: Outstanding Receivables by Collector
**Purpose:** Which collector's assigned accounts have the most overdue balance.

| Column | Source |
|--------|--------|
| Collector | user name |
| Assigned Accounts | count |
| Total Outstanding | sum of remaining balances |
| 30-60 Days | sub-total |
| 60-90 Days | sub-total |
| 90+ Days | sub-total |

---

## 4. PDF Generation

```typescript
// apps/server/src/shared/pdf/report-generator.ts
// Uses Puppeteer to render HTML → PDF.
// Benefits: full CSS control, same HTML as screen, page headers/footers native.

import puppeteer from "puppeteer";

export async function generatePdfFromHtml(
  htmlContent: string,
  options: {
    orientation?: "portrait" | "landscape";
    includeBackground?: boolean;
  } = {}
): Promise<Buffer> {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(htmlContent, { waitUntil: "networkidle0" });

  const pdfBuffer = await page.pdf({
    format: "A4",
    landscape: options.orientation === "landscape",
    printBackground: options.includeBackground ?? true,
    margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size:8px; width:100%; text-align:right; padding-right:15mm;">
        <span class="title"></span>
      </div>`,
    footerTemplate: `
      <div style="font-size:8px; width:100%; text-align:center;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
  });

  await browser.close();
  return Buffer.from(pdfBuffer);
}
```

---

## 5. XLSX Generation

```typescript
// apps/server/src/shared/xlsx/report-generator.ts
// Uses ExcelJS for structured, styled spreadsheets.

import ExcelJS from "exceljs";

export async function generateArAgingXlsx(
  agingData: ArAgingData
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BCIS System";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("AR Aging", {
    pageSetup: { orientation: "landscape", fitToPage: true },
  });

  // Header styling — company name, report title, date
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = "ACCOUNTS RECEIVABLE AGING REPORT";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A1").alignment = { horizontal: "center" };

  sheet.mergeCells("A2:G2");
  sheet.getCell("A2").value = `As of ${formatDate(agingData.asOfDate)}`;
  sheet.getCell("A2").alignment = { horizontal: "center" };

  // Column headers
  const headers = [
    "Subscriber", "Account #", "Plan",
    "Current", "1-30 Days", "31-60 Days", "61-90 Days", "90+ Days", "Total"
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center" };
  });

  // Data rows
  for (const entry of agingData.entries) {
    sheet.addRow([
      entry.subscriberName,
      entry.serviceAccountNumber,
      entry.planName,
      centavosToPhp(entry.currentCentavos),
      centavosToPhp(entry.bucket_1_30_centavos),
      centavosToPhp(entry.bucket_31_60_centavos),
      centavosToPhp(entry.bucket_61_90_centavos),
      centavosToPhp(entry.over_90_centavos),
      centavosToPhp(entry.totalOutstandingCentavos),
    ]);
  }

  // Totals row
  const totalsRow = sheet.addRow([
    "TOTAL", "", "",
    centavosToPhp(agingData.totals.current),
    centavosToPhp(agingData.totals.bucket_1_30),
    centavosToPhp(agingData.totals.bucket_31_60),
    centavosToPhp(agingData.totals.bucket_61_90),
    centavosToPhp(agingData.totals.over_90),
    centavosToPhp(agingData.totals.grandTotal),
  ]);
  totalsRow.font = { bold: true };

  // Number format for currency columns
  sheet.columns.forEach((col, i) => {
    if (i >= 3) { // currency columns
      col.numFmt = '₱#,##0.00';
    }
    col.width = i < 3 ? 25 : 15;
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
```

---

## 6. Electron Print Integration

```typescript
// The Electron main process handles actual OS printing.
// React sends a "print this window" IPC message.
// Electron renders the receipt/report in a hidden window and sends to OS print dialog.

// electron/main.ts
ipcMain.handle("print-window", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)!;
  window.webContents.print(
    { silent: false, printBackground: true },
    (success, reason) => {
      if (!success) console.error("Print failed:", reason);
    }
  );
});

// For report preview: open a new window with the report HTML
ipcMain.handle("open-print-preview", async (_, htmlContent: string) => {
  const previewWindow = new BrowserWindow({
    width: 900, height: 700,
    title: "Print Preview",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
});
```

---

## 7. API Endpoints

```
GET /api/dashboard/kpis                          → All KPI numbers

GET /api/reports/daily-collection?date=          → Daily collection summary
GET /api/reports/monthly-billing?year=&month=    → Monthly billing summary
GET /api/reports/ar-aging?asOf=                  → AR aging report
GET /api/reports/collector-remittance?batchId=   → Collector remittance for a batch
GET /api/reports/outstanding-by-collector        → Receivables grouped by collector

POST /api/reports/export-pdf                     → Generate and return PDF buffer
POST /api/reports/export-xlsx                    → Generate and return XLSX buffer
     Body: { reportType: string, params: object }
```

---

## 8. UI Screens

### Management Dashboard
- KPI cards: Active Accounts | Monthly Invoiced | Monthly Collected | Collection Rate %
- KPI cards: Total Outstanding AR | Overdue 30+ Days | Overdue 90+ Days
- AR Aging mini-chart (bar chart or horizontal bar)
- Open Batches notification (if any pending reconciliation)
- Recent Payments table (last 10)

### Reports Center
- Report selector sidebar: Daily Collection | Monthly Billing | AR Aging | SOA | Remittance | etc.
- Report parameters panel (date pickers, filters)
- "Generate" button → renders on screen
- "Export PDF" button → triggers download / opens print dialog
- "Export XLSX" button → triggers download

---

## 9. Acceptance Criteria

- [ ] Dashboard loads in under 2 seconds with all KPIs
- [ ] Daily Collection Summary totals match sum of payments posted for that day
- [ ] Monthly Billing Summary totals match billing run totals
- [ ] AR Aging grand total = sum of all outstanding invoice balances (tested)
- [ ] PDF export produces a readable, printable document with correct data
- [ ] XLSX export opens in Excel/LibreOffice with correct values and formatting
- [ ] Print preview opens in a new Electron window
- [ ] Collector Remittance Report shows variance clearly
- [ ] Manager role can view and export all reports
- [ ] Cashier role can view Daily Collection but not all management reports
- [ ] Reports handle empty data gracefully (no crashes on zero results)
