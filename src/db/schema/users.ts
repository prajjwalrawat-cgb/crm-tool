import { boolean, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Local user identity — the self-hosted replacement for Clerk's user
 * store. The primary key is `text` and deliberately reuses the existing
 * Clerk user ids (e.g. `user_2abc…`) so every `owner_id` / `actor_user_id`
 * column across the schema keeps pointing at a valid user with no data
 * rewrite. New users created after the cutover get an `usr_<random>` id.
 *
 * `password_hash` is nullable: users migrated out of Clerk arrive without
 * one and set a password via the reset-email flow on first login.
 *
 * This table is intentionally NOT under RLS — it is looked up by id/email
 * before any tenant context exists (login, session resolution, member
 * enrichment), the same rationale as `tenants`.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Always stored lower-cased; uniqueness is enforced case-sensitively. */
    email: text('email').notNull(),
    /** scrypt hash (`scrypt$N$r$p$salt$hash`); null until the user sets one. */
    passwordHash: text('password_hash'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    imageUrl: text('image_url'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
