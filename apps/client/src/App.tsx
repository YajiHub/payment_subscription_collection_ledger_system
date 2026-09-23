import type { ReactNode } from "react";

import { HomePage } from "./pages/HomePage";

/**
 * Application shell for Phase 1.
 * There is a single screen: it confirms the desktop client can reach the API server.
 */
export function App(): ReactNode {
  return <HomePage />;
}