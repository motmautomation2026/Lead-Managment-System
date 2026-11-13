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

let installed = false;

/** Sets the flag and makes every pg connect (pool or client) throw NoDatabaseError. Idempotent. */
export function installNoDatabaseGuard(): void {
  process.env[NO_DATABASE_FLAG] = "1";
  if (installed) return;
  installed = true;
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
}
