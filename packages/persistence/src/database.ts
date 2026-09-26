import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

export interface DatabaseOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: boolean;
  readonly poolMax: number;
}

/**
 * The service's connection. Kysely over `pg`, no entities and no ORM.
 *
 * `ssl` is a real requirement rather than a preference: the incumbent runs
 * with an unencrypted database connection carrying identity documents, which
 * is a live finding, and the tier contract refuses to boot stage or production
 * without it.
 */
export function createDatabase<Schema>(
  options: DatabaseOptions,
): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: options.host,
        port: options.port,
        user: options.user,
        password: options.password,
        database: options.database,
        max: options.poolMax,
        ssl: options.ssl ? { rejectUnauthorized: true } : false,
      }),
    }),
  });
}
