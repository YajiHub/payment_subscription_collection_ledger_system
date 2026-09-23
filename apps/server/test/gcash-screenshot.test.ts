// Unit tests for the GCash screenshot upload rules.
//
// The spec is explicit: only JPEG, PNG, or WebP, and never more than 5 MB. These
// tests are pure, so they prove the rules without writing a file to disk.

import { describe, expect, it } from "vitest";

import {
  GCASH_SCREENSHOT_MAX_BYTES,
} from "@bcis/shared";
import { validateGcashScreenshot } from "../src/modules/payments/gcash-screenshot.service";

describe("GCash screenshot validation", () => {
  it("accepts JPEG, PNG, and WebP within the size limit", () => {
    expect(() => validateGcashScreenshot("image/jpeg", 1024)).not.toThrow();
    expect(() => validateGcashScreenshot("image/png", 1024)).not.toThrow();
    expect(() => validateGcashScreenshot("image/webp", 1024)).not.toThrow();
    expect(() => validateGcashScreenshot("image/png", GCASH_SCREENSHOT_MAX_BYTES)).not.toThrow();
  });

  it("rejects a format that is not an accepted image type", () => {
    expect(() => validateGcashScreenshot("application/pdf", 1024)).toThrow(/JPEG, PNG, or WebP/);
    expect(() => validateGcashScreenshot("image/gif", 1024)).toThrow(/JPEG, PNG, or WebP/);
    expect(() => validateGcashScreenshot("text/plain", 1024)).toThrow(/JPEG, PNG, or WebP/);
  });

  it("rejects a screenshot larger than 5 MB", () => {
    expect(() =>
      validateGcashScreenshot("image/png", GCASH_SCREENSHOT_MAX_BYTES + 1)
    ).toThrow(/5 MB or smaller/);
  });

  it("rejects an empty file", () => {
    expect(() => validateGcashScreenshot("image/png", 0)).toThrow(/empty/);
  });
});
