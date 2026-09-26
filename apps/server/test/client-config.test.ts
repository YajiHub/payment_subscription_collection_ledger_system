// The client's API address is chosen from an untrusted JSON file that an office
// administrator edits by hand. Only a real http(s) URL may be used; anything else
// must fall back to the URL compiled into the bundle.

import { describe, expect, it } from "vitest";

import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from "@bcis/shared";

const FALLBACK = "http://localhost:3003";

describe("resolveApiBaseUrl", () => {
  it("uses a configured LAN address and trims a trailing slash", () => {
    const resolved = resolveApiBaseUrl({ apiBaseUrl: "http://192.168.1.100:3003/" }, FALLBACK);

    expect(resolved).toBe("http://192.168.1.100:3003");
  });

  it("accepts an https address", () => {
    expect(resolveApiBaseUrl({ apiBaseUrl: "https://billing.example" }, FALLBACK)).toBe(
      "https://billing.example"
    );
  });

  it("falls back when the file has no apiBaseUrl", () => {
    expect(resolveApiBaseUrl({}, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when apiBaseUrl is not a string", () => {
    expect(resolveApiBaseUrl({ apiBaseUrl: 3003 }, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the value is empty or only whitespace", () => {
    expect(resolveApiBaseUrl({ apiBaseUrl: "   " }, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for a bare host and port, which is not an absolute URL", () => {
    expect(resolveApiBaseUrl({ apiBaseUrl: "192.168.1.100:3003" }, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for a non-http protocol", () => {
    expect(resolveApiBaseUrl({ apiBaseUrl: "ftp://192.168.1.100" }, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the file contents are not an object", () => {
    expect(resolveApiBaseUrl(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveApiBaseUrl("http://192.168.1.100:3003", FALLBACK)).toBe(FALLBACK);
  });

  it("documents the compiled-in default", () => {
    expect(DEFAULT_API_BASE_URL).toBe(FALLBACK);
  });
});