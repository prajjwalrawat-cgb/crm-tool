# Lead capture: inbound endpoint contract

This is for anyone wiring a website, landing page, lead portal (IndiaMART, JustDial, TradeIndia) or ad platform into Saleinx.

Each lead source has its own URL and secret. An admin creates the source in Saleinx and copies both into the sending system. Until the settings screen ships, sources are created directly in the database.

## Endpoint

```
POST https://<your-saleinx-host>/api/public/ingest/<sourceId>
```

**Authentication.** Send one of these two headers. Both use the source's secret.

| Header | Value |
|---|---|
| `X-Saleinx-Token` | the secret, as is |
| `X-Saleinx-Signature` | `sha256=` + hex HMAC-SHA256 of the **exact raw request body**, keyed with the secret |

Use the signature where the sender supports it. It proves the body was not changed in transit and never sends the secret over the wire.

**Body.** A JSON object (`Content-Type: application/json`) or a form post (`application/x-www-form-urlencoded`). The maximum size is 1 MB. Nested objects are flattened one level. Meta's `field_data` array is understood as is.

**Fields.** Any field names work. Common names are recognised automatically, for example `name`, `full_name`, `first_name`, `email`, `phone`, `mobile`, `SENDER_MOBILE`, `company`, `city`, `state`, `product`, `QUERY_PRODUCT_NAME`, `message`, `utm_source`, `utm_medium`, `utm_campaign`, `consent`. A source can also carry its own field mapping (inbound name → lead field, or `custom.<key>` for a custom field). A lead needs at least a phone number or an email address.

**Phone numbers** are stored in E.164 format, defaulting to India. `+91 98765 43210`, `098765 43210`, `9876543210` and `91 98765 43210` all become `+919876543210`.

## Responses

| Status | Body | Meaning |
|---|---|---|
| 202 | `{"eventId": "...", "replay": false}` | Stored. It is processed within seconds. |
| 202 | `{"eventId": "...", "replay": true}` | The same payload was already received from this source in the last 24 h. Nothing new is created. |
| 400 | `{"error": "invalid_json"}` or `body_must_be_an_object` | The body could not be read. |
| 401 | `{"error": "invalid_signature"}` | The token or signature is wrong. Nothing is stored. |
| 404 | `{"error": "unknown_source"}` | The source id is unknown, or the source is switched off. |
| 413 | `{"error": "payload_too_large"}` | The body is over 1 MB. |
| 429 | `{"error": "rate_limited"}` | Over 60 requests/min from one IP, or 600/min to one source. Retry after a minute. |

A 202 means the payload is safely stored, not that a lead was created. If the payload has no usable phone or email, it is kept as a **failed** event with a reason, so it can be fixed and retried instead of being lost.

## Examples

Token:

```bash
curl -X POST "https://<host>/api/public/ingest/<sourceId>" \
  -H "Content-Type: application/json" \
  -H "X-Saleinx-Token: <secret>" \
  -d '{"name":"Ravi Kumar","mobile":"+91 98765 43210","email":"ravi@acme.in","company":"Acme Castings","city":"Pune","product":"Induction furnace","utm_source":"google","utm_campaign":"furnace-q4"}'
```

HMAC signature:

```bash
BODY='{"name":"Ravi Kumar","mobile":"9876543210"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "<secret>" -hex | sed 's/^.* //')
curl -X POST "https://<host>/api/public/ingest/<sourceId>" \
  -H "Content-Type: application/json" \
  -H "X-Saleinx-Signature: sha256=$SIG" \
  --data-raw "$BODY"
```

Node:

```js
import { createHmac } from 'node:crypto';
const body = JSON.stringify(lead);
const sig = createHmac('sha256', secret).update(body).digest('hex');
await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Saleinx-Signature': `sha256=${sig}` } });
```

## What happens after a 202

1. **Dedupe.** If a contact with the same phone number or email already exists, no new lead is created. The existing lead gets a "Re-enquiry via \<source\>" entry on its timeline and its owner is notified. A lead that was closed as lost more than 30 days ago is reopened.
2. **Create.** Otherwise a contact and a deal at stage **Lead** are created. The deal records the source, the UTM tags, the consent flag and the city, state and product.
3. **Distribute.** Distribution rules are checked in priority order and the first match wins. If none match, the source's default rule applies, then the workspace default rule. Only reps who are active, marked available, inside their working hours and under the rule's capacity cap can receive a lead. The strategies are round robin, weighted, least loaded, skill match, region match and fixed owner. If nobody is eligible, the lead goes to the unassigned queue, managers are notified, and it is retried every 15 minutes for up to 6 hours. If the only reason is that everyone is off shift, it waits for the next shift.
4. **SLA.** Each assignment has a first-response deadline in the rep's working time. A 30-minute SLA on a lead assigned at 18:15, to a rep whose day ends at 18:30, is due at 09:45 the next working day. A logged call or meeting, a sent email or a note by the owner counts as the first response. Every 5 minutes, untouched leads past their deadline are reassigned to someone who has not had them yet. After the rule's maximum number of reassignments, managers are notified instead. A lead the owner has already worked on is never reassigned.

## Hosted and embedded forms

Build forms in **Settings › Capture forms**. A published form is available two ways:

- **Hosted page:** `https://<host>/f/<workspace-slug>/<form-slug>`. Share it as a link.
- **Embed on your own site:**
  ```html
  <div data-saleinx-form="<workspace-slug>/<form-slug>"></div>
  <script src="https://<host>/embed/form.js" async></script>
  ```
  The form renders in a shadow DOM, so your site's CSS can't break it and it can't break your site. Your site's origin (for example `https://www.yourcompany.com`) must be listed under **Allowed origins** on the form's lead source. Otherwise the browser's cross-origin submit is refused.

Submissions carry the page's `utm_*` parameters, the landing URL and the referrer. They then go through the same pipeline as the webhook: stored, deduped, created and distributed.

Bot protection:
- A hidden honeypot field.
- A 2-second minimum fill time. Bots that trip either one get a normal "thank you" and nothing is stored.
- A limit of 20 submits per minute per IP.
- Optional Cloudflare Turnstile: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

If the form has a consent statement, a lead can't be submitted unless the visitor ticks it.

Field keys `name`, `phone`, `email`, `company`, `city`, `state`, `product` and `message` map straight onto the lead.

Public endpoints used by the embed:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/forms/<workspace>/<form>` | Form definition (fields, consent text, colours) |
| POST | `/api/public/forms/<workspace>/<form>/submit` | Submit `{fields, consent, hp, t, utm, landingUrl, referrer, captchaToken}` |
| GET | `/embed/form.js` | The embed script |

## Meta (Facebook / Instagram) lead ads

1. Create a lead source of type **Meta lead ads**. Under its settings, enter the Facebook page id and a long-lived **page access token**. Optionally, restrict it to specific lead form ids.
2. In your Meta app, go to **Webhooks → Page** and subscribe to `leadgen`:
   - Callback URL: `https://<host>/api/public/meta/<sourceId>/webhook`
   - Verify token: the source's secret
3. Set these on the server:
   - `META_APP_SECRET`: Meta signs every delivery with it (`X-Hub-Signature-256`), and unsigned deliveries are rejected.
   - `META_GRAPH_VERSION` (optional): defaults to `v21.0`. Check Meta's changelog for the current version.

Meta's webhook carries only ids. Saleinx fetches the lead's fields from the Graph API with the page token. If that fetch fails, the webhook returns 500 so Meta redelivers it.

## CSV import

**Leads › Import leads** (managers and admins). The steps are: upload → map columns → review → import.

- Columns are matched to lead fields by name. If `ANTHROPIC_API_KEY` is set, Claude suggests the mapping from the **column headers only**. Row values are never sent anywhere. The model is `claude-sonnet-5-5`, overridable with `ANTHROPIC_LEAD_MAPPING_MODEL`. Without a key, or if the model's answer isn't valid, a built-in name matcher is used.
- The review step shows the first 20 rows and flags any that can't become a lead (no usable phone or email).
- Imports run in the background in chunks of 100 rows and can resume. Every row takes the same dedupe and distribution path as a webhook lead. Re-importing the same file within 24 h creates nothing new.
- Limits: 10,000 rows and 4 MB per file.

## Authenticated REST API

These are session-authenticated, so they're for logged-in tooling. The Settings screens use server actions with the same validation.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/distribution/simulate?sourceId=&state=&city=&productInterest=…` (or `?lead=<json>`) | owner/admin | Dry run: the matching rule, the assignee and each pool member's eligibility. Writes nothing. |
| POST | `/api/leads/:id/reassign` `{to, reason}` | owner/admin/manager | Release the open assignment and assign to `to` with a fresh SLA |
| GET | `/api/lead-ingest-events?status=failed&sourceId=` | owner/admin | Recent ingest events |
| POST | `/api/lead-ingest-events/:id/retry` | owner/admin | Re-process a failed event |
| GET | `/api/jobs/:id` | owner/admin/manager | Import job progress |

Lead sources, forms and rules are created and edited in Settings: **Lead sources**, **Capture forms** and **Distribution**.

## Seed data

```
pnpm seed:lead-capture <workspace-slug> [--use-existing-members]
```

This creates:
- 3 demo reps with IST working hours, skills and regions. They have no password, so they can't sign in until someone runs a password reset.
- A geo rule for Maharashtra and Gujarat, plus a default round-robin rule.
- A webhook source and a published `enquiry` form.

It prints the endpoint, the secret and the form URL.

## Recovering after an Inngest outage

Processing a captured lead, running a CSV import and distributing leads all run as Inngest functions. If Inngest stops starting runs (for example, when the plan's execution limit is hit), it still accepts the events but never runs them, and they aren't queued for later. The endpoint still returns 202 and the payload is saved, but no lead gets created.

`pnpm leads:recover-stuck` finds and finishes that work in-process, without going through Inngest:

- CSV import jobs still `queued` or `running`
- inbound events still `received` (payload saved, no lead)
- leads at routing `pending` that were never distributed. The retry cron only looks back 6 hours.

```bash
pnpm leads:recover-stuck                       # dry run: report per workspace
pnpm leads:recover-stuck --apply               # create, import and assign
pnpm leads:recover-stuck --tenant <uuid> --older-than-minutes 30 --limit 200
```

Rows newer than `--older-than-minutes` (default 15) are treated as in flight and left alone. Every step is idempotent, so re-running is safe. The script prints the database host first. It reads `.env.local`, then `.env`, and never overrides a variable that is already set, so set `DATABASE_URL` explicitly to target production. Telephony webhooks can't be recovered this way, because their payloads aren't stored.
