// Wraps any page that requires authentication or a specific permission.
// This is a UX guard — the server also enforces permissions independently,
// so a missing button here never becomes a security hole.

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { roleHasPermission, type Permission } from "@bcis/shared";
import { useAuthStore } from "../stores/auth.store";

interface ProtectedRouteProps {
  children: ReactNode;
  requiredPermission?: Permission;
}

export function ProtectedRoute({ children, requiredPermission }: ProtectedRouteProps): ReactNode {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredPermission !== undefined && user !== null) {
    if (!roleHasPermission(user.role, requiredPermission)) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  return <>{children}</>;
}
