import type { ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { ProtectedRoute } from "./components/ProtectedRoute";
import { AddSubscriberPage } from "./pages/AddSubscriberPage";
import { BillingDashboardPage } from "./pages/BillingDashboardPage";
import { HomePage } from "./pages/HomePage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { InvoiceListPage } from "./pages/InvoiceListPage";
import { LoginPage } from "./pages/LoginPage";
import { PlanManagementPage } from "./pages/PlanManagementPage";
import { SubscriberDetailPage } from "./pages/SubscriberDetailPage";
import { SubscriberListPage } from "./pages/SubscriberListPage";
import { UnauthorizedPage } from "./pages/UnauthorizedPage";
import { UserManagementPage } from "./pages/UserManagementPage";

/**
 * Application shell.
 * HashRouter is used because the packaged app loads the renderer from a file://
 * URL, where path-based routing does not work.
 */
export function App(): ReactNode {
  return (
    <HashRouter>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
