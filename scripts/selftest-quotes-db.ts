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

    await dataLayerChecks(tidA, tidB);
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

/** Task 5: quote + template data layer (queries.ts) under RLS. */
async function dataLayerChecks(tidA: string, tidB: string): Promise<void> {
  const { db } = await import("../src/db/index");
  const { runWithSystemContext } = await import("../src/lib/db-context");
  const q = await import("../src/lib/quotes/queries");
  const { fiscalYearLabel } = await import("../src/lib/quotes/numbering");
  const { defaultTemplateBody } = await import("../src/lib/quotes/default-template");
  const { richTextFromPlain } = await import("../src/lib/quotes/rich-text");
  const USER = "selftest-user";
  const asA = <T>(fn: () => Promise<T>) => runWithSystemContext(tidA, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithSystemContext(tidB, fn);
  const throwsAs = async (fn: () => Promise<unknown>, cls?: new (...a: never[]) => Error) => {
    try {
      await fn();
      return false;
    } catch (err) {
      return cls ? err instanceof cls : true;
    }
  };

  // Fresh slate for tenant A: earlier checks left a raw template and used the numbering sequence.
  await db.execute(sql`DELETE FROM quote_templates WHERE tenant_id = ${tidA}`);
  await db.execute(sql`DELETE FROM quote_number_sequences WHERE tenant_id = ${tidA}`);

  const [co] = (await db.execute(sql`
    INSERT INTO companies (tenant_id, name) VALUES (${tidA}, 'Acme Industries') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [ct] = (await db.execute(sql`
    INSERT INTO contacts (tenant_id, company_id, first_name, last_name, email)
    VALUES (${tidA}, ${co!.id}, 'Asha', 'Rao', 'asha@acme.test') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [deal] = (await db.execute(sql`
    INSERT INTO deals (tenant_id, name, company_id, contact_id)
    VALUES (${tidA}, 'Acme rollout', ${co!.id}, ${ct!.id}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const dealId = deal!.id;

  // createQuoteFromDeal
  const created = await asA(() => q.createQuoteFromDeal(tidA, USER, { dealId }));
  const [org] = (await db.execute(sql`
    SELECT fiscal_year_start_month AS m FROM organization_settings WHERE tenant_id = ${tidA}
  `)) as unknown as Array<{ m: number }>;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const expectedNumber = `Q/${fiscalYearLabel(today, org?.m ?? 1)}/0001`;
  const quote = await asA(() => q.getQuote(tidA, created.id));
  const templates = await asA(() => q.listQuoteTemplates(tidA));
  check(
    "createQuoteFromDeal: draft, first number, revision 1, buyer = company, default starter template",
    created.quoteNumber === expectedNumber &&
      quote?.quoteNumber === expectedNumber &&
      quote.status === "draft" &&
      quote.revision === 1 &&
      quote.buyer.name === "Acme Industries" &&
      quote.items.length === 0 &&
      quote.quoteDate === today &&
      templates.length === 1 &&
      templates[0]!.isDefault &&
      templates[0]!.name === "Standard quotation" &&
      quote.templateId === templates[0]!.id,
    JSON.stringify({ created, status: quote?.status, buyer: quote?.buyer, n: templates.length }),
  );

  check(
    "createQuoteFromDeal: tenant A's deal under tenant B throws QuoteNotFoundError",
    await throwsAs(() => asB(() => q.createQuoteFromDeal(tidB, USER, { dealId })), q.QuoteNotFoundError),
  );

  // updateQuoteDraft: Task 2 A/B lines with an overall discount of 19000.
  const draftInput = {
    quoteDate: quote!.quoteDate,
    validUntil: quote!.validUntil,
    sellerProfileId: null,
    buyer: quote!.buyer,
    consignee: null,
    items: [
      { description: "Line A", quantity: 2, rateMinor: 50_000, discountBps: 0, taxRateBps: 1800 },
      { description: "Line B", quantity: 1, rateMinor: 100_000, discountBps: 1000, taxRateBps: 500 },
    ],
    overallDiscount: { type: "amount" as const, valueMinor: 19_000 },
    content: quote!.content,
  };
  const updated = await asA(() => q.updateQuoteDraft(tidA, USER, created.id, draftInput));
  const storedItems = (await db.execute(sql`
    SELECT allocated_discount_minor::int AS a FROM quote_items
    WHERE quote_id = ${created.id} ORDER BY sort_order
  `)) as unknown as Array<{ a: number }>;
  const [hdr] = (await db.execute(sql`
    SELECT total_minor::int AS t FROM quotes WHERE id = ${created.id}
  `)) as unknown as Array<{ t: number }>;
  check(
    "updateQuoteDraft: stores total_minor 191250 and allocations 10000 / 9000",
    hdr?.t === 191_250 &&
      updated.totalMinor === 191_250 &&
      updated.totals.totalMinor === 191_250 &&
      storedItems.map((r) => r.a).join(",") === "10000,9000",
    JSON.stringify({ hdr, storedItems }),
  );

  let discountFieldError = false;
  try {
    await asA(() =>
      q.updateQuoteDraft(tidA, USER, created.id, {
        ...draftInput,
        overallDiscount: { type: "amount", valueMinor: 999_999_999 },
      }),
    );
  } catch (err) {
    const issues = (err as { issues?: Array<{ path: unknown[] }> }).issues ?? [];
    discountFieldError = issues.some((i) => i.path[0] === "overallDiscount");
  }
  check("updateQuoteDraft: an oversized overall discount is a field error on overallDiscount", discountFieldError);

  // Snapshot independence from later template edits / archiving.
  const tplId = templates[0]!.id;
  const edited = defaultTemplateBody();
  for (const s of edited.sections) {
    if (s.type === "text") s.settings.defaultText = richTextFromPlain("Edited after the quote was made");
  }
  await asA(() => q.saveQuoteTemplate(tidA, USER, { id: tplId, name: "Standard quotation", body: edited }));
  const afterEdit = await asA(() => q.getQuote(tidA, created.id));
  check(
    "template edit leaves the quote's template_snapshot unchanged",
    JSON.stringify(afterEdit?.templateSnapshot) === JSON.stringify(quote!.templateSnapshot) &&
      !JSON.stringify(afterEdit?.templateSnapshot).includes("Edited after"),
  );
  const second = await asA(() => q.duplicateQuoteTemplate(tidA, USER, tplId));
  await asA(() => q.setDefaultQuoteTemplate(tidA, second.id));
  await asA(() => q.archiveQuoteTemplate(tidA, tplId));
  const afterArchive = await asA(() => q.getQuote(tidA, created.id));
  check(
    "archiving the quote's template leaves getQuote working",
    afterArchive?.id === created.id && afterArchive.items.length === 2,
  );

  // Locking: a sent quote refuses draft edits.
  await db.execute(sql`UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = ${created.id}`);
  const frozen = await throwsAs(
    () => asA(() => q.updateQuoteDraft(tidA, USER, created.id, { ...draftInput, items: [draftInput.items[0]!] })),
    q.QuoteFrozenError,
  );
  const [cnt] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM quote_items WHERE quote_id = ${created.id}
  `)) as unknown as Array<{ n: number }>;
  check("updateQuoteDraft on a sent quote throws QuoteFrozenError, items unchanged", frozen && cnt?.n === 2);

  // Revisions.
  const rev = await asA(() => q.createQuoteRevision(tidA, USER, created.id));
  const revQuote = await asA(() => q.getQuote(tidA, rev.id));
  const source = await asA(() => q.getQuote(tidA, created.id));
  check(
    "createQuoteRevision: revision 2, same number, draft, items copied; source superseded",
    revQuote?.revision === 2 &&
      revQuote.quoteNumber === expectedNumber &&
      revQuote.status === "draft" &&
      revQuote.parentQuoteId === created.id &&
      revQuote.items.length === 2 &&
      revQuote.totalMinor === 191_250 &&
      source?.status === "superseded",
    JSON.stringify({ rev: revQuote?.revision, status: source?.status }),
  );
  check(
    "createQuoteRevision on the superseded source throws",
    await throwsAs(() => asA(() => q.createQuoteRevision(tidA, USER, created.id)), q.QuoteRuleError),
  );

  // Templates: default can't be archived; setDefault moves it.
  check(
    "archiveQuoteTemplate on the default template throws",
    await throwsAs(() => asA(() => q.archiveQuoteTemplate(tidA, second.id)), q.QuoteRuleError),
  );
  const third = await asA(() => q.duplicateQuoteTemplate(tidA, USER, second.id));
  await asA(() => q.setDefaultQuoteTemplate(tidA, third.id));
  const active = await asA(() => q.listQuoteTemplates(tidA));
  const defaults = active.filter((t) => t.isDefault);
  check(
    "setDefaultQuoteTemplate moves the default; exactly one remains",
    defaults.length === 1 && defaults[0]!.id === third.id,
    JSON.stringify(active.map((t) => [t.name, t.isDefault])),
  );

  // Lists.
  const forDeal = await asA(() => q.listQuotesForDeal(tidA, dealId));
  const page = await asA(() => q.listQuotes(tidA, { limit: 1 }));
  const page2 = await asA(() => q.listQuotes(tidA, { limit: 1, cursor: page.nextCursor ?? undefined }));
  check(
    "listQuotesForDeal / listQuotes return both revisions with deal + company names, cursor pages",
    forDeal.length === 2 &&
      forDeal.every((r) => r.dealName === "Acme rollout" && r.companyName === "Acme Industries") &&
      page.rows.length === 1 &&
      page.nextCursor !== null &&
      page2.rows.length === 1 &&
      page2.rows[0]!.id !== page.rows[0]!.id,
    JSON.stringify({ forDeal: forDeal.length, p1: page.rows.length, p2: page2.rows.length }),
  );

  // Deal amount from quote goes through the deal patch path (taxable value).
  await asA(() => q.setDealAmountFromQuote(tidA, USER, rev.id));
  const [d2] = (await db.execute(sql`
    SELECT amount_minor::int AS a, updated_by AS u FROM deals WHERE id = ${dealId}
  `)) as unknown as Array<{ a: number; u: string }>;
  const [audit] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM deal_audit_log
    WHERE deal_id = ${dealId} AND field_name = 'amount_minor' AND new_value = '171000'
  `)) as unknown as Array<{ n: number }>;
  check(
    "setDealAmountFromQuote sets the deal amount to the taxable value (171000), audit-logged",
    d2?.a === 171_000 && d2.u === USER && audit?.n === 1,
    JSON.stringify({ d2, audit }),
  );
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
