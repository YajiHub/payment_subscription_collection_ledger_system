// An in-memory stand-in for the Drizzle `db` object, used by tests that must run
// without PostgreSQL. It implements just enough of the query-builder surface that
// our services use, and answers from queues the test fills in advance.
//
// This keeps the acceptance tests fast and database-independent while still
// exercising the real handlers, middleware, and services.

export interface RecordedInsert {
  table: unknown;
  values: unknown;
}

export interface RecordedUpdate {
  table: unknown;
  values: unknown;
}

export interface FakeDatabase {
  db: unknown;
  /** Rows returned by the next `select` queries, in call order. */
  queueSelectRows(...resultSets: unknown[][]): void;
  /** Rows returned by the next `insert ... returning()` calls, in call order. */
  queueInsertRows(...resultSets: unknown[][]): void;
  /** Rows returned by the next `update ... returning()` calls, in call order. */
  queueUpdateRows(...resultSets: unknown[][]): void;
  /** Every `insert(...).values(...)` call observed so far. */
  readonly insertedRows: RecordedInsert[];
  /** Every `update(...).set(...)` call observed so far. */
  readonly updatedRows: RecordedUpdate[];
  /** Clears queues and recorded calls between tests. */
  reset(): void;
}

type ThenResolve = (value: unknown[]) => unknown;

function createFakeDatabase(): FakeDatabase {
  const selectQueue: unknown[][] = [];
  const insertQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const insertedRows: RecordedInsert[] = [];
  const updatedRows: RecordedUpdate[] = [];

  function makeSelectBuilder() {
    const builder = {
      from: () => builder,
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      offset: () => builder,
      then(onFulfilled: ThenResolve, onRejected?: (reason: unknown) => unknown) {
        const rows = selectQueue.shift() ?? [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  function makeInsertBuilder(table: unknown) {
    const builder = {
      values: (values: unknown) => {
        insertedRows.push({ table, values });
        return builder;
      },
      returning: () => builder,
      then(onFulfilled: ThenResolve, onRejected?: (reason: unknown) => unknown) {
        const rows = insertQueue.shift() ?? [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  function makeUpdateBuilder(table: unknown) {
    const builder = {
      set: (values: unknown) => {
        updatedRows.push({ table, values });
        return builder;
      },
      where: () => builder,
      returning: () => builder,
      then(onFulfilled: ThenResolve, onRejected?: (reason: unknown) => unknown) {
        const rows = updateQueue.shift() ?? [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const db = {
    select: () => makeSelectBuilder(),
    insert: (table: unknown) => makeInsertBuilder(table),
    update: (table: unknown) => makeUpdateBuilder(table),
  };

  return {
    db,
    queueSelectRows: (...resultSets) => selectQueue.push(...resultSets),
    queueInsertRows: (...resultSets) => insertQueue.push(...resultSets),
    queueUpdateRows: (...resultSets) => updateQueue.push(...resultSets),
    insertedRows,
    updatedRows,
    reset: () => {
      selectQueue.length = 0;
      insertQueue.length = 0;
      updateQueue.length = 0;
      insertedRows.length = 0;
      updatedRows.length = 0;
    },
  };
}

/** Shared singleton; the `vi.mock` factory and the tests both import this. */
export const fakeDatabase = createFakeDatabase();
