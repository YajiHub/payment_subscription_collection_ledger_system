import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  extractApiErrorMessage,
  getServiceAccountStatement,
  type ServiceAccountStatement,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";

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

  if (isLoading && statement === null) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-slate-500">Loading statement…</p>
      </main>
    );
  }

  if (statement === null) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-8">
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage ?? "Statement not found."}
        </p>
        <Link to="/subscribers" className="text-sm font-medium text-slate-700 underline">
          Back to subscribers
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="space-y-1 text-sm">
          <span className="block text-slate-600">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-slate-600">To</span>
          <input
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={printStatement}
          className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white"
        >
          Print / Export PDF
        </button>
        <Link
          to={`/service-accounts/${statement.serviceAccount.id}/ledger`}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Back to ledger
        </Link>
      </div>

      <article className="space-y-6 rounded-lg border border-slate-300 bg-white p-8 shadow-sm">
        <header className="border-b border-slate-200 pb-4 text-center">
          <h1 className="text-xl font-semibold">{COMPANY.name}</h1>
          <p className="text-sm text-slate-600">{COMPANY.address}</p>
          <p className="text-xs text-slate-500">{COMPANY.tagline}</p>
          <p className="mt-3 text-sm font-semibold uppercase tracking-wide">Statement of Account</p>
        </header>

        <section className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-slate-600">Subscriber</p>
            <p>
              {statement.subscriber.lastName}, {statement.subscriber.firstName}
              {statement.subscriber.middleName === null
                ? ""
                : ` ${statement.subscriber.middleName.charAt(0)}.`}
            </p>
          </div>
          <div>
            <p className="text-slate-600">Account number</p>
            <p className="font-mono">{statement.subscriber.accountNumber}</p>
          </div>
          <div>
            <p className="text-slate-600">Service account</p>
            <p className="font-mono">{statement.serviceAccount.serviceAccountNumber}</p>
          </div>
          <div>
            <p className="text-slate-600">Plan</p>
            <p>{statement.serviceAccount.planName}</p>
          </div>
          <div className="col-span-2">
            <p className="text-slate-600">Address</p>
            <p>
              {statement.subscriber.serviceAddress}, {statement.subscriber.serviceBarangay},{" "}
              {statement.subscriber.serviceMunicipality}, {statement.subscriber.serviceProvince}
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-slate-600">Statement period</p>
            <p>{periodLabel(statement)}</p>
          </div>
        </section>

        <section className="space-y-2">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Debit</th>
                <th className="px-3 py-2 text-right font-medium">Credit</th>
                <th className="px-3 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-100 bg-slate-50/50">
                <td className="px-3 py-2 text-slate-600" colSpan={4}>
                  Opening balance
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatCentavos(statement.openingBalanceCentavos)}
                </td>
              </tr>
              {statement.lines.map((line) => (
                <tr key={line.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 whitespace-nowrap">{line.date}</td>
                  <td className="px-3 py-2">
                    {line.description}
                    {line.referenceNumber === "" ? "" : ` (${line.referenceNumber})`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {line.debitCentavos > 0 ? formatCentavos(line.debitCentavos) : ""}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {line.creditCentavos > 0 ? formatCentavos(line.creditCentavos) : ""}
                  </td>
                  <td className="px-3 py-2 text-right">{formatCentavos(line.balanceCentavos)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-slate-300 bg-slate-50">
              <tr>
                <td className="px-3 py-2 font-semibold" colSpan={2}>
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-semibold">
                  {formatCentavos(statement.totalDebitsCentavos)}
                </td>
                <td className="px-3 py-2 text-right font-semibold">
                  {formatCentavos(statement.totalCreditsCentavos)}
                </td>
                <td className="px-3 py-2 text-right font-semibold">
                  {formatCentavos(statement.closingBalanceCentavos)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        <footer className="space-y-1 border-t border-slate-200 pt-4 text-sm">
          <p>
            Closing balance:{" "}
            <span className="font-semibold">
              {formatCentavos(statement.closingBalanceCentavos)}
            </span>
          </p>
          <p className="text-xs text-slate-600">
            As of {statement.asOfDate}. Certified true and correct — computed from the subscriber
            ledger (opening {formatCentavos(statement.openingBalanceCentavos)} + debits{" "}
            {formatCentavos(statement.totalDebitsCentavos)} − credits{" "}
            {formatCentavos(statement.totalCreditsCentavos)}).
          </p>
        </footer>
      </article>
    </main>
  );
}
