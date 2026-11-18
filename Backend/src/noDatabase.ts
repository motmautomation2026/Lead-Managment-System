import pg from "pg";

/**
 * DEMO-1 rule 1: a run with no database at all (the offline demo journey). With
 * NORTHBEAM_NO_DATABASE=1, loading src/db.ts throws (src/dbGuard.ts is its first import) and
 * installNoDatabaseGuard() makes any pg pool or client that tries to connect throw too.
 */

export const NO_DATABASE_FLAG = "NORTHBEAM_NO_DATABASE";

export class NoDatabaseError extends Error {
  constructor(what: string) {
    super(`${what}, but this run has no database (${NO_DATABASE_FLAG}=1). The offline demo never connects to Postgres.`);
    this.name = "NoDatabaseError";
  }
}

export const databaseDisabled = () => process.env[NO_DATABASE_FLAG] === "1";

/** Throws when this run has no database. */
export function assertDatabaseAllowed(what: string): void {
  if (databaseDisabled()) throw new NoDatabaseError(what);
}

/** Sets the flag and makes every pg connect (pool or client) throw NoDatabaseError. Returns the undo (tests). */
export function installNoDatabaseGuard(): () => void {
  const previous = { flag: process.env[NO_DATABASE_FLAG], pool: pg.Pool.prototype.connect, client: pg.Client.prototype.connect };
  process.env[NO_DATABASE_FLAG] = "1";
  const refuse = (what: string) =>
    function (this: unknown, callback?: unknown) {
      const error = new NoDatabaseError(what);
      if (typeof callback === "function") {
        (callback as (e: Error) => void)(error);
        return undefined;
      }
      return Promise.reject(error);
    };
  pg.Pool.prototype.connect = refuse("Something tried to open a database pool connection") as typeof pg.Pool.prototype.connect;
  pg.Client.prototype.connect = refuse("Something tried to open a database client") as typeof pg.Client.prototype.connect;
  return () => {
    if (previous.flag === undefined) delete process.env[NO_DATABASE_FLAG];
    else process.env[NO_DATABASE_FLAG] = previous.flag;
    pg.Pool.prototype.connect = previous.pool;
    pg.Client.prototype.connect = previous.client;
  };
}
