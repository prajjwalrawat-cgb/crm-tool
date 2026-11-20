/**
 * Self-test for the quote-builder database layer (0078).
 *   pnpm selftest:quotes-db
 *
 * Needs a database; SKIPPED (not failed) without DATABASE_URL. Builds two
 * throwaway tenants and drops them afterwards. Extended by later tasks.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";

config({ path: ".env.local" });
config();

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const SLUG_A = "zz-selftest-quotes-a";
const SLUG_B = "zz-selftest-quotes-b";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set — skipping the database checks.");
    report();
    return;
  }

  const { db, client } = await import("../src/db/index");
  const { runWithSystemContext, tenantTransaction } =
    await import("../src/lib/db-context");

  const created: string[] = [];
  try {
    for (const s of [SLUG_A, SLUG_B]) {
      await db.execute(sql`DELETE FROM tenants WHERE slug = ${s}`);
    }
    const mk = async (slug: string, name: string) => {
      const [t] = (await db.execute(sql`
        INSERT INTO tenants (name, slug) VALUES (${name}, ${slug}) RETURNING id
      `)) as unknown as Array<{ id: string }>;
      created.push(slug);
      return t!.id;
    };
    const tidA = await mk(SLUG_A, "ZZ Selftest Quotes A");
    const tidB = await mk(SLUG_B, "ZZ Selftest Quotes B");

    await runWithSystemContext(tidA, () =>
      tenantTransaction((tx) =>
        tx.execute(sql`
        INSERT INTO quote_templates (tenant_id, name, body)
        VALUES (${tidA}, 'A template', '{"theme":{},"sections":[]}'::jsonb)
      `),
      ),
    );
    const seenByB = await runWithSystemContext(tidB, () =>
      tenantTransaction((tx) =>
        tx.execute(sql`SELECT id FROM quote_templates`),
      ),
    );
    check(
      "RLS: tenant B cannot see tenant A quote_templates",
      (seenByB as unknown as unknown[]).length === 0,
    );
    const seenByA = await runWithSystemContext(tidA, () =>
      tenantTransaction((tx) =>
        tx.execute(sql`SELECT id FROM quote_templates`),
      ),
    );
    check(
      "RLS: tenant A sees its own quote_templates",
      (seenByA as unknown as unknown[]).length === 1,
    );
  } catch (err) {
    check("database checks ran", false, String(err));
  } finally {
    for (const s of created) {
      try {
        await db.execute(sql`DELETE FROM tenants WHERE slug = ${s}`);
      } catch (err) {
        console.error(
          `WARNING: could not remove fixture tenant ${s}. ${String(err)}`,
        );
      }
    }
    await client.end({ timeout: 5 });
    report();
  }
}

function report(): void {
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ""}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("selftest fatal:", err);
  process.exit(1);
});
