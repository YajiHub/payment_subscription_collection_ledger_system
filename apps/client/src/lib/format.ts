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

/** The subscriber's name as it should appear on screen and on documents. */
export function formatSubscriberName(subscriber: {
  firstName: string;
  middleName: string | null;
  lastName: string;
}): string {
  const middleInitial = subscriber.middleName === null ? "" : ` ${subscriber.middleName.charAt(0)}.`;
  return `${subscriber.lastName}, ${subscriber.firstName}${middleInitial}`;
}
