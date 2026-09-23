// Human-readable account numbers that are also sortable by date.
//
//   Subscriber      → SUB-20250124-00042
//   Service account → SA-20250124-00042
//
// The date segment makes a printed number meaningful to a clerk, and the padded
// sequence keeps numbers the same length so they sort correctly as text.

/** The YYYYMMDD segment used inside an account number. */
export function formatDateSegment(today: Date): string {
  return today.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Builds a subscriber account number: SUB-YYYYMMDD-XXXXX. */
export function generateSubscriberAccountNumber(today: Date, sequenceNumber: number): string {
  const dateSegment = formatDateSegment(today);
  const sequenceSegment = String(sequenceNumber).padStart(5, "0");
  return `SUB-${dateSegment}-${sequenceSegment}`;
}

/** Builds a service account number: SA-YYYYMMDD-XXXXX. */
export function generateServiceAccountNumber(today: Date, sequenceNumber: number): string {
  const dateSegment = formatDateSegment(today);
  const sequenceSegment = String(sequenceNumber).padStart(5, "0");
  return `SA-${dateSegment}-${sequenceSegment}`;
}

/**
 * Picks the next sequence number for a day's account numbers.
 *
 * Existing numbers for the same day are inspected and the highest one wins.
 * Anything that does not start with the expected prefix — or whose tail is not a
 * number — is ignored, so a manually imported account number can never break
 * generation for the rest of the day.
 */
export function nextSequenceNumber(
  existingAccountNumbers: readonly string[],
  accountNumberPrefix: string
): number {
  let highestSequence = 0;

  for (const accountNumber of existingAccountNumbers) {
    if (!accountNumber.startsWith(accountNumberPrefix)) {
      continue;
    }

    const sequencePart = accountNumber.slice(accountNumberPrefix.length);
    const parsedSequence = Number.parseInt(sequencePart, 10);

    if (Number.isInteger(parsedSequence) && parsedSequence > highestSequence) {
      highestSequence = parsedSequence;
    }
  }

  return highestSequence + 1;
}
