// A real SQLite engine behind the D1 binding shape, migrated with every
// up.sql in order through the runner's own statement splitter (the same text
// D1 receives). Shared by the suites that test repositories against SQL that
// actually runs, not against a stubbed executor.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Binding } from "@saas/db/d1";
import { D1ApiAdapter } from "@saas/db/runner";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
}

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of migrationDirs()) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

/**
 * A D1 binding over `db`; batch() is one transaction, as on D1. The batch runs
 * synchronously between BEGIN and COMMIT, so batches fired concurrently are
 * serialized the way D1 serializes them, instead of nesting transactions.
 */
export function d1Over(db: DatabaseSync): D1Binding {
  const prepare = (query: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      run<T>(): T[] {
        return db.prepare(query).all(...(bound as never[])) as T[];
      },
      all<T>() {
        return Promise.resolve({ results: statement.run<T>(), success: true });
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: Array<{ run(): unknown[] }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push({ results: s.run(), success: true });
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Binding;
}
