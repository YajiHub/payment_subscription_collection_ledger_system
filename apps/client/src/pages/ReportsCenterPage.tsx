import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  ALL_REPORT_TYPES,
  REPORT_TYPE_DESCRIPTIONS,
  REPORT_TYPE_LABELS,
  REPORT_TYPE_VIEW_PERMISSIONS,
  SERVICE_ACCOUNT_STATUSES,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  reportNeedsAuditRead,
  roleHasPermission,
  type AnyReportType,
  type ServiceAccountStatus,
  type ServiceType,
} from "@bcis/shared";
import {
  exportReportPdf,
  exportReportXlsx,
  extractApiErrorMessage,
  getAnnualCollectionReport,
  getArAgingReport,
  getAuditLogReport,
  getCollectorAssignmentReport,
  getCollectorPerformanceReport,
  getCollectorRemittanceReport,
  getDailyCollectionReport,
  getMonthlyBillingReport,
  getOutstandingByCollectorReport,
  getPaymentAdjustmentReport,
  getRevenueReport,
  getServiceAccountStatement,
  getSubscriberMasterListReport,
  getUserActivityReport,
  getVoidedReceiptReport,
  getWeeklyCollectionReport,
  listAssignableCollectors,
  listPlans,
  type ReportExportParams,
} from "../lib/api-client";
import {
  buildAnnualCollectionView,
  buildArAgingView,
  buildAuditLogView,
  buildCollectorAssignmentView,
  buildCollectorPerformanceView,
  buildCollectorRemittanceView,
  buildDailyCollectionView,
  buildMonthlyBillingView,
  buildOutstandingByCollectorView,
  buildPaymentAdjustmentView,
  buildRevenueView,
  buildStatementView,
  buildSubscriberMasterListView,
  buildUserActivityView,
  buildVoidedReceiptView,
  buildWeeklyCollectionView,
  type DisplayTable,
} from "../lib/report-views";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

/** Today as YYYY-MM-DD in the office's local calendar day. */
function todayDateOnly(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

/**
 * One input the Reports Center can collect.
 *
 * The list is the union of every parameter the report endpoints accept, so a
 * report's own parameter list (below) is written in the same vocabulary the
 * request is built from. That is what keeps the screen and the query string in
 * step: a field is rendered because it is in the list, and it is sent because it
 * is in the same list (S6-2).
 */
type ReportParameterField =
  | "date"
  | "year"
  | "month"
  | "asOf"
  | "batchId"
  | "serviceAccountId"
  | "fromDate"
  | "toDate"
  | "collectorId"
  | "areaId"
  | "planId"
  | "serviceType"
  | "serviceStatus"
  | "performedBy"
  | "action"
  | "entityType";

/**
 * The parameters each report honours, exactly what its query actually reads.
 *
 * A report that does not apply a filter must not render it: a filter the endpoint
 * ignores looks like it worked and quietly returns the wrong set, which is the
 * defect the audit found (S6-2). The list therefore mirrors the query, not merely
 * the schema: the aging, outstanding-by-collector and annual-collection endpoints
 * accept `fromDate`/`toDate` in their schema but build no date condition from them,
 * so those two controls are deliberately absent for those reports.
 */
const REPORT_PARAMETER_FIELDS: Record<AnyReportType, readonly ReportParameterField[]> = {
  daily_collection: ["date"],
  weekly_collection: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  monthly_billing: ["year", "month"],
  annual_collection: ["year", "collectorId", "areaId", "planId", "serviceType"],
  ar_aging: ["asOf", "collectorId", "areaId", "planId", "serviceType"],
  subscriber_soa: ["serviceAccountId", "fromDate", "toDate"],
  collector_remittance: ["batchId"],
  outstanding_by_collector: ["asOf", "collectorId", "areaId", "planId", "serviceType"],
  revenue_by_plan: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  revenue_by_service_type: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  revenue_by_area: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  collector_assignment: ["collectorId", "areaId", "planId", "serviceType"],
  collector_performance: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  payment_adjustments: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  voided_receipts: ["fromDate", "toDate", "collectorId", "areaId", "planId", "serviceType"],
  user_activity: ["fromDate", "toDate", "performedBy", "action"],
  subscriber_master_list: ["collectorId", "areaId", "planId", "serviceType", "serviceStatus"],
  audit_log: ["fromDate", "toDate", "performedBy", "action", "entityType"],
};

/** The parameters the Reports Center collects for the chosen report. */
interface ReportParameters {
  date: string;
  year: number;
  month: number;
  asOf: string;
  batchId: string;
  serviceAccountId: string;
  fromDate: string;
  toDate: string;
  collectorId: string;
  areaId: string;
  planId: string;
  serviceType: ServiceType | "";
  serviceStatus: ServiceAccountStatus | "";
  performedBy: string;
  action: string;
  entityType: string;
}

function initialParameters(): ReportParameters {
  const today = new Date();
  return {
    date: todayDateOnly(),
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    asOf: todayDateOnly(),
    batchId: "",
    serviceAccountId: "",
    fromDate: "",
    toDate: "",
    collectorId: "",
    areaId: "",
    planId: "",
    serviceType: "",
    serviceStatus: "",
    performedBy: "",
    action: "",
    entityType: "",
  };
}

/**
 * Thrown when a report the catalogue lists has no wiring on this screen yet.
 *
 * The catalogue in `@bcis/shared` is the authority on which reports exist. If a
 * report has no endpoint call or no view here, asking for it is an error rather
 * than a blank page or a request the server would reject.
 */
function reportNotWiredUp(reportType: AnyReportType): Error {
  return new Error(`The ${reportType} report is not wired up in this screen yet.`);
}

/** True when the report accepts the field, so the screen may render and send it. */
function reportAcceptsField(reportType: AnyReportType, field: ReportParameterField): boolean {
  return REPORT_PARAMETER_FIELDS[reportType].includes(field);
}

/** Non-empty text, or undefined: an unfilled filter is omitted, never sent blank. */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The parameters the chosen report asked for, ready for the query string.
 *
 * Only fields the report's own parameter list names are copied, so a request never
 * carries a filter its endpoint would ignore (S6-2). The same object feeds the
 * on-screen call and the export body, so a filtered screen and its export agree.
 */
function buildReportRequest(
  reportType: AnyReportType,
  parameters: ReportParameters
): ReportExportParams {
  const request: ReportExportParams = {};

  for (const field of REPORT_PARAMETER_FIELDS[reportType]) {
    switch (field) {
      case "date":
        request.date = parameters.date;
        break;
      case "year":
        request.year = parameters.year;
        break;
      case "month":
        request.month = parameters.month;
        break;
      case "asOf":
        request.asOf = parameters.asOf;
        break;
      case "batchId":
        request.batchId = optionalText(parameters.batchId);
        break;
      case "serviceAccountId":
        request.serviceAccountId = optionalText(parameters.serviceAccountId);
        break;
      case "fromDate":
        request.fromDate = optionalText(parameters.fromDate);
        break;
      case "toDate":
        request.toDate = optionalText(parameters.toDate);
        break;
      case "collectorId":
        request.collectorId = optionalText(parameters.collectorId);
        break;
      case "areaId":
        request.areaId = optionalText(parameters.areaId);
        break;
      case "planId":
        request.planId = optionalText(parameters.planId);
        break;
      case "serviceType":
        request.serviceType = parameters.serviceType === "" ? undefined : parameters.serviceType;
        break;
      case "serviceStatus":
        request.serviceStatus =
          parameters.serviceStatus === "" ? undefined : parameters.serviceStatus;
        break;
      case "performedBy":
        request.performedBy = optionalText(parameters.performedBy);
        break;
      case "action":
        request.action = optionalText(parameters.action);
        break;
      case "entityType":
        request.entityType = optionalText(parameters.entityType);
        break;
    }
  }

  return request;
}

/** True when the parameters the chosen report needs have been filled in. */
function parametersAreComplete(reportType: AnyReportType, parameters: ReportParameters): boolean {
  if (reportType === "collector_remittance") {
    return parameters.batchId.trim() !== "";
  }
  if (reportType === "subscriber_soa") {
    return parameters.serviceAccountId.trim() !== "";
  }
  return true;
}

/** The on-screen table for a report, built from the data the server sent. */
async function loadReportTable(
  reportType: AnyReportType,
  parameters: ReportParameters
): Promise<DisplayTable> {
  const request = buildReportRequest(reportType, parameters);

  switch (reportType) {
    case "daily_collection":
      return buildDailyCollectionView(await getDailyCollectionReport(request.date));
    case "weekly_collection":
      return buildWeeklyCollectionView(await getWeeklyCollectionReport(request));
    case "monthly_billing":
      return buildMonthlyBillingView(await getMonthlyBillingReport(parameters.year, parameters.month));
    case "annual_collection":
      return buildAnnualCollectionView(await getAnnualCollectionReport(request));
    case "ar_aging":
      return buildArAgingView(await getArAgingReport(request.asOf, request));
    case "subscriber_soa":
      return buildStatementView(
        await getServiceAccountStatement(request.serviceAccountId ?? "", {
          fromDate: request.fromDate,
          toDate: request.toDate,
        })
      );
    case "collector_remittance":
      return buildCollectorRemittanceView(await getCollectorRemittanceReport(request.batchId ?? ""));
    case "outstanding_by_collector":
      return buildOutstandingByCollectorView(
        await getOutstandingByCollectorReport(request.asOf, request)
      );
    case "revenue_by_plan":
      return buildRevenueView(await getRevenueReport("plan", request));
    case "revenue_by_service_type":
      return buildRevenueView(await getRevenueReport("service_type", request));
    case "revenue_by_area":
      return buildRevenueView(await getRevenueReport("area", request));
    case "collector_assignment":
      return buildCollectorAssignmentView(await getCollectorAssignmentReport(request));
    case "collector_performance":
      return buildCollectorPerformanceView(await getCollectorPerformanceReport(request));
    case "payment_adjustments":
      return buildPaymentAdjustmentView(await getPaymentAdjustmentReport(request));
    case "voided_receipts":
      return buildVoidedReceiptView(await getVoidedReceiptReport(request));
    case "user_activity":
      return buildUserActivityView(await getUserActivityReport(request));
    case "subscriber_master_list":
      return buildSubscriberMasterListView(await getSubscriberMasterListReport(request));
    case "audit_log":
      return buildAuditLogView(await getAuditLogReport(request));
    default:
      throw reportNotWiredUp(reportType);
  }
}

/** A warning strip for a report that is not the whole of itself (S6-6). */
function ReportNotice({ message }: { message: string }): ReactNode {
  return (
    <p
      role="status"
      className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-strong"
    >
      {message}
    </p>
  );
}

/** Renders a report table with its totals lines and any cap notice beneath it. */
function ReportTableView({ table }: { table: DisplayTable }): ReactNode {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-content-primary">{table.title}</h2>
        <p className="text-sm text-content-secondary">{table.subtitle}</p>
      </div>

      {table.notice !== undefined && <ReportNotice message={table.notice} />}

      {table.isEmpty ? (
        <Card>
          <EmptyState
            title="Nothing to report"
            description="There is nothing to report for these parameters. Try a different date range, or pick another report from the list."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-content-secondary">
                <tr>
                  {table.columns.map((column) => (
                    <th
                      key={column.header}
                      className={`px-4 py-3 font-medium ${column.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="border-t border-line transition-colors hover:bg-canvas/60"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={`px-4 py-3 ${
                          table.columns[cellIndex]?.align === "right"
                            ? "text-right tabular-nums"
                            : "text-left"
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {table.totalsRows.length > 0 && (
                <tfoot className="bg-canvas font-semibold">
                  {table.totalsRows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-line">
                      {row.map((cell, cellIndex) => (
                        <td
                          key={cellIndex}
                          className={`px-4 py-3 ${
                            table.columns[cellIndex]?.align === "right"
                              ? "text-right tabular-nums"
                              : "text-left"
                          }`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** One labelled filter control. */
function FilterField({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-content-secondary">{label}</span>
      {children}
    </label>
  );
}

interface FilterEditorProps {
  reportType: AnyReportType;
  parameters: ReportParameters;
  onChange: <Key extends keyof ReportParameters>(
    key: Key,
    value: ReportParameters[Key]
  ) => void;
  collectors: { id: string; fullName: string }[];
  plans: { id: string; name: string }[];
}

/**
 * The filter controls for the chosen report, and only those.
 *
 * Each control is rendered because the report's parameter list names its field, so
 * the screen can never offer a filter the endpoint ignores, nor hide one it honours
 * (S6-2). The area filter is a pasted id because the collection-area endpoint does
 * not exist yet; the report endpoints still honour the filter, so the screen must
 * expose it.
 */
function ReportFilterEditor({
  reportType,
  parameters,
  onChange,
  collectors,
  plans,
}: FilterEditorProps): ReactNode {
  const dateField = (key: "date" | "asOf" | "fromDate" | "toDate", label: string): ReactNode => (
    <FilterField label={label}>
      <input
        type="date"
        value={parameters[key]}
        onChange={(event) => onChange(key, event.target.value)}
        className={`${FIELD_CLASS} w-40`}
      />
    </FilterField>
  );

  const textField = (
    key: "batchId" | "serviceAccountId" | "areaId" | "performedBy" | "action" | "entityType",
    label: string,
    placeholder: string
  ): ReactNode => (
    <FilterField label={label}>
      <input
        type="text"
        value={parameters[key]}
        onChange={(event) => onChange(key, event.target.value)}
        placeholder={placeholder}
        className={`${FIELD_CLASS} w-64`}
      />
    </FilterField>
  );

  // The collector and plan lists are best effort: a role that cannot read them
  // still gets the filter as a pasted-id field, so a filter the endpoint honours
  // is never unreachable (S6-2).
  const accountFilter = (
    key: "collectorId" | "planId",
    label: string,
    options: readonly { id: string; name: string }[]
  ): ReactNode => (
    <FilterField label={label}>
      {options.length > 0 ? (
        <select
          value={parameters[key]}
          onChange={(event) => onChange(key, event.target.value)}
          className={`${FIELD_CLASS} w-52`}
        >
          <option value="">All {label.toLowerCase()}s</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={parameters[key]}
          onChange={(event) => onChange(key, event.target.value)}
          placeholder={`Paste the ${label.toLowerCase()} id`}
          className={`${FIELD_CLASS} w-64`}
        />
      )}
    </FilterField>
  );

  return (
    <div className="flex flex-wrap items-end gap-3">
      {reportAcceptsField(reportType, "date") && dateField("date", "Date")}
      {reportAcceptsField(reportType, "asOf") && dateField("asOf", "As of")}
      {reportAcceptsField(reportType, "fromDate") && dateField("fromDate", "From")}
      {reportAcceptsField(reportType, "toDate") && dateField("toDate", "To")}

      {reportAcceptsField(reportType, "year") && (
        <FilterField label="Year">
          <input
            type="number"
            value={parameters.year}
            onChange={(event) =>
              onChange("year", Number.parseInt(event.target.value, 10) || 0)
            }
            className={`${FIELD_CLASS} w-28`}
          />
        </FilterField>
      )}
      {reportAcceptsField(reportType, "month") && (
        <FilterField label="Month">
          <input
            type="number"
            min={1}
            max={12}
            value={parameters.month}
            onChange={(event) => onChange("month", Number.parseInt(event.target.value, 10) || 1)}
            className={`${FIELD_CLASS} w-24`}
          />
        </FilterField>
      )}

      {reportAcceptsField(reportType, "batchId") &&
        textField("batchId", "Collector batch id", "Paste the batch id from the batch screen")}
      {reportAcceptsField(reportType, "serviceAccountId") &&
        textField(
          "serviceAccountId",
          "Service account id",
          "Paste the account id from the ledger screen"
        )}

      {reportAcceptsField(reportType, "collectorId") &&
        accountFilter(
          "collectorId",
          "Collector",
          collectors.map((collector) => ({ id: collector.id, name: collector.fullName }))
        )}

      {reportAcceptsField(reportType, "areaId") &&
        textField("areaId", "Area id", "Paste the collection area id")}

      {reportAcceptsField(reportType, "planId") &&
        accountFilter(
          "planId",
          "Plan",
          plans.map((plan) => ({ id: plan.id, name: plan.name }))
        )}

      {reportAcceptsField(reportType, "serviceType") && (
        <FilterField label="Service type">
          <select
            value={parameters.serviceType}
            onChange={(event) =>
              onChange("serviceType", event.target.value as ServiceType | "")
            }
            className={`${FIELD_CLASS} w-40`}
          >
            <option value="">All service types</option>
            {SERVICE_TYPES.map((serviceType) => (
              <option key={serviceType} value={serviceType}>
                {SERVICE_TYPE_LABELS[serviceType]}
              </option>
            ))}
          </select>
        </FilterField>
      )}

      {reportAcceptsField(reportType, "serviceStatus") && (
        <FilterField label="Account status">
          <select
            value={parameters.serviceStatus}
            onChange={(event) =>
              onChange("serviceStatus", event.target.value as ServiceAccountStatus | "")
            }
            className={`${FIELD_CLASS} w-44`}
          >
            <option value="">All statuses</option>
            {SERVICE_ACCOUNT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {SERVICE_ACCOUNT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </FilterField>
      )}

      {reportAcceptsField(reportType, "performedBy") &&
        textField("performedBy", "Performed by (user id)", "Paste the user id")}
      {reportAcceptsField(reportType, "action") && textField("action", "Action", "e.g. payment.posted")}
      {reportAcceptsField(reportType, "entityType") &&
        textField("entityType", "Entity type", "e.g. payment")}
    </div>
  );
}

/**
 * The Reports Center: pick a report, set its parameters, generate it on screen,
 * then export it or print it.
 *
 * The sidebar lists every report in the shared catalogue the role may view — the
 * six original families plus the twelve added since (S6-1, S6-5). The export
 * buttons are hidden from a role without `reports:export`, and the two audit
 * reports additionally need `audit:read` to leave the building (S6-5). The server
 * enforces the same boundaries per route — the hidden entry is only a convenience.
 */
export function ReportsCenterPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const canExportReports = user !== null && roleHasPermission(user.role, "reports:export");
  const canReadAudit = user !== null && roleHasPermission(user.role, "audit:read");

  /** A report whose export reads the audit trail needs `audit:read` as well. */
  function canExportReportType(reportType: AnyReportType): boolean {
    return canExportReports && (!reportNeedsAuditRead(reportType) || canReadAudit);
  }

  const visibleReportTypes = ALL_REPORT_TYPES.filter(
    (type) => user !== null && roleHasPermission(user.role, REPORT_TYPE_VIEW_PERMISSIONS[type])
  );

  const [reportType, setReportType] = useState<AnyReportType>("daily_collection");
  const [parameters, setParameters] = useState<ReportParameters>(initialParameters);
  const [table, setTable] = useState<DisplayTable | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [collectors, setCollectors] = useState<{ id: string; fullName: string }[]>([]);
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);

  function updateParameter<Key extends keyof ReportParameters>(
    key: Key,
    value: ReportParameters[Key]
  ): void {
    setParameters((current) => ({ ...current, [key]: value }));
  }

  const generate = useCallback(async (): Promise<void> => {
    setIsGenerating(true);
    setErrorMessage(null);
    setExportNotice(null);
    try {
      setTable(await loadReportTable(reportType, parameters));
    } catch (error) {
      setTable(null);
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  }, [reportType, parameters]);

  // Generate once when the screen opens so it is never blank.
  useEffect(() => {
    void generate();
    // Only on mount: a later change is applied by the Generate button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The collector and plan filters offer a pick-list. Both loads are best effort:
  // a role that cannot read the list simply types no collector or plan filter, and
  // a failure here must never block the report itself.
  useEffect(() => {
    async function loadFilterOptions(): Promise<void> {
      try {
        const assignable = await listAssignableCollectors();
        setCollectors(assignable.map((collector) => ({ id: collector.id, fullName: collector.fullName })));
      } catch {
        setCollectors([]);
      }

      try {
        const loadedPlans = await listPlans();
        setPlans(loadedPlans.map((plan) => ({ id: plan.id, name: plan.name })));
      } catch {
        setPlans([]);
      }
    }

    void loadFilterOptions();
  }, []);

  async function exportReport(format: "pdf" | "xlsx"): Promise<void> {
    setIsExporting(true);
    setErrorMessage(null);
    setExportNotice(null);
    try {
      const request = { reportType, params: buildReportRequest(reportType, parameters) };
      const downloaded =
        format === "pdf" ? await exportReportPdf(request) : await exportReportXlsx(request);

      const blob = new Blob([downloaded.bytes], {
        type:
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloaded.fileName;
      anchor.click();
      URL.revokeObjectURL(url);

      // S6-6: never let a capped file pass for the whole report.
      if (downloaded.isTruncated) {
        const rendered = downloaded.rowLimit?.toLocaleString("en-PH") ?? "the cap";
        const total = downloaded.totalRows?.toLocaleString("en-PH") ?? "more";
        setExportNotice(
          `Export truncated — the file holds the first ${rendered} of ${total} rows. Narrow the filters and export again.`
        );
      }
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  /** Opens the report in Electron's print-preview window, or the browser's printer. */
  function openPrintPreview(): void {
    if (table === null) {
      return;
    }

    if (window.electronAPI?.openPrintPreview !== undefined) {
      // A failed preview window would otherwise be invisible: surface the reason.
      void window.electronAPI.openPrintPreview(buildPrintableHtml(table)).catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Could not open the print preview.");
      });
      return;
    }

    // A plain browser (vite dev) has no Electron bridge; use its own print dialog.
    window.print();
  }

  const canGenerate = parametersAreComplete(reportType, parameters);

  return (
    <AppShell
      pageTitle="Reports Center"
      pageDescription="Pick a report, set its parameters, then view, export, or print it"
    >
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav className="space-y-1 self-start rounded-xl border border-line/80 bg-surface p-2 shadow-xs print:hidden">
          {visibleReportTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setReportType(type)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                type === reportType
                  ? "bg-accent text-surface"
                  : "text-content-primary hover:bg-canvas"
              }`}
            >
              {REPORT_TYPE_LABELS[type]}
            </button>
          ))}
        </nav>

        <div className="space-y-6">
          <Card className="print:hidden">
            <CardContent className="space-y-4">
              <p className="text-sm text-content-secondary">{REPORT_TYPE_DESCRIPTIONS[reportType]}</p>

              <ReportFilterEditor
                reportType={reportType}
                parameters={parameters}
                onChange={updateParameter}
                collectors={collectors}
                plans={plans}
              />

              <div className="flex flex-wrap items-end gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void generate()}
                  disabled={!canGenerate}
                  isLoading={isGenerating}
                >
                  Generate
                </Button>

                {canExportReportType(reportType) && (
                  <>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => void exportReport("pdf")}
                      disabled={!canGenerate}
                      isLoading={isExporting}
                    >
                      Export PDF
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void exportReport("xlsx")}
                      disabled={!canGenerate}
                      isLoading={isExporting}
                    >
                      Export XLSX
                    </Button>
                  </>
                )}

                <Button
                  type="button"
                  variant="outline"
                  onClick={openPrintPreview}
                  disabled={table === null}
                >
                  Print preview
                </Button>
              </div>

              {!canGenerate && (
                <p className="text-xs text-content-secondary">
                  This report needs an identifier before it can be generated.
                </p>
              )}
              {canExportReports && !canExportReportType(reportType) && (
                <p className="text-xs text-content-secondary">
                  The audit reports also need the audit-trail permission before they can be exported.
                </p>
              )}
              {!canExportReports && (
                <p className="text-xs text-content-secondary">
                  Your role may view reports but not export them.
                </p>
              )}

              {exportNotice !== null && <ReportNotice message={exportNotice} />}
            </CardContent>
          </Card>

          {errorMessage !== null && (
            <ErrorBanner message={errorMessage} onRetry={() => void generate()} />
          )}

          {isGenerating ? (
            <Card>
              <TableSkeleton rows={6} columns={6} />
            </Card>
          ) : (
            table !== null && <ReportTableView table={table} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The report as a stand-alone HTML document for the print-preview window.
 *
 * The Electron main process prints this content with the OS print dialog, so the
 * preview and the printed page are the same document.
 */
function buildPrintableHtml(table: DisplayTable): string {
  const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const headerCells = table.columns
    .map(
      (column) =>
        `<th style="text-align:${column.align}; border-bottom:1px solid #000; padding:4px 8px;">${escapeHtml(column.header)}</th>`
    )
    .join("");

  const bodyRows = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, index) =>
              `<td style="text-align:${table.columns[index]?.align ?? "left"}; padding:4px 8px;">${escapeHtml(cell)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  const totalsRows = table.totalsRows
    .map(
      (row) =>
        `<tr style="font-weight:bold;">${row
          .map(
            (cell, index) =>
              `<td style="text-align:${table.columns[index]?.align ?? "left"}; padding:4px 8px; border-top:1px solid #000;">${escapeHtml(cell)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  const notice =
    table.notice === undefined
      ? ""
      : `<p style="margin: 4px 0; font-weight: bold;">${escapeHtml(table.notice)}</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(table.title)}</title></head>
<body style="font-family: sans-serif; font-size: 12px; padding: 16px;">
  <h1 style="font-size: 18px; margin: 0;">${escapeHtml(table.title)}</h1>
  <p style="margin: 4px 0 16px; color: #000;">${escapeHtml(table.subtitle)}</p>
  ${notice}
  <table style="border-collapse: collapse; width: 100%;">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>${totalsRows}</tfoot>
  </table>
</body></html>`;
}
