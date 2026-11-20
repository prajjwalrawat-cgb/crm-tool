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

    // Numbering: allocation under RLS, concurrency, FY restart, tenant isolation.
    const { allocateQuoteNumber } = await import("../src/lib/quotes/numbering");
    const alloc = (tid: string, date: string) =>
      runWithSystemContext(tid, () =>
        tenantTransaction((tx) => allocateQuoteNumber(tx, tid, date)),
      );
    const nums = await Promise.all(
      [1, 2, 3, 4, 5].map(() => alloc(tidA, "2026-11-20")),
    );
    const tails = nums.map((n) => n.slice(-4)).sort();
    check(
      "numbering: 5 concurrent allocations are distinct 0001-0005",
      new Set(nums).size === 5 &&
        tails.join(",") === "0001,0002,0003,0004,0005",
      nums.join(" "),
    );
    const nextFy = await alloc(tidA, "2027-12-01");
    check(
      "numbering: a later fiscal year restarts at 0001",
      nextFy.endsWith("0001") && !nums.includes(nextFy),
      nextFy,
    );
    const firstB = await alloc(tidB, "2026-11-20");
    check(
      "numbering: tenant B starts at 0001 independent of tenant A",
      firstB.endsWith("0001"),
      firstB,
    );

    // FK behaviour (superuser db.execute is fine: this is FK, not RLS).
    const mkFixture = async (tag: string) => {
      const [d] = (await db.execute(sql`
        INSERT INTO deals (tenant_id, name) VALUES (${tidA}, ${'fk-' + tag}) RETURNING id
      `)) as unknown as Array<{ id: string }>;
      const [doc] = (await db.execute(sql`
        INSERT INTO deal_documents (tenant_id, deal_id, uploaded_by, file_name, file_url)
        VALUES (${tidA}, ${d!.id}, 'selftest', 'q.pdf', 'http://x/q.pdf') RETURNING id
      `)) as unknown as Array<{ id: string }>;
      const [q] = (await db.execute(sql`
        INSERT INTO quotes (tenant_id, deal_id, quote_number, template_snapshot, seller, buyer,
                            quote_date, valid_until, pdf_document_id)
        VALUES (${tidA}, ${d!.id}, ${'ZZ-' + tag}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                '2026-01-01', '2026-01-31', ${doc!.id}) RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return { dealId: d!.id, docId: doc!.id, quoteId: q!.id };
    };

    const f1 = await mkFixture('cascade');
    let cascadeErr = '';
    try {
      await db.execute(sql`DELETE FROM deals WHERE id = ${f1.dealId}`);
    } catch (err) {
      cascadeErr = String(err);
    }
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM quotes WHERE id = ${f1.quoteId})::int AS q,
             (SELECT count(*) FROM deal_documents WHERE id = ${f1.docId})::int AS d
    `)) as unknown as Array<{ q: number; d: number }>;
    check(
      'FK: hard-deleting a deal removes its quote and filed PDF document together',
      cascadeErr === '' && left[0]!.q === 0 && left[0]!.d === 0,
      cascadeErr,
    );

    const f2 = await mkFixture('block');
    let blockErr = '';
    try {
      await db.execute(sql`DELETE FROM deal_documents WHERE id = ${f2.docId}`);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      blockErr = `${cause?.code ?? ''} ${cause?.message ?? String(err)}`;
    }
    check(
      'FK: deleting a quote-referenced deal_documents row on its own is blocked',
      blockErr.startsWith('23503'),
      blockErr,
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
