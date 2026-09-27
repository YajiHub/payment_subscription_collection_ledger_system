import type { ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./components/ProtectedRoute";
import { SessionLockGate } from "./components/session/SessionLockGate";
import { AddSubscriberPage } from "./pages/AddSubscriberPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { BackupManagementPage } from "./pages/BackupManagementPage";
import { BillingDashboardPage } from "./pages/BillingDashboardPage";
import { CollectorBatchDetailPage } from "./pages/CollectorBatchDetailPage";
import { CollectorBatchListPage } from "./pages/CollectorBatchListPage";
import { CollectorBatchRouteSheetPage } from "./pages/CollectorBatchRouteSheetPage";
import { DashboardPage } from "./pages/DashboardPage";
import { GcashVerificationPage } from "./pages/GcashVerificationPage";
import { HomePage } from "./pages/HomePage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { InvoiceListPage } from "./pages/InvoiceListPage";
import { LoginPage } from "./pages/LoginPage";
import { PaymentDetailPage } from "./pages/PaymentDetailPage";
import { PaymentHistoryPage } from "./pages/PaymentHistoryPage";
import { PlanManagementPage } from "./pages/PlanManagementPage";
import { PostPaymentPage } from "./pages/PostPaymentPage";
import { ReceivablesAgingPage } from "./pages/ReceivablesAgingPage";
import { ReportsCenterPage } from "./pages/ReportsCenterPage";
import { OverdueAccountsPage } from "./pages/OverdueAccountsPage";
import { ReceiptPreviewPage } from "./pages/ReceiptPreviewPage";
import { ServiceAccountLedgerPage } from "./pages/ServiceAccountLedgerPage";
import { ServiceAccountsPage } from "./pages/ServiceAccountsPage";
import { StatementOfAccountPage } from "./pages/StatementOfAccountPage";
import { SuspensionOperationsPage } from "./pages/SuspensionOperationsPage";
import { SubscriberDetailPage } from "./pages/SubscriberDetailPage";
import { SubscriberListPage } from "./pages/SubscriberListPage";
import { SystemSettingsPage } from "./pages/SystemSettingsPage";
import { UnauthorizedPage } from "./pages/UnauthorizedPage";
import { UserManagementPage } from "./pages/UserManagementPage";

/**
 * Application shell.
 * HashRouter is used because the packaged app loads the renderer from a file://
 * URL, where path-based routing does not work.
 *
 * The whole route table sits inside the session-lock gate (S5-4): when the
 * workstation is idle-locked or deliberately locked, the gate renders the lock
 * screen INSTEAD of these routes, so no page, table or form is mounted, nothing
 * behind the lock can be read off the screen, and no screen keeps polling the API.
 * Unlocking re-mounts the router, and the location it was on is still there.
 */
export function App(): ReactNode {
  return (
    <HashRouter>
      <SessionLockGate>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/unauthorized" element={<UnauthorizedPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HomePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedRoute requiredPermission="users:read">
                <UserManagementPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/audit-logs"
            element={
              <ProtectedRoute requiredPermission="audit:read">
                <AuditLogPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute requiredPermission="system:settings">
                <SystemSettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/administration/backups"
            element={
              <ProtectedRoute requiredPermission={["backup:create", "backup:restore"]}>
                <BackupManagementPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/subscribers"
            element={
              <ProtectedRoute requiredPermission="subscribers:read">
                <SubscriberListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/subscribers/new"
            element={
              <ProtectedRoute requiredPermission="subscribers:create">
                <AddSubscriberPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/subscribers/:id"
            element={
              <ProtectedRoute requiredPermission="subscribers:read">
                <SubscriberDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/plans"
            element={
              <ProtectedRoute requiredPermission="plans:read">
                <PlanManagementPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/service-accounts/:id/ledger"
            element={
              <ProtectedRoute requiredPermission="ledger:read">
                <ServiceAccountLedgerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/service-accounts/:id/statement"
            element={
              <ProtectedRoute requiredPermission="ledger:read">
                <StatementOfAccountPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/billing"
            element={
              <ProtectedRoute requiredPermission="invoices:read">
                <BillingDashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/invoices"
            element={
              <ProtectedRoute requiredPermission="invoices:read">
                <InvoiceListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/invoices/:id"
            element={
              <ProtectedRoute requiredPermission="invoices:read">
                <InvoiceDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments/new"
            element={
              <ProtectedRoute requiredPermission="payments:post">
                <PostPaymentPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments"
            element={
              <ProtectedRoute requiredPermission="payments:read">
                <PaymentHistoryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments/gcash"
            element={
              <ProtectedRoute requiredPermission="payments:verify_gcash">
                <GcashVerificationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments/:id"
            element={
              <ProtectedRoute requiredPermission="payments:read">
                <PaymentDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/payments/:id/receipt"
            element={
              <ProtectedRoute requiredPermission="receipts:print">
                <ReceiptPreviewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/collector-batches"
            element={
              <ProtectedRoute requiredPermission="collector_batches:read">
                <CollectorBatchListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/collector-batches/:id"
            element={
              <ProtectedRoute requiredPermission="collector_batches:read">
                <CollectorBatchDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/collector-batches/:id/route-sheet"
            element={
              <ProtectedRoute requiredPermission="collector_batches:read">
                <CollectorBatchRouteSheetPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/services/accounts"
            element={
              <ProtectedRoute requiredPermission="subscribers:read">
                <ServiceAccountsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/services/suspension"
            element={
              <ProtectedRoute requiredPermission="subscribers:read">
                <SuspensionOperationsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/receivables/aging"
            element={
              <ProtectedRoute requiredPermission="reports:view">
                <ReceivablesAgingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/receivables/overdue"
            element={
              <ProtectedRoute requiredPermission="reports:view">
                <OverdueAccountsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute requiredPermission="reports:management_view">
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute requiredPermission="reports:view">
                <ReportsCenterPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionLockGate>
    </HashRouter>
  );
}
