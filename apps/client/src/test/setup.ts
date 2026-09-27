// Shared test setup for every renderer test.
//
// `@testing-library/jest-dom/vitest` registers the DOM matchers (toBeInTheDocument,
// toHaveFocus, ...) on Vitest's `expect` and augments its types through this import.
// Cleanup is wired explicitly rather than relying on Vitest globals, so tests
// import `describe`/`it`/`expect` from "vitest" themselves.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});