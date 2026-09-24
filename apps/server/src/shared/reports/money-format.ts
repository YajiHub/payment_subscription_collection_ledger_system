// Turns an integer number of centavos into the text a printed report shows.
//
// The arithmetic is integer-only: pesos are `Math.trunc(centavos / 100)` and the
// centavos are the remainder. A floating-point peso amount is never produced, so
// a report can never print a total that is a centavo away from the database.
//
// The currency is written as "PHP", not the peso sign: the PDF standard fonts
// cannot encode "₱", and a report that renders as a row of fallback boxes is
// worse than one that spells the currency out.

/** Groups thousands with commas: 1234567 → "1,234,567". */
export function formatReportCount(wholeNumber: number): string {
  return wholeNumber.toLocaleString("en-US");
}

/** 123456 → "PHP 1,234.56"; -5000 → "-PHP 50.00"; 0 → "PHP 0.00". */
export function formatReportMoney(centavos: number): string {
  const isNegative = centavos < 0;
  const absoluteCentavos = Math.abs(centavos);
  const pesos = Math.trunc(absoluteCentavos / 100);
  const centavoRemainder = absoluteCentavos % 100;

  return `${isNegative ? "-" : ""}PHP ${formatReportCount(pesos)}.${String(centavoRemainder).padStart(2, "0")}`;
}
