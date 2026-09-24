// Unit tests for the GCash screenshot upload rules.
//
// The spec is explicit: only JPEG, PNG, or WebP, and never more than 5 MB. These
// tests are pure, so they prove the rules without writing a file to disk.

import { describe, expect, it } from "vitest";

import {
  GCASH_SCREENSHOT_MAX_BYTES,
} from "@bcis/shared";
import {
  detectImageMimeType,
  isValidImageMagicBytes,
  validateGcashScreenshot,
} from "../src/modules/payments/gcash-screenshot.service";

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

describe("GCash screenshot magic bytes", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const WEBP = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x20, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
    Buffer.alloc(8),
  ]);
  // An executable renamed to .jpg: the MZ header is not any image signature.
  const FAKE_JPEG = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(32)]);

  it("detects the real format from the bytes", () => {
    expect(detectImageMimeType(JPEG)).toBe("image/jpeg");
    expect(detectImageMimeType(PNG)).toBe("image/png");
    expect(detectImageMimeType(WEBP)).toBe("image/webp");
  });

  it("rejects a renamed non-image", () => {
    expect(detectImageMimeType(FAKE_JPEG)).toBeNull();
    expect(isValidImageMagicBytes(FAKE_JPEG)).toBe(false);
  });

  it("accepts a real image and rejects a truncated or empty buffer", () => {
    expect(isValidImageMagicBytes(PNG)).toBe(true);
    expect(isValidImageMagicBytes(Buffer.from([0x89, 0x50]))).toBe(false);
    expect(isValidImageMagicBytes(Buffer.alloc(0))).toBe(false);
  });
});
