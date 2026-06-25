import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

type PostgresClient = ReturnType<typeof postgres>;

// Reuse the underlying client across HMR reloads in dev to avoid exhausting
// the connection pool on every code change.
const globalForDb = globalThis as unknown as { postgresClient?: PostgresClient };

const client: PostgresClient =
  globalForDb.postgresClient ??
  postgres(process.env.DATABASE_URL, {
    // Required by Supabase's Transaction pooler (port 6543) and Neon's pooler;
    // both reject prepared statements at the pool layer.
    prepare: false,
    // Pool size. Dev was 1, which silently serialized every query —
    // even Promise.all'd ones ran one-at-a-time (see scripts/_perf-probe.ts:
    // "8x parallel" took the same as "8x sequential"). The client is reused
    // across HMR via the global below, so a larger pool doesn't leak
    // connections on reload. The Supabase transaction pooler multiplexes,
    // so 10 client-side connections is comfortable.
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.postgresClient = client;
}

// Drizzle's query logger prints every SQL statement + params on stdout.
// Useful when debugging a specific query but very noisy by default
// (~10 lines per page render). Opt in with `DB_QUERY_LOG=true` in
// `.env.local` when you actually want to see the SQL.
export const db = drizzle(client, {
  schema,
  logger: process.env.DB_QUERY_LOG === 'true',
});

export { client };
export type Database = typeof db;
