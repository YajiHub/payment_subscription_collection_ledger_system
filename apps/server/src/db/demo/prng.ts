// A tiny, dependency-free deterministic pseudo-random generator.
//
// The demo dataset must be reproducible: two runs with the same seed must produce
// the same subscribers, the same amounts and the same counts (S9-2). `Math.random()`
// cannot promise that, and pulling in a dependency for a handful of integer picks
// is not worth it, so this is the 32-bit `mulberry32` algorithm — small enough to
// read in one sitting and stable across Node versions.
//
// Every draw advances one shared internal state, so the order in which callers ask
// for values is part of the seed's meaning. The demo plan therefore draws in a
// fixed order while building, which is what makes the same seed reproduce exactly.

export interface SeededRandom {
  /** A fractional value in [0, 1). */
  next(): number;
  /** A whole number in [minimumInclusive, maximumInclusive]. */
  nextInt(minimumInclusive: number, maximumInclusive: number): number;
  /** One element of a non-empty list. */
  pick<T>(values: readonly T[]): T;
  /** A new array with the same elements in a deterministically shuffled order. */
  shuffled<T>(values: readonly T[]): T[];
}

/** Builds a deterministic generator. The same seed always yields the same sequence. */
export function createSeededRandom(seed: number): SeededRandom {
  // `>>> 0` keeps the state an unsigned 32-bit integer, so the arithmetic below is
  // exactly reproducible on every platform.
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(minimumInclusive: number, maximumInclusive: number): number {
    if (maximumInclusive < minimumInclusive) {
      throw new RangeError(
        `Cannot draw from an empty range: ${minimumInclusive}..${maximumInclusive}`
      );
    }
    const span = maximumInclusive - minimumInclusive + 1;
    return minimumInclusive + Math.floor(next() * span);
  }

  function pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("Cannot pick from an empty list");
    }
    // The array is known non-empty, so the element exists; the cast keeps the
    // noUncheckedIndexedAccess compiler honest.
    return values[nextInt(0, values.length - 1)] as T;
  }

  function shuffled<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = nextInt(0, index);
      const held = copy[index] as T;
      copy[index] = copy[swapIndex] as T;
      copy[swapIndex] = held;
    }
    return copy;
  }

  return { next, nextInt, pick, shuffled };
}
