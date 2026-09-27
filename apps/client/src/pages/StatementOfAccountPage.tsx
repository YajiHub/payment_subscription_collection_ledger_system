import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  extractApiErrorMessage,
  getServiceAccountStatement,
  type ServiceAccountStatement,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

/** The ISP's printable letterhead, shared with the receipt. */
const COMPANY = {
  name: "BCIS Internet Services",
  address: "Poblacion, Philippines",
  tagline: "Subscription Billing and Collection System",
};

/** A printable statement period, e.g. "01/01/2025 – 31/01/2025", or "To date". */
function periodLabel(statement: ServiceAccountStatement): string {
  if (statement.periodFrom === null && statement.periodTo === null) {
    return "From the beginning of the account";
  }
  const from = statement.periodFrom === null ? "the beginning" : statement.periodFrom;
  const to = statement.periodTo === null ? statement.asOfDate : statement.periodTo;
  return `${from} to ${to}`;
}

/**
 * Statement of Account, ready to print or export to PDF.
 *
 * The totals row is the reconciliation the ledger guarantees:
 * opening + total debits − total credits = closing balance.
 */
export function StatementOfAccountPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const [statement, setStatement] = useState<ServiceAccountStatement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const loadStatement = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setStatement(
        await getServiceAccountStatement(id, {
          fromDate: fromDate === "" ? undefined : fromDate,
          toDate: toDate === "" ? undefined : toDate,
        })
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id, fromDate, toDate]);

  useEffect(() => {
    void loadStatement();
  }, [loadStatement]);

  function printStatement(): void {
    if (window.electronAPI !== undefined) {
      void window.electronAPI.printCurrentWindow();
    } else {
      window.print();
    }
  }

  const fieldClass =
    "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <AppShell
      pageTitle="Statement of Account"
      pageDescription={statement === null ? "Loading the statement" : statement.subscriber.lastName}
      headerActions={
        <div className="flex items-end gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">From</span>
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">To</span>
            <input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className={fieldClass}
            />
          </label>
          <Button size="md" onClick={printStatement}>
            Print / Export PDF
          </Button>
          {statement !== null && (
            <Link
              to={`/service-accounts/${statement.serviceAccount.id}/ledger`}
              className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
            >
              Back to ledger
            </Link>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {isLoading && statement === null ? (
          <Card>
            <TableSkeleton rows={8} columns={5} />
          </Card>
        ) : statement === null ? (
          <>
            <ErrorBanner
              message={errorMessage ?? "Statement not found."}
              onRetry={() => void loadStatement()}
            />
            <Link to="/subscribers" className="inline-block text-sm font-medium text-content-primary underline">
              Back to subscribers
            </Link>
          </>
        ) : (
          <article className="mx-auto max-w-3xl space-y-6 rounded-xl border border-line-strong bg-surface p-8 shadow-xs">
            <header className="border-b border-line pb-4 text-center">
              <h1 className="text-xl font-semibold text-content-primary">{COMPANY.name}</h1>
              <p className="text-sm text-content-secondary">{COMPANY.address}</p>
              <p className="text-xs text-content-secondary">{COMPANY.tagline}</p>
              <p className="mt-3 text-sm font-semibold uppercase tracking-wide">
                Statement of Account
              </p>
            </header>

            <section className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-content-secondary">Subscriber</p>
                <p className="text-content-primary">
                  {statement.subscriber.lastName}, {statement.subscriber.firstName}
                  {statement.subscriber.middleName === null
                    ? ""
                    : ` ${statement.subscriber.middleName.charAt(0)}.`}
                </p>
              </div>
              <div>
                <p className="text-content-secondary">Account number</p>
                <p className="font-mono text-content-primary">{statement.subscriber.accountNumber}</p>
              </div>
              <div>
                <p className="text-content-secondary">Service account</p>
                <p className="font-mono text-content-primary">{statement.serviceAccount.serviceAccountNumber}</p>
              </div>
              <div>
                <p className="text-content-secondary">Plan</p>
                <p className="text-content-primary">{statement.serviceAccount.planName}</p>
              </div>
              <div className="col-span-2">
                <p className="text-content-secondary">Address</p>
                <p className="text-content-primary">
                  {statement.subscriber.serviceAddress}, {statement.subscriber.serviceBarangay},{" "}
                  {statement.subscriber.serviceMunicipality}, {statement.subscriber.serviceProvince}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-content-secondary">Statement period</p>
                <p className="text-content-primary">{periodLabel(statement)}</p>
              </div>
            </section>

            <section className="space-y-2">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-canvas text-content-secondary">
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Debit</th>
                      <th className="px-3 py-2 text-right font-medium">Credit</th>
                      <th className="px-3 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-line bg-canvas/50">
                      <td className="px-3 py-2 text-content-secondary" colSpan={4}>
                        Opening balance
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCentavos(statement.openingBalanceCentavos)}
                      </td>
                    </tr>
                    {statement.lines.map((line) => (
                      <tr key={line.id} className="border-t border-line">
                        <td className="whitespace-nowrap px-3 py-2 text-content-primary">{line.date}</td>
                        <td className="px-3 py-2 text-content-primary">
                          {line.description}
                          {line.referenceNumber === "" ? "" : ` (${line.referenceNumber})`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {line.debitCentavos > 0 ? formatCentavos(line.debitCentavos) : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {line.creditCentavos > 0 ? formatCentavos(line.creditCentavos) : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCentavos(line.balanceCentavos)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-line-strong bg-canvas">
                    <tr>
                      <td className="px-3 py-2 font-semibold" colSpan={2}>
                        Totals
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {formatCentavos(statement.totalDebitsCentavos)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {formatCentavos(statement.totalCreditsCentavos)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {formatCentavos(statement.closingBalanceCentavos)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            <footer className="space-y-1 border-t border-line pt-4 text-sm">
              <p>
                Closing balance:{" "}
                <span className="font-semibold tabular-nums">
                  {formatCentavos(statement.closingBalanceCentavos)}
                </span>
              </p>
              <p className="text-xs text-content-secondary tabular-nums">
                As of {statement.asOfDate}. Certified true and correct — computed from the subscriber
                ledger (opening {formatCentavos(statement.openingBalanceCentavos)} + debits{" "}
                {formatCentavos(statement.totalDebitsCentavos)} − credits{" "}
                {formatCentavos(statement.totalCreditsCentavos)}).
              </p>
            </footer>
          </article>
        )}
      </div>
    </AppShell>
  );
}