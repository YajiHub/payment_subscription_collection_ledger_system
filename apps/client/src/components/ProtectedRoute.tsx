// Wraps any page that requires authentication or a specific permission.
// This is a UX guard — the server also enforces permissions independently,
// so a missing button here never becomes a security hole.

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { roleHasPermission, type Permission } from "@bcis/shared";
import { useAuthStore } from "../stores/auth.store";

interface ProtectedRouteProps {
  children: ReactNode;
  /**
   * The permission this screen needs. An array means "any of these", for a screen
   * reached by two different jobs — a restore is administrative, viewing the backup
   * history is a read, and someone may hold one without the other.
   */
  requiredPermission?: Permission | readonly Permission[];
}

export function ProtectedRoute({ children, requiredPermission }: ProtectedRouteProps): ReactNode {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredPermission !== undefined && user !== null) {
    const requiredPermissions: readonly Permission[] =
      typeof requiredPermission === "string" ? [requiredPermission] : requiredPermission;

    if (!requiredPermissions.some((permission) => roleHasPermission(user.role, permission))) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  return <>{children}</>;
}
