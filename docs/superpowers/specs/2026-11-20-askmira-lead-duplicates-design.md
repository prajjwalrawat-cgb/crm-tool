# Ask Mira lead.save: ask before reusing or creating a company or contact

Date: 2026-11-20 · Status: draft for approval · Size: small change

## Why

People create leads in Ask Mira from a visiting card or a LinkedIn screenshot
("create a lead"). Today `lead.save` (src/lib/askmira/actions.ts) silently
reuses an exact-name company, silently ignores near-matches (so "Siemens"
and "Siemens Financial Services" become two companies), and silently reuses a
same-email contact **and overwrites its name, phone and title** with what was
on the card. The person never gets asked. They want the flow to be:
company → contact → deal, and when a company or contact already exists, Ask Mira
says so and asks "use the existing one or create a new one?".

## Goals

- When the company matches one already in Saleinx (exact or similar name), stop and ask.
- When the contact matches one already in Saleinx, stop and ask.
- Nothing is written until both questions are settled, so asking never leaves
  half a lead behind.
- No match → exactly today's behaviour, no extra round trip.

## Non-goals

- Changing the in-app company/contact forms or the dedup module itself.
- Changing `lead.save` with a `deal_id` (updating an existing lead), or the
  existing "same open deal under the same company" check.
- Changing the Ask Mira bot code (lives elsewhere; see the note below).

## Approaches

- **A. Saleinx stops and returns the matches (picked).** `lead.save` answers
  409 with a ready-to-show question and the match ids; the bot asks the person
  and calls `lead.save` again with their choice. One action, Saleinx owns the
  rules, cannot be skipped.
- B. A separate "check" query the bot calls first. Rejected: two calls, and a
  bot that skips the check brings duplicates back.
- C. A draft lead confirmed on a Saleinx page. Rejected: leaves the chat, heaviest.

## Design

1. **Order.** Company first. Only once the company is settled is the contact
   checked. Only once both are settled is anything created (company, then
   contact, then deal, then source / next step / follow-up / note as today).
2. **Company check.** Uses the app's existing `findCompanyMatches` (exact
   normalized name + similar names), top 3. Any match → ask.
3. **Contact check.**
   - Same email as an existing contact → ask, but the only options are
     "use existing" (Saleinx already refuses a second contact with the same
     email, so "create new" with that email is not offered; the message says so).
   - Otherwise similar name (the app's `findContactNameMatches`) → ask, with
     "use existing" or "create new".
4. **The question** goes back as HTTP 409:
   ```json
   {
     "error": "A company like \"Siemens Financial Services\" is already in Saleinx: Siemens Financial Services. Use it, or create a new company?",
     "needs_choice": {
       "field": "company",
       "message": "…same as error…",
       "options": [
         { "id": "fcf1ea04-…", "label": "Siemens Financial Services", "detail": "siemens.com · exact name" }
       ],
       "can_create_new": true,
       "answer_with": "company_choice"
     }
   }
   ```
   `field` is `"company"` or `"contact"`; for a contact, `answer_with` is
   `"contact_choice"`.
5. **The answer.** The bot calls `lead.save` again with the same params plus
   `company_choice` and/or `contact_choice`, each either `"new"` or the id of an
   option. An id not in this workspace (or deleted) is refused with a 422.
   `"new"` for a company is saved with the app's existing duplicate-override
   flag, so it lands in the audit log like a person clicking past the
   warning in the form.
6. **Using an existing contact** fills only its empty fields from the card. It
   never overwrites a name, phone or title that is already there. The `done` list
   says what was kept (for example "kept the phone already on Venkat"). This
   replaces today's silent overwrite.
7. **Always on for Ask Mira.** The check runs even if the workspace has the
   dedup feature flag off, because this is the behaviour the person asked for in Ask Mira.

## Calls I made (correct me)

- Similar names count as "already exists", not only exact ones.
- Same email cannot become a second contact (the app's own rule), so that case
  offers only "use existing".
- One question at a time (company, then contact), so up to two extra round trips.
- Existing contacts are filled in, never overwritten.
- (Plan) Similar contact names are only checked among the contacts of the existing company
  that was chosen, and skipped for a new company, so a common first name doesn't
  trigger questions about unrelated people. A same-email contact is still caught anywhere.
- (Build) An answered company or contact id is always used as given; a deleted one → 422.

## Left to the builder

- Exact wording of messages; how "detail" is composed.
- Tests in the existing askmira self-test style.

## Ask Mira side

See docs/askmira/lead-save-choices.md (the note for the Ask Mira team).
