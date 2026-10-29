/**
 * Runtime-neutral SQLite wrapper for Liney.
 *
 * Keeps the schema/query semantics across Bun and Node without rewriting
 * the user database. Both APIs are synchronous and SQLite-backed.
 * Only the same process may own the writer; native UI never opens it.
 */
type Driver = {
  query?: (sql: string) => any;
  prepare?: (sql: string) => any;
  exec: (sql: string) => void;
  close: () => void;
};
const runtime = typeof process.versions.bun === "string"
  ? await import("bun:sqlite")
  : await import("node:sqlite");

export class Database {
  private readonly driver: Driver;

  constructor(path: string, options: { create?: boolean } = {}) {
    if (typeof process.versions.bun === "string") {
      this.driver = new (runtime as typeof import("bun:sqlite")).Database(path, options);
    } else {
      const { DatabaseSync } = runtime as typeof import("node:sqlite");
      this.driver = new DatabaseSync(path);
    }
  }

  query(sql: string): any {
    if (this.driver.query) return this.driver.query(sql);
    return this.driver.prepare!(sql);
  }

  exec(sql: string): void {
    this.driver.exec(sql);
  }

  close(): void {
    this.driver.close();
  }
}
