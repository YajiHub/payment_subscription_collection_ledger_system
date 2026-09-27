// GCash reference numbers (S12-7).
//
// A reference number is the only thing that ties a payment claim to one transfer
// in the GCash app, so duplicate detection is what stops the same transfer being
// cashed in twice. Comparing the raw text is not enough: a teller who types
// "  0031 234 567 " and one who types "0031234567" have entered the same
// reference, and a case difference is just as easy to introduce by hand.
//
// Normalizing ONCE, at the boundary, means:
//   • the value stored on `gcash_payments.gcash_reference_number` is already
//     normalized, so the unique constraint and every future lookup compare like
//     with like;
//   • `assertGcashReferenceIsUnused` cannot be walked around by reformatting.
//
// The rules are deliberately small and readable: trim the ends, remove every
// whitespace character inside, and uppercase. Nothing else is changed, because a
// reference may legitimately contain digits, letters and hyphens.

/** How a raw reference from a form, a receipt or a phone call is stored. */
export function normalizeGcashReference(referenceNumber: string): string {
  return referenceNumber.replace(/\s+/g, "").toUpperCase();
}

/** Whether two references name the same transfer, whatever their formatting. */
export function gcashReferencesMatch(left: string, right: string): boolean {
  return normalizeGcashReference(left) === normalizeGcashReference(right);
}
