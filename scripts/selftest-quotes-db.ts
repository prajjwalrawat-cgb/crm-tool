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
// The deal patch path queues a score recompute; without a local Inngest it
// logs a one-time "delivery unavailable" warning. Keep test output clean.
process.env.LOG_LEVEL ??= "error";

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
    await sendChecks(tidA);
    await fixWaveChecks(tidA);
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

  await db.execute(sql`DELETE FROM quote_templates WHERE tenant_id = ${tidB}`);
  const crossTenantThrows = await throwsAs(
    () => asB(() => q.createQuoteFromDeal(tidB, USER, { dealId })),
    q.QuoteNotFoundError,
  );
  const [bTemplates] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM quote_templates WHERE tenant_id = ${tidB}
  `)) as unknown as Array<{ n: number }>;
  check(
    "createQuoteFromDeal: tenant A's deal under tenant B throws QuoteNotFoundError, no starter left in B",
    crossTenantThrows && bTemplates?.n === 0,
    JSON.stringify(bTemplates),
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
  await db.execute(sql`UPDATE quotes SET status = 'sent', sent_at = now(), quote_date = '2026-01-01', valid_until = '2026-01-31'
    WHERE id = ${created.id}`);
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
  const validity = (await asA(() => q.getQuoteSettings(tidA))).defaultValidityDays;
  const plus = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  check(
    "createQuoteRevision: revision 2, same number, draft, re-dated today + validity, items copied; source superseded",
    revQuote?.revision === 2 &&
      revQuote.quoteNumber === expectedNumber &&
      revQuote.status === "draft" &&
      revQuote.parentQuoteId === created.id &&
      revQuote.items.length === 2 &&
      revQuote.totalMinor === 191_250 &&
      revQuote.quoteDate === today &&
      revQuote.validUntil === plus(today, validity) &&
      source?.status === "superseded" &&
      source.quoteDate === "2026-01-01",
    JSON.stringify({ rev: revQuote?.revision, d: revQuote?.quoteDate, v: revQuote?.validUntil, status: source?.status }),
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
  const fourth = await asA(() => q.duplicateQuoteTemplate(tidA, USER, second.id));
  const raced = await Promise.allSettled([
    asA(() => q.setDefaultQuoteTemplate(tidA, second.id)),
    asA(() => q.setDefaultQuoteTemplate(tidA, fourth.id)),
  ]);
  const afterRace = (await asA(() => q.listQuoteTemplates(tidA))).filter((t) => t.isDefault);
  check(
    "concurrent setDefaultQuoteTemplate on two templates: both succeed, exactly one default",
    raced.every((r) => r.status === "fulfilled") &&
      afterRace.length === 1 &&
      [second.id, fourth.id].includes(afterRace[0]!.id),
    JSON.stringify(raced.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))),
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
  const badCursors = await Promise.all(
    ["not-a-cursor!!", Buffer.from('{"t":"x","id":"y"}').toString("base64url")].map((cursor) =>
      asA(() => q.listQuotes(tidA, { limit: 1, cursor })),
    ),
  );
  check(
    "listQuotes: a malformed cursor returns the first page",
    badCursors.every((r) => r.rows.length === 1 && r.rows[0]!.id === page.rows[0]!.id),
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

/** Task 8: mark as sent (filed PDF, locking, cleanup), render input, delete protection. */
async function sendChecks(tidA: string): Promise<void> {
  const { db } = await import("../src/db/index");
  const { runWithSystemContext, tenantTransaction } = await import("../src/lib/db-context");
  const q = await import("../src/lib/quotes/queries");
  const { markQuoteSent, sendFailure, SEND_FAILED_MESSAGE } = await import("../src/lib/quotes/send");
  const { buildQuoteRenderInput } = await import("../src/lib/quotes/render-input");
  const { protectedDocumentReason } = await import("../src/lib/deals/protected-documents");
  type SendDeps = import("../src/lib/quotes/send").SendDeps;
  const asA = <T>(fn: () => Promise<T>) => runWithSystemContext(tidA, fn);

  // A real user as the quote creator (users is global, not tenant-scoped).
  const creatorId = "selftest-quote-creator";
  await db.execute(sql`DELETE FROM users WHERE id = ${creatorId}`);
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${creatorId}, 'priya.selftest@example.test', 'Priya', 'Sharma')
  `);
  try {
    const [deal] = (await db.execute(sql`
      INSERT INTO deals (tenant_id, name, company_name, custom_fields)
      VALUES (${tidA}, 'Send flow deal', 'Globex Ltd', '{"po":"PO-42"}'::jsonb) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const dealId = deal!.id;

    const newDraft = async (withItems: boolean) => {
      const { id } = await asA(() => q.createQuoteFromDeal(tidA, creatorId, { dealId }));
      if (withItems) {
        const cur = (await asA(() => q.getQuote(tidA, id)))!;
        await asA(() =>
          q.updateQuoteDraft(tidA, creatorId, id, {
            quoteDate: cur.quoteDate,
            validUntil: cur.validUntil,
            sellerProfileId: null,
            buyer: cur.buyer,
            consignee: null,
            items: [{ description: "Widget", quantity: 1, rateMinor: 10_000, discountBps: 0, taxRateBps: 1800 }],
            overallDiscount: { type: "none" as const },
            content: cur.content,
          }),
        );
      }
      return id;
    };
    const fakeDeps = (render?: SendDeps["render"]) => {
      const calls = { upload: [] as Array<{ fileName: string; contentType: string; size: number }>, removed: [] as string[] };
      const deps: SendDeps = {
        render: render ?? (async () => new Uint8Array([37, 80, 68, 70])),
        upload: async (input) => {
          calls.upload.push({ fileName: input.fileName, contentType: input.contentType, size: input.bytes.byteLength });
          return { url: "u", path: "p" };
        },
        removeUpload: async (path) => {
          calls.removed.push(path);
        },
      };
      return { deps, calls };
    };

    // buildQuoteRenderInput: deal name, creator name, custom fields, snapshot body.
    const draftId = await newDraft(true);
    const input = await asA(() => buildQuoteRenderInput(tidA, draftId));
    check(
      "buildQuoteRenderInput: deal.name and the creator's name/email in placeholderValues, deal custom fields, snapshot body",
      input?.placeholderValues["deal.name"] === "Send flow deal" &&
        input.placeholderValues["rep.name"] === "Priya Sharma" &&
        input.placeholderValues["rep.email"] === "priya.selftest@example.test" &&
        input.dealCustomFields.po === "PO-42" &&
        JSON.stringify(input.body) === JSON.stringify(input.quote.templateSnapshot) &&
        input.logoUrl === null,
      JSON.stringify({ pv: input?.placeholderValues, cf: input?.dealCustomFields, logo: input?.logoUrl }),
    );

    // Happy path.
    const ok = fakeDeps();
    const sent = await asA(() => markQuoteSent(tidA, creatorId, draftId, ok.deps));
    const after = await asA(() => q.getQuote(tidA, draftId));
    const docs = (await db.execute(sql`
      SELECT id, category::text AS category, uploaded_by, file_name, file_url, storage_path, file_type, size_bytes::int AS size
      FROM deal_documents WHERE deal_id = ${dealId}
    `)) as unknown as Array<{ id: string; category: string; uploaded_by: string; file_name: string; file_url: string; storage_path: string; file_type: string; size: number }>;
    check(
      "markQuoteSent: status sent, one proposal deal_documents row, pdf_document_id set",
      after?.status === "sent" &&
        after.sentAt !== null &&
        after.sentBy === creatorId &&
        after.pdfDocumentId === sent.documentId &&
        docs.length === 1 &&
        docs[0]!.id === sent.documentId &&
        docs[0]!.category === "proposal" &&
        docs[0]!.uploaded_by === creatorId &&
        docs[0]!.file_url === "u" &&
        docs[0]!.storage_path === "p" &&
        docs[0]!.file_type === "application/pdf" &&
        docs[0]!.size === 4 &&
        docs[0]!.file_name === `${after.quoteNumber} Rev 1.pdf` &&
        ok.calls.upload.length === 1 &&
        ok.calls.upload[0]!.fileName === `${after.quoteNumber} Rev 1.pdf` &&
        ok.calls.upload[0]!.contentType === "application/pdf" &&
        ok.calls.removed.length === 0,
      JSON.stringify({ status: after?.status, sent, docs, calls: ok.calls }),
    );

    const [stamp] = (await db.execute(sql`
      SELECT updated_by, (updated_at = sent_at) AS same FROM quotes WHERE id = ${draftId}
    `)) as unknown as Array<{ updated_by: string; same: boolean }>;
    check(
      "markQuoteSent stamps updated_at (= sent_at) and updated_by",
      stamp?.updated_by === creatorId && stamp.same === true,
      JSON.stringify(stamp),
    );

    // Error mapping used by markQuoteSentAction.
    const frozenF = sendFailure(new q.QuoteFrozenError());
    const ruleF = sendFailure(new q.QuoteRuleError("Add at least one line item before sending."));
    const notFoundF = sendFailure(new q.QuoteNotFoundError());
    const storageF = sendFailure(new Error("Storage upload failed: bucket missing"));
    const oddF = sendFailure("boom");
    check(
      "sendFailure: quote errors keep their message; render/storage/other errors get the generic message, flagged unexpected",
      frozenF.error === new q.QuoteFrozenError().message && !frozenF.unexpected &&
        ruleF.error === "Add at least one line item before sending." && !ruleF.unexpected &&
        notFoundF.error === "Quote not found." && !notFoundF.unexpected &&
        storageF.error === SEND_FAILED_MESSAGE && storageF.unexpected &&
        oddF.error === SEND_FAILED_MESSAGE && oddF.unexpected &&
        SEND_FAILED_MESSAGE === "Could not create the quote PDF. Try again.",
      JSON.stringify({ frozenF, ruleF, notFoundF, storageF, oddF }),
    );

    // Second send: frozen.
    const again = fakeDeps();
    let frozen = false;
    try {
      await asA(() => markQuoteSent(tidA, creatorId, draftId, again.deps));
    } catch (err) {
      frozen = err instanceof q.QuoteFrozenError;
    }
    check("markQuoteSent a second time throws QuoteFrozenError, no upload", frozen && again.calls.upload.length === 0);

    // protectedDocumentReason
    const reason = await asA(() =>
      tenantTransaction((tx) => protectedDocumentReason(tx, tidA, sent.documentId)),
    );
    const [plain] = (await db.execute(sql`
      INSERT INTO deal_documents (tenant_id, deal_id, uploaded_by, file_name, file_url)
      VALUES (${tidA}, ${dealId}, 'selftest', 'plain.pdf', 'http://x/plain.pdf') RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const plainReason = await asA(() =>
      tenantTransaction((tx) => protectedDocumentReason(tx, tidA, plain!.id)),
    );
    check(
      "protectedDocumentReason: 'quote' for the filed PDF, null for an ordinary document",
      reason === "quote" && plainReason === null,
      JSON.stringify({ reason, plainReason }),
    );

    // No items: rejected before upload.
    const emptyId = await newDraft(false);
    const empty = fakeDeps();
    let emptyMsg = "";
    try {
      await asA(() => markQuoteSent(tidA, creatorId, emptyId, empty.deps));
    } catch (err) {
      emptyMsg = err instanceof Error ? err.message : String(err);
    }
    check(
      "markQuoteSent on a draft without items throws, upload never called",
      emptyMsg === "Add at least one line item before sending." && empty.calls.upload.length === 0,
      emptyMsg,
    );

    // DB step fails after render + upload: the upload is removed.
    const doomedId = await newDraft(true);
    const doomed = fakeDeps(async () => {
      await db.execute(sql`DELETE FROM quotes WHERE id = ${doomedId}`);
      return new Uint8Array([37, 80, 68, 70]);
    });
    let doomedThrew = false;
    try {
      await asA(() => markQuoteSent(tidA, creatorId, doomedId, doomed.deps));
    } catch {
      doomedThrew = true;
    }
    const [orphans] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM deal_documents WHERE deal_id = ${dealId} AND category = 'proposal'
    `)) as unknown as Array<{ n: number }>;
    check(
      "markQuoteSent: when the DB step fails after upload, removeUpload('p') is called and nothing is filed",
      doomedThrew &&
        doomed.calls.upload.length === 1 &&
        doomed.calls.removed.length === 1 &&
        doomed.calls.removed[0] === "p" &&
        orphans?.n === 1,
      JSON.stringify({ doomedThrew, calls: doomed.calls, orphans }),
    );

    // An edit between the load and the transaction must not file a stale PDF.
    const racedId = await newDraft(true);
    const raced = fakeDeps(async () => {
      await db.execute(sql`UPDATE quotes SET updated_at = now() + interval '1 second' WHERE id = ${racedId}`);
      return new Uint8Array([37, 80, 68, 70]);
    });
    let racedThrew = false;
    try {
      await asA(() => markQuoteSent(tidA, creatorId, racedId, raced.deps));
    } catch {
      racedThrew = true;
    }
    const racedAfter = await asA(() => q.getQuote(tidA, racedId));
    check(
      "markQuoteSent: a draft edited while rendering stays draft and the upload is removed",
      racedThrew && racedAfter?.status === "draft" && raced.calls.removed[0] === "p",
      JSON.stringify({ racedThrew, status: racedAfter?.status, calls: raced.calls }),
    );
  } finally {
    await db.execute(sql`DELETE FROM users WHERE id = ${creatorId}`);
  }
}

/** Final-review fixes: locked sections, milestone sums on send, number collisions. */
async function fixWaveChecks(tidA: string): Promise<void> {
  const { db } = await import("../src/db/index");
  const { runWithSystemContext } = await import("../src/lib/db-context");
  const q = await import("../src/lib/quotes/queries");
  const { markQuoteSent } = await import("../src/lib/quotes/send");
  const { buildQuoteRenderInput } = await import("../src/lib/quotes/render-input");
  const { renderQuotePdfServer } = await import("../src/lib/quotes/pdf/render-server");
  const { defaultTemplateBody } = await import("../src/lib/quotes/default-template");
  const { richTextFromPlain } = await import("../src/lib/quotes/rich-text");
  const { extractText } = await import("unpdf");
  type SendDeps = import("../src/lib/quotes/send").SendDeps;
  type QuoteDraftInput = import("../src/lib/quotes/schema").QuoteDraftInput;
  type QuoteDetail = import("../src/lib/quotes/types").QuoteDetail;
  const USER = "selftest-user";
  const asA = <T>(fn: () => Promise<T>) => runWithSystemContext(tidA, fn);
  const errorOf = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  const pdfText = async (id: string) => {
    const input = (await asA(() => buildQuoteRenderInput(tidA, id)))!;
    const bytes = await renderQuotePdfServer(input);
    const { text } = await extractText(bytes, { mergePages: true });
    return text.replace(/\s+/g, " ");
  };
  const uploads: string[] = [];
  const deps: SendDeps = {
    render: async () => new Uint8Array([37, 80, 68, 70]),
    upload: async (i) => {
      uploads.push(i.fileName);
      return { url: "u", path: "p" };
    },
    removeUpload: async () => {},
  };

  const [deal] = (await db.execute(sql`
    INSERT INTO deals (tenant_id, name, company_name) VALUES (${tidA}, 'Fix wave deal', 'Initech') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const dealId = deal!.id;
  const draftOf = (cur: QuoteDetail, content = cur.content): QuoteDraftInput => ({
    quoteDate: cur.quoteDate,
    validUntil: cur.validUntil,
    sellerProfileId: null,
    buyer: cur.buyer,
    consignee: null,
    items: [{ description: "Widget", quantity: 1, rateMinor: 10_000, discountBps: 0, taxRateBps: 1800 }],
    overallDiscount: { type: "none" },
    content,
  });

  // A template whose terms are locked (repEditable false).
  const lockedBody = defaultTemplateBody();
  for (const s of lockedBody.sections) {
    if (s.type === "terms") {
      s.settings.repEditable = false;
      s.settings.defaultText = richTextFromPlain("Locked terms version one.");
    }
  }
  const { id: lockedTplId } = await asA(() =>
    q.saveQuoteTemplate(tidA, USER, { name: "Locked terms", body: lockedBody }),
  );
  const { id: quoteId } = await asA(() => q.createQuoteFromDeal(tidA, USER, { dealId, templateId: lockedTplId }));
  const fresh = (await asA(() => q.getQuote(tidA, quoteId)))!;

  // (a) Forged content for the locked section is ignored on save.
  const forged = {
    ...fresh.content,
    terms: { terms: richTextFromPlain("FORGED terms the template does not allow.") },
    intro: { text: richTextFromPlain("Rep-written intro.") },
  };
  const saved = await asA(() => q.updateQuoteDraft(tidA, USER, quoteId, draftOf(fresh, forged)));
  const savedJson = JSON.stringify(saved.content);
  const textA = await pdfText(quoteId);
  check(
    "repEditable: forged content for a locked terms section is not stored or printed; editable intro is kept",
    !savedJson.includes("FORGED") &&
      savedJson.includes("Locked terms version one.") &&
      savedJson.includes("Rep-written intro.") &&
      !textA.includes("FORGED") &&
      textA.includes("Locked terms version one.") &&
      textA.includes("Rep-written intro."),
    JSON.stringify({ savedJson: savedJson.slice(0, 300), textA: textA.slice(0, 300) }),
  );

  // Content written straight to the row (e.g. an older draft) still prints the snapshot default.
  await db.execute(sql`
    UPDATE quotes SET content = jsonb_set(content, '{terms}', ${JSON.stringify({ terms: richTextFromPlain("STALE row terms.") })}::jsonb)
    WHERE id = ${quoteId}
  `);
  const textStale = await pdfText(quoteId);
  check(
    "repEditable: the PDF uses the snapshot default for a locked section whatever the stored content",
    !textStale.includes("STALE row terms.") && textStale.includes("Locked terms version one."),
    textStale.slice(0, 300),
  );

  // (b) Admin changes the locked default; the rep re-applies and gets it.
  const v2 = structuredClone(lockedBody);
  for (const s of v2.sections) if (s.type === "terms") s.settings.defaultText = richTextFromPlain("Locked terms version two.");
  await asA(() => q.saveQuoteTemplate(tidA, USER, { id: lockedTplId, name: "Locked terms", body: v2 }));
  await asA(() => q.reapplyTemplate(tidA, USER, quoteId));
  const reapplied = (await asA(() => q.getQuote(tidA, quoteId)))!;
  const reJson = JSON.stringify(reapplied.content);
  const textB = await pdfText(quoteId);
  check(
    "reapplyTemplate: a changed locked terms default is stored and printed; the rep's intro survives",
    reJson.includes("Locked terms version two.") &&
      !reJson.includes("version one") &&
      !reJson.includes("STALE") &&
      reJson.includes("Rep-written intro.") &&
      textB.includes("Locked terms version two.") &&
      !textB.includes("version one"),
    JSON.stringify({ reJson: reJson.slice(0, 300) }),
  );

  // (d) The quote's own template archived: re-apply falls back to the tenant default.
  const [def] = (await db.execute(sql`
    SELECT id FROM quote_templates WHERE tenant_id = ${tidA} AND is_default AND archived_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  await asA(() => q.archiveQuoteTemplate(tidA, lockedTplId));
  await asA(() => q.reapplyTemplate(tidA, USER, quoteId));
  const fellBack = (await asA(() => q.getQuote(tidA, quoteId)))!;
  const fbTerms = fellBack.templateSnapshot.sections.find((s) => s.type === "terms");
  check(
    "reapplyTemplate: with the quote's template archived, it re-snapshots the default template",
    !!def &&
      fellBack.templateId === def.id &&
      fbTerms?.type === "terms" &&
      fbTerms.settings.repEditable === true &&
      // terms are editable in the default, so the stored text carries over
      JSON.stringify(fellBack.content).includes("Locked terms version two."),
    JSON.stringify({ templateId: fellBack.templateId, def }),
  );

  // (c) Re-apply on a sent quote is refused.
  await asA(() => markQuoteSent(tidA, USER, quoteId, deps));
  check(
    "reapplyTemplate on a sent quote throws QuoteFrozenError",
    (await errorOf(() => asA(() => q.reapplyTemplate(tidA, USER, quoteId)))) instanceof q.QuoteFrozenError,
  );

  // Milestones: updateQuoteDraft rejects a schedule that doesn't sum to 100%.
  const { id: msId } = await asA(() => q.createQuoteFromDeal(tidA, USER, { dealId }));
  const msQuote = (await asA(() => q.getQuote(tidA, msId)))!;
  const psId = msQuote.templateSnapshot.sections.find((s) => s.type === "payment_schedule")!.id;
  const badMs = await errorOf(() =>
    asA(() =>
      q.updateQuoteDraft(
        tidA,
        USER,
        msId,
        draftOf(msQuote, {
          ...msQuote.content,
          [psId]: {
            milestones: [
              { label: "A", percentBps: 5000 },
              { label: "B", percentBps: 5000 },
              { label: "C", percentBps: 5000 },
            ],
          },
        }),
      ),
    ),
  );
  const badPaths = ((badMs as { issues?: Array<{ path: unknown[] }> } | null)?.issues ?? []).map((i) => i.path.join("."));
  check(
    "updateQuoteDraft: milestones 50/50/50 are a field error on content.<id>.milestones",
    badPaths.includes(`content.${psId}.milestones`),
    JSON.stringify(badPaths),
  );

  // markQuoteSent refuses an enabled schedule whose effective milestones don't sum to 100%.
  await asA(() => q.updateQuoteDraft(tidA, USER, msId, draftOf(msQuote)));
  await db.execute(sql`
    UPDATE quotes SET content = jsonb_set(content, ${`{${psId}}`}::text[],
      ${JSON.stringify({ milestones: [{ label: "A", percentBps: 3000 }, { label: "B", percentBps: 3000 }] })}::jsonb)
    WHERE id = ${msId}
  `);
  const before = uploads.length;
  const sendErr = await errorOf(() => asA(() => markQuoteSent(tidA, USER, msId, deps)));
  const msAfter = await asA(() => q.getQuote(tidA, msId));
  check(
    "markQuoteSent: a payment schedule summing to 60% throws QuoteRuleError before upload; quote stays draft",
    sendErr instanceof q.QuoteRuleError &&
      sendErr.message.includes("100%") &&
      uploads.length === before &&
      msAfter?.status === "draft",
    String(sendErr),
  );

  // Numbering: numbers already taken (e.g. after a format change) are skipped.
  const takeNumber = async (n: string) => {
    await db.execute(sql`
      INSERT INTO quotes (tenant_id, deal_id, quote_number, template_snapshot, seller, buyer, quote_date, valid_until)
      VALUES (${tidA}, ${dealId}, ${n}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '2026-01-01', '2026-01-31')
    `);
  };
  const tail = /^(.*?)(\d+)$/.exec(msQuote.quoteNumber)!;
  const numberAt = (k: number) => `${tail[1]}${String(Number(tail[2]) + k).padStart(tail[2]!.length, "0")}`;
  await takeNumber(numberAt(1));
  await takeNumber(numberAt(2));
  const skipped = await errorOf(async () => {
    const r = await asA(() => q.createQuoteFromDeal(tidA, USER, { dealId }));
    if (r.quoteNumber !== numberAt(3)) throw new Error(`got ${r.quoteNumber}, want ${numberAt(3)}`);
  });
  check("createQuoteFromDeal: skips two pre-taken numbers and gets the following one", skipped === null, String(skipped));

  for (let k = 4; k < 24; k++) await takeNumber(numberAt(k));
  const exhausted = await errorOf(() => asA(() => q.createQuoteFromDeal(tidA, USER, { dealId })));
  check(
    "createQuoteFromDeal: 20 taken numbers in a row ends in a QuoteRuleError",
    exhausted instanceof q.QuoteRuleError,
    String(exhausted),
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
