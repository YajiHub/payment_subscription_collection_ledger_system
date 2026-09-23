// Money is ALWAYS an integer number of centavos. PHP 150.50 is stored as 15050.
// JavaScript floats cannot represent pesos and centavos exactly, so they are never used
// for monetary values anywhere in this system.

export const CENTAVOS_PER_PESO = 100;

/**
 * An integer amount of centavos. The brand prevents an ordinary `number`
 * (for example a quantity or a percentage) from being passed where money is expected.
 */
export type Centavos = number & { readonly __brand: "Centavos" };