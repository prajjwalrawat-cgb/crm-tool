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
    max: process.env.NODE_ENV === 'production' ? 10 : 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.postgresClient = client;
}

export const db = drizzle(client, {
  schema,
  logger: process.env.NODE_ENV !== 'production',
});

export { client };
export type Database = typeof db;
