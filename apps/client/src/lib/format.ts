// Formatting helpers for the renderer.
//
// Money is an integer number of centavos everywhere. These functions turn that
// integer into text for a human; they never do arithmetic with floating point.

/** Renders integer centavos as Philippine pesos: 99900 → "₱999.00". */
export function formatCentavos(centavos: number): string {
  const isNegative = centavos < 0;
  const absoluteCentavos = Math.abs(centavos);
  const pesos = Math.trunc(absoluteCentavos / 100);
  const cents = absoluteCentavos % 100;
  const sign = isNegative ? "-" : "";
  return `${sign}₱${pesos.toLocaleString("en-PH")}.${String(cents).padStart(2, "0")}`;
}

/**
 * Parses a typed peso amount into integer centavos without ever using floats.
 *
 * "999.50" → 99950, "1000" → 100000. Returns null when the text is not a valid
 * amount with at most two decimal places, so a caller can keep the Post button
 * disabled instead of sending a garbage number.
 */
export function parsePesosToCentavos(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) {
    return null;
  }

  const [pesoPart = "0", centavoPart = ""] = trimmed.split(".");
  const pesos = Number.parseInt(pesoPart, 10);
  const centavos = Number.parseInt(centavoPart.padEnd(2, "0") || "0", 10);

  if (!Number.isInteger(pesos) || !Number.isInteger(centavos)) {
    return null;
  }

  return pesos * 100 + centavos;
}

/** Renders a date-only string (YYYY-MM-DD) for display, or an em dash when absent. */
export function formatDateOnly(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const [year, month, day] = value.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return value;
  }
  return `${day}/${month}/${year}`;
}

/** Renders a byte count as a human-readable size: 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex] ?? "KB";
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

/** Renders an ISO timestamp for display, or an em dash when it is absent. */
export function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "—";
  }
  return new Date(value).toLocaleString("en-PH");
}

/** The subscriber's name as it should appear on screen and on documents. */
export function formatSubscriberName(subscriber: {
  firstName: string;
  middleName: string | null;
  lastName: string;
}): string {
  const middleInitial =
    subscriber.middleName === null ? "" : ` ${subscriber.middleName.charAt(0)}.`;
  return `${subscriber.lastName}, ${subscriber.firstName}${middleInitial}`;
}
