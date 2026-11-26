import { Effect, Exit } from 'effect';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import type { DatabaseSync } from 'node:sqlite';

/** Run a synchronous write transaction. The operation must not await: another
request could otherwise use the shared connection while the transaction is open.
*/
export function immediate<T>(db: DatabaseSync, operation: () => T): T {
  return metrics.time(Metric.DatabaseTransaction, () => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const result = operation();
      db.exec('COMMIT');

      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      }
      throw error;
    }
  });
}

export function atomic<T>(db: DatabaseSync, operation: () => T): T {
  return db.isTransaction ? operation() : immediate(db, operation);
}

/** Run `body` in a write transaction on `db`, rolling back on any failure. The body runs on the
current stack with the caller's services: no other fiber can use the connection while it is open.
An asynchronous step inside the body is a defect, and rolls back.
*/
export function transaction(db: DatabaseSync) {
  return <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.suspend(() => {
        if (db.isTransaction) {
          return Effect.runSyncExitWith(context)(body);
        }

        return metrics.time(Metric.DatabaseTransaction, () => {
          db.exec('BEGIN IMMEDIATE');

          try {
            const exit = Effect.runSyncExitWith(context)(body);
            db.exec(Exit.isSuccess(exit) ? 'COMMIT' : 'ROLLBACK');

            return exit;
          } catch (error) {
            if (db.isTransaction) {
              db.exec('ROLLBACK');
            }
            throw error;
          }
        });
      }),
    );
}
