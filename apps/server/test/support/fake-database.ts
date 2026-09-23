// An in-memory stand-in for the Drizzle `db` object, used by tests that must run
// without PostgreSQL. It implements just enough of the query-builder surface that
// our services use, and answers from queues the test fills in advance.
//
// It also models `db.transaction`: statements run against a private record buffer
// and are published only when the callback resolves, so a throw rolls them back.
// That is what lets the tests prove a failed statement cannot leave partial state.
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
  /** Makes the next `insert` reject, simulating a database failure mid-transaction. */
  failNextInsert(error: Error): void;
  /** Every `insert(...).values(...)` call that committed so far. */
  readonly insertedRows: RecordedInsert[];
  /** Every `update(...).set(...)` call that committed so far. */
  readonly updatedRows: RecordedUpdate[];
  /** Clears queues and recorded calls between tests. */
  reset(): void;
}

type ThenResolve = (value: unknown[]) => unknown;

/** The buffers a query writes its recorded call into (root, or a transaction's). */
interface RecordBuffers {
  insertedRows: RecordedInsert[];
  updatedRows: RecordedUpdate[];
}

function createFakeDatabase(): FakeDatabase {
  const selectQueue: unknown[][] = [];
  const insertQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const insertFailures: Error[] = [];
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
      // `SELECT ... FOR UPDATE` is accepted and ignored; the tests do not lock.
      for: () => builder,
      then(onFulfilled: ThenResolve, onRejected?: (reason: unknown) => unknown) {
        const rows = selectQueue.shift() ?? [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  function makeInsertBuilder(table: unknown, records: RecordBuffers) {
    const builder = {
      values: (values: unknown) => {
        records.insertedRows.push({ table, values });
        return builder;
      },
      returning: () => builder,
      then(onFulfilled: ThenResolve, onRejected?: (reason: unknown) => unknown) {
        const failure = insertFailures.shift();
        if (failure !== undefined) {
          return Promise.reject(failure).then(onFulfilled, onRejected);
        }
        const rows = insertQueue.shift() ?? [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  function makeUpdateBuilder(table: unknown, records: RecordBuffers) {
    const builder = {
      set: (values: unknown) => {
        records.updatedRows.push({ table, values });
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

  function makeExecutor(records: RecordBuffers) {
    return {
      select: () => makeSelectBuilder(),
      insert: (table: unknown) => makeInsertBuilder(table, records),
      update: (table: unknown) => makeUpdateBuilder(table, records),
      // Advisory locks and other raw statements are accepted and ignored. Receipt
      // sequence reads still come through `select` above, so tests stay honest.
      execute: async () => ({ rows: [] }),
    };
  }

  const committed: RecordBuffers = { insertedRows, updatedRows };

  const db = {
    ...makeExecutor(committed),
    // Statements inside the callback are buffered; a resolved callback commits
    // them, a throw discards them. Nested transactions are not needed here.
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const pending: RecordBuffers = { insertedRows: [], updatedRows: [] };
      const result = await callback(makeExecutor(pending));
      insertedRows.push(...pending.insertedRows);
      updatedRows.push(...pending.updatedRows);
      return result;
    },
  };

  return {
    db,
    queueSelectRows: (...resultSets) => selectQueue.push(...resultSets),
    queueInsertRows: (...resultSets) => insertQueue.push(...resultSets),
    queueUpdateRows: (...resultSets) => updateQueue.push(...resultSets),
    failNextInsert: (error) => insertFailures.push(error),
    insertedRows,
    updatedRows,
    reset: () => {
      selectQueue.length = 0;
      insertQueue.length = 0;
      updateQueue.length = 0;
      insertFailures.length = 0;
      insertedRows.length = 0;
      updatedRows.length = 0;
    },
  };
}

/** Shared singleton; the `vi.mock` factory and the tests both import this. */
export const fakeDatabase = createFakeDatabase();
