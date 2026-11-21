# Ask Mira lead.save choices: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lead.save` (new lead path) stops with a 409 "needs your choice" when the company or contact already exists, and resumes from `company_choice` / `contact_choice`; nothing is written until both are settled.

**Architecture:** The decisions (ask / use existing / create) live in a new pure module `src/lib/askmira/lead-choices.ts` with no DB or Next imports, so they are unit-tested with plain tsx. `saveLead` in `src/lib/askmira/actions.ts` gathers matches (reads only), asks the pure module, throws the 409 if asked, and only then runs today's create calls.

**Tech Stack:** Next.js server code, drizzle-orm, Postgres pg_trgm matchers in `src/lib/dedup/queries.ts`, tsx self-test scripts.

**Spec:** docs/superpowers/specs/2026-11-20-askmira-lead-duplicates-design.md (and the Ask Mira-side contract: docs/askmira/lead-save-choices.md — the 409 body shape there is binding).

## Global Constraints

- Work on a new branch `feat/askmira-lead-choices` from `main`. Bring the three docs files along (they are untracked on `feat/quotes`).
- Read `node_modules/next/dist/docs/` before touching anything Next-specific (AGENTS.md). This plan touches no Next APIs.
- Test only against the Docker test DB (`.env.local`, port 15434). Never run scripts that write against `.env` (production).
- 409 body: `{ error: <message>, needs_choice: { field: 'company'|'contact', message, options: [{id,label,detail}], can_create_new: boolean, answer_with: 'company_choice'|'contact_choice' } }`; at most 3 options.
- Choice values: `"new"` or a UUID. Anything else → 422.
- The `deal_id` (update an existing lead) path keeps today's behaviour, including overwriting contact fields.
- No match → behaviour identical to today, no 409.

## Review Focus

- A `company_choice` id from another workspace or a deleted company → 422, not a lead under a foreign company. (Task 2 checks it with a tenant-scoped, `deleted_at is null` lookup; Task 3 e2e covers it.)
- Retrying after a company 409 must not ask about the company again because of a company the first call created. Nothing may be written before every decision is settled. (Task 3 e2e: after the contact 409, the company count is unchanged.)
- `contact_choice: "new"` when the email matches an existing contact → 422 with a clear message, never a raw "already exists" from `createContactAction`. (Task 1 test.)
- A common first name ("Akash") must not trigger questions about unrelated people at other companies. Name matches are only checked among the contacts of the existing company that was chosen, and are skipped when the company is new. (Task 1 + Task 2.) *This narrows the spec's "similar name" rule; it's a planner call, so say so in the hand-off.*
- Choosing an existing contact whose phone differs from the card keeps the existing phone and reports it in `done`. (Task 1 `fillBlanks` test.)

---

### Task 1: Pure decision module

**Files:**
- Create: `src/lib/askmira/lead-choices.ts`
- Create: `scripts/selftest-askmira-lead-choices.ts`
- Modify: `package.json` (append `&& tsx scripts/selftest-askmira-lead-choices.ts` to `selftest`; add `"selftest:askmira-lead-choices"`)

**Interfaces:**
- Produces (all exported from `lead-choices.ts`; it must import nothing that pulls in `server-only` or the DB — `HttpError`/`httpError` may be imported from `./core` only if core has no DB import; otherwise define a local `ChoiceError` with `status` and `extra` and let `actions.ts` convert it — check `core.ts` imports first):
  ```ts
  export type Option = { id: string; label: string; detail: string | null };
  export type NeedsChoice = {
    field: 'company' | 'contact';
    message: string;
    options: Option[];
    can_create_new: boolean;
    answer_with: 'company_choice' | 'contact_choice';
  };
  export type Choice = 'new' | { id: string } | null;
  export type Decision =
    | { kind: 'ask'; needs: NeedsChoice }
    | { kind: 'use'; id: string }
    | { kind: 'create'; override: boolean }
    | { kind: 'skip' };                       // contact only: nothing to create
  export function parseChoice(value: unknown, what: 'company_choice' | 'contact_choice'): Choice;
  export function decideCompany(a: { name: string; matches: Array<{ id: string; label: string; sublabel: string | null; kind: 'exact' | 'fuzzy' }>; choice: Choice }): Decision;
  export function decideContact(a: {
    displayName: string; email: string | null; hasDetails: boolean;
    emailMatch: { id: string; name: string } | null;
    nameMatches: Array<{ id: string; label: string; sublabel: string | null }>;
    choice: Choice;
  }): Decision;
  export type ContactFields = { firstName: string | null; lastName: string | null; email: string | null; phone: string | null; title: string | null };
  export function fillBlanks(existing: ContactFields, card: ContactFields): { patch: Partial<ContactFields>; kept: string[] };
  ```

Rules the tests pin:
- `parseChoice`: `undefined`/`null`/`''` → `null`; `'new'` (any case, trimmed) → `'new'`; a UUID (`UUID_RE` from core, or the same regex copied) → `{ id: lowercased }`; anything else throws status 422, message `` `${what} must be "new" or the id of one of the options.` ``.
- `decideCompany`: no matches → `create` with `override:false` (whatever the choice); matches + `null` → `ask` (options = first 3, `detail` = `[sublabel, kind==='exact' ? 'same name' : 'similar name'].filter(Boolean).join(' · ')`, `can_create_new: true`); `'new'` → `create` with `override:true`; `{id}` → `use` (the caller checks that the id exists).
  Message with 1 match: `A company like "${name}" is already in Saleinx: ${label}. Use it, or create a new company?` With 2–3 matches: `Companies like "${name}" are already in Saleinx: ${labels joined ', '}. Use one of them, or create a new company?`
- `decideContact`:
  - `emailMatch` + `null` → `ask`, options `[{id, label: name, detail: email}]`, `can_create_new:false`, message `` `${name} (${email}) is already in Saleinx with this email. Use ${name} for this lead?` ``
  - `emailMatch` + `'new'` → throws 422 `` `A contact with ${email} is already in Saleinx (${name}), so a second one can't be made with that email. Answer with their id to use them.` ``
  - otherwise `nameMatches` non-empty + `null` → `ask`, `can_create_new:true`, message like the company's but with "contact" / "Contacts" and `displayName`
  - `{id}` → `use`; `'new'` → `create` (`override:false`)
  - no matches, `hasDetails` true → `create`; `hasDetails` false → `skip`
- `fillBlanks`: for each field, if the existing value is null or blank and the card's value is set, put it in `patch`; if both are set and differ (case-insensitive, trimmed), add `` `kept the ${label} already on the contact` `` to `kept`, where label is `name` (for first/last together, reported once), `email`, `phone` or `title`.

- [ ] **Step 1: Write the failing self-test** `scripts/selftest-askmira-lead-choices.ts`, in the `check(name, ok)` + results + exitCode style of `scripts/selftest-dedup.ts` (no DB, no dotenv). Cases, at minimum:
  - `parseChoice('NEW ','company_choice') === 'new'`; a UUID in upper case → `{id: lower}`; `'abc'` throws with `status === 422`; `undefined` → `null`
  - `decideCompany` with 0 matches + `null` → `{kind:'create', override:false}`
  - 1 exact match + `null` → `ask`; `needs.message === 'A company like "Siemens" is already in Saleinx: Siemens Financial Services. Use it, or create a new company?'`; `needs.answer_with === 'company_choice'`; `options[0].detail === 'siemens.com · same name'`
  - 4 matches → `options.length === 3`, message starts with `Companies like "`
  - matches + `'new'` → `{kind:'create', override:true}`; matches + `{id}` → `{kind:'use', id}`
  - contact with an email match + `null` → `ask`, `can_create_new === false`; + `'new'` throws 422 containing `can't be made with that email`
  - contact with name matches + `null` → `ask`, `can_create_new === true`, `answer_with === 'contact_choice'`
  - contact with no matches: `hasDetails:true` → `create`; `false` → `skip`
  - `fillBlanks({phone:'111', title:null, …}, {phone:'222', title:'CTO', …})` → `patch` deep-equals `{title:'CTO'}`, `kept` includes `'kept the phone already on the contact'`
- [ ] **Step 2: Run it and confirm it fails.** `pnpm tsx scripts/selftest-askmira-lead-choices.ts` → fails with a "Cannot find module" error for `lead-choices`.
- [ ] **Step 3: Implement `src/lib/askmira/lead-choices.ts`** to the interfaces and rules above.
- [ ] **Step 4: Run it and confirm it passes.** Same command → every check passes, exit 0. Also run `pnpm tsc --noEmit -p .` → no new errors.
- [ ] **Step 5: Commit.** `git add src/lib/askmira/lead-choices.ts scripts/selftest-askmira-lead-choices.ts package.json && git commit -m "feat(askmira): decide when lead.save must ask about an existing company or contact"`

### Task 2: Wire the decisions into saveLead

**Files:**
- Modify: `src/lib/dedup/queries.ts:115` — `findContactNameMatches(tenantId, firstName, lastName, limit = 5, companyId?: string)`: when `companyId` is given, add `AND company_id = ${companyId}::uuid`. Existing callers are unchanged.
- Modify: `src/lib/askmira/actions.ts:153-328` (`saveLead`), header comment lines 3-18 (add one line: lead.save asks before reusing; see docs/askmira/lead-save-choices.md)

**Interfaces:**
- Consumes: everything Task 1 produces; `findCompanyMatches(tenantId, name, 3)`, `findContactByEmail`, `findContactNameMatches(..., companyId)`.
- Produces: the 409 described in Global Constraints (via `httpError(409, needs.message, { needs_choice: needs })`).

New-lead path (no `deal_id`), in this order, **no writes until step 5**:
1. `companyChoice = parseChoice(params.company_choice, 'company_choice')`, `contactChoice` likewise (parse both up front so a bad value fails before anything else).
2. Company: `decideCompany({ name: companyName, matches: await findCompanyMatches(...,3), choice })`. `ask` → throw 409. `use` → check that the id is a company in `me.tenantId` with `deleted_at is null` (a small `tenantTransaction` select inside `inScope`); missing → 422 `That company isn't in Saleinx any more. Ask again without company_choice.` Keep `companyId = id` and `companyIsNew = false`. `create` → remember `{ override }` and set `companyIsNew = true`.
3. Same-open-deal check (today's lines 203-225): run it only when `companyIsNew` is false. If it finds a deal, keep today's behaviour and skip step 4's question (the deal's contact is used).
4. Contact (only if no open deal was found): `emailMatch = contactEmail ? findContactByEmail : null`; `nameMatches = companyIsNew ? [] : findContactNameMatches(tenant, first, last, 3, companyId)`; `decideContact({... hasDetails: !!(contactName.first || contactEmail) })`. `ask` → throw 409. For `use`, check the id is a live contact in the tenant (422 otherwise, same wording with "contact") and load its five `ContactFields`.
5. Writes, in today's order: create the company if needed (`form({ name, dedupOverride: override ? '1' : null })`), then the contact (`use` → `fillBlanks` → `patchContactAction` only if the patch is non-empty, push `contact updated` only then, and push each `kept` line into `done`; `create` → today's `createContactAction`; `skip` → nothing), then everything from today's line 261 onward, unchanged.

- The `deal_id` path (lines 172-186, plus the contact block as it is today) must behave exactly as before. Split the contact block so the overwrite patch only runs on the `deal_id` path.

- [ ] **Step 1: Make the `findContactNameMatches` change.** Run `pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-dedup.ts` against the test DB (`docker start crm-test-pg` first) → still passes.
- [ ] **Step 2: Restructure `saveLead`** as described above.
- [ ] **Step 3: Check that it typechecks and lints.** `pnpm tsc --noEmit -p .` and `pnpm eslint src/lib/askmira src/lib/dedup` → no new errors.
- [ ] **Step 4: Commit.** `git commit -am "feat(askmira): lead.save asks before reusing or creating a company or contact"`

### Task 3: End-to-end check against the test DB (script stays in the scratchpad, never committed)

**Files:**
- Create (scratchpad only): `e2e-lead-choices.mjs`

Setup: `.env.local` must point at port 15434 (check first). Run `pnpm dev` with `.env.local`. In the test DB, insert an `askmira_links` row for the `test-1` tenant (random `askmira_tenant_id`, `secret_nonce`). Mint `act` tokens the way `verify()` in `src/lib/askmira/core.ts:139-195` expects: secret = `derive(tenantId, nonce)` with `AUTH_SECRET` from `.env.local`; claims `iss/aud/sub/use/jti/exp/bh` (read the code for the exact names, `aud`, and how `sub` relates to `askmira_tenant_id`). Then POST to `/api/integrations/askmira/act` as `owner@crm.test`.

- [ ] **Step 1:** Seed a company "Siemens Financial Services" with a contact "Viswa Bala" (email `viswa@siemens.test`).
- [ ] **Step 2:** `lead.save` with company "Siemens", contact "Viswa Bala" / `viswa@siemens.test`, a deal → **409**, `needs_choice.field === 'company'`, option is the seeded company. Companies count unchanged.
- [ ] **Step 3:** Same params + `company_choice: <id>` → **409**, `field === 'contact'`, `can_create_new === false`. Companies and contacts counts unchanged.
- [ ] **Step 4:** + `contact_choice: 'new'` → **422** "can't be made with that email".
- [ ] **Step 5:** + `contact_choice: <id>` (card phone differs from the seeded phone) → **200**. The deal is linked to the seeded company and contact, the seeded phone is unchanged, and `done` includes `kept the phone already on the contact`.
- [ ] **Step 6:** `company_choice: 'new'` on a fresh card → a new company with `dedup_override = true` and a `dedup_override` activity row.
- [ ] **Step 7:** `company_choice: <uuid of another tenant's company>` → **422**.
- [ ] **Step 8:** A card for a company and contact that don't exist anywhere → **200** on the first call, as today.
- [ ] **Step 9:** Remove the seeded rows and the `askmira_links` row. Stop dev. Report the results in the hand-off.

### Task 4: Docs

**Files:** `docs/askmira/lead-save-choices.md`, the spec, this plan (already written)

- [ ] **Step 1:** In the note, add one line under the contact question explaining that similar-name matches only come from the existing company that was chosen. In the spec, add the same narrowing under "Calls I made".
- [ ] **Step 2: Commit.** `git add docs/askmira docs/superpowers && git commit -m "docs(askmira): lead.save choice contract, design and plan"`
