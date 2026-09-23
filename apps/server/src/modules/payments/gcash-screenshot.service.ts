// Storing and serving GCash proof screenshots.
//
// The renderer picks a file with the native dialog and posts its bytes here. The
// server never trusts the client's file name: it validates the declared image
// type and the decoded size, then writes the bytes under a generated name inside
// the uploads directory. The name that reaches the database is server-built, so a
// client can never steer a write outside `uploads/`.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GCASH_SCREENSHOT_MAX_BYTES,
  GCASH_SCREENSHOT_MIME_TYPES,
  type GcashScreenshotMimeType,
} from "@bcis/shared";
import { config } from "../../config";
import { NotFoundError, ValidationError } from "../../shared/errors";

/** The file extension that belongs to each accepted image type. */
const EXTENSION_BY_MIME_TYPE: Record<GcashScreenshotMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The content type that belongs to each stored file extension. */
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Rejects anything that is not a JPEG, PNG, or WebP no larger than 5 MB.
 *
 * Pure, so the spec's upload rules can be tested without touching the disk.
 */
export function validateGcashScreenshot(contentType: string, sizeBytes: number): void {
  if (!(GCASH_SCREENSHOT_MIME_TYPES as readonly string[]).includes(contentType)) {
    throw new ValidationError("Only JPEG, PNG, or WebP screenshots are accepted");
  }

  if (sizeBytes > GCASH_SCREENSHOT_MAX_BYTES) {
    throw new ValidationError("The screenshot must be 5 MB or smaller");
  }

  if (sizeBytes <= 0) {
    throw new ValidationError("The screenshot file is empty");
  }
}

export interface StoreGcashScreenshotInput {
  contentType: GcashScreenshotMimeType;
  dataBase64: string;
}

/**
 * Writes a screenshot to `uploads/gcash-proofs/YYYY/MM/` and returns the path
 * stored on the payment (relative to the uploads directory).
 */
export async function storeGcashScreenshot(
  input: StoreGcashScreenshotInput
): Promise<{ filePath: string; sizeBytes: number }> {
  const bytes = Buffer.from(input.dataBase64, "base64");
  validateGcashScreenshot(input.contentType, bytes.byteLength);

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const extension = EXTENSION_BY_MIME_TYPE[input.contentType];
  const fileName = `gcash-${randomUUID()}-${now.getTime()}.${extension}`;

  const relativePath = path.join("gcash-proofs", year, month, fileName);
  const absolutePath = path.resolve(config.UPLOADS_DIR, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  return { filePath: relativePath, sizeBytes: bytes.byteLength };
}

export interface StoredScreenshot {
  contents: Buffer;
  contentType: string;
}

/**
 * Reads a stored screenshot for the authenticated download route.
 *
 * The resolved path must stay inside the uploads directory, so a malformed row
 * can never be used to read an arbitrary file.
 */
export async function readGcashScreenshot(relativePath: string): Promise<StoredScreenshot> {
  const uploadsRoot = path.resolve(config.UPLOADS_DIR);
  const absolutePath = path.resolve(uploadsRoot, relativePath);

  if (absolutePath !== uploadsRoot && !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new NotFoundError("Screenshot not found");
  }

  const extension = path.extname(absolutePath).slice(1).toLowerCase();
  const contentType = MIME_TYPE_BY_EXTENSION[extension];

  if (contentType === undefined) {
    throw new NotFoundError("Screenshot not found");
  }

  try {
    const contents = await readFile(absolutePath);
    return { contents, contentType };
  } catch {
    throw new NotFoundError("Screenshot file is missing");
  }
}
