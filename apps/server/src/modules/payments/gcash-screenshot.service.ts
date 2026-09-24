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

/** True when the buffer starts with the given bytes. */
function startsWithBytes(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.byteLength < signature.length) {
    return false;
  }
  return signature.every((byte, index) => buffer[index] === byte);
}

// The magic bytes (file signatures) of the accepted image formats. Checking them
// is what stops a file renamed from .exe to .jpg from being accepted: the name
// and the declared content type are both attacker-controlled, the bytes are not.
const JPEG_MAGIC_BYTES = [0xff, 0xd8, 0xff] as const;
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_MAGIC_BYTES = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_MAGIC_BYTES = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" at offset 8

/**
 * The image format a buffer's magic bytes really are, or null when the bytes are
 * not a supported image at all.
 *
 * Pure: takes bytes, answers with a MIME type. No disk, no database.
 */
export function detectImageMimeType(buffer: Buffer): GcashScreenshotMimeType | null {
  if (startsWithBytes(buffer, JPEG_MAGIC_BYTES)) {
    return "image/jpeg";
  }

  if (startsWithBytes(buffer, PNG_MAGIC_BYTES)) {
    return "image/png";
  }

  // A WebP file is a RIFF container whose form type at offset 8 is "WEBP".
  if (
    startsWithBytes(buffer, RIFF_MAGIC_BYTES) &&
    buffer.byteLength >= 12 &&
    startsWithBytes(buffer.subarray(8), WEBP_MAGIC_BYTES)
  ) {
    return "image/webp";
  }

  return null;
}

/** True when the bytes look like one of the accepted image formats. */
export function isValidImageMagicBytes(buffer: Buffer): boolean {
  return detectImageMimeType(buffer) !== null;
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

  // The declared content type is client-supplied. The bytes are not, so the file
  // must actually BE the format it claims to be.
  const detectedMimeType = detectImageMimeType(bytes);
  if (detectedMimeType === null || detectedMimeType !== input.contentType) {
    throw new ValidationError("File content does not match a valid image format");
  }

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
