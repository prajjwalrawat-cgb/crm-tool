# lead.save: asking before reusing a company or contact

For: the Ask Mira assistant (the side that calls Saleinx's `act` endpoint with `kind: "lead.save"`).

## What changes

When someone asks Ask Mira to create a lead (from a visiting card, a LinkedIn
screenshot, or text), Saleinx now checks whether the **company** and then the
**contact** already exist. If one does, Saleinx creates nothing and asks
instead. Ask Mira shows the question, gets the person's answer, and calls
`lead.save` again with that answer.

If nothing matches, the call works exactly as before.

## The question: HTTP 409

```json
{
  "error": "A company like \"Siemens\" is already in Saleinx: Siemens Financial Services. Use it, or create a new company?",
  "needs_choice": {
    "field": "company",
    "message": "A company like \"Siemens\" is already in Saleinx: Siemens Financial Services. Use it, or create a new company?",
    "options": [
      { "id": "fcf1ea04-d9c7-4fb8-92f1-c5ea480910e5", "label": "Siemens Financial Services", "detail": "siemens.com · similar name" }
    ],
    "can_create_new": true,
    "answer_with": "company_choice"
  }
}
```

- `field`: `"company"` or `"contact"`. Saleinx asks about the company first. The
  contact question (if any) comes back on the next call.
- `options`: up to 3 existing records. Show `label` (and `detail` if useful).
  Keep the `id`s; don't show them to the person.
- `can_create_new`: when `false`, only "use existing" is allowed. This happens when a contact with
  the **same email** already exists, because Saleinx doesn't allow two contacts with one email.
- `message`: ready to show as is.
- When is a contact "already there"? When it has the same email anywhere in the workspace,
  or a similar name **at the existing company the person chose**. A new company
  never triggers a name question.
- An id you send back is always used as given, even if the matches changed in the
  meantime. If that record has since been deleted, you get a 422; ask again
  without that choice.

## What Ask Mira should do

1. On a 409 with `needs_choice`, show `message` and the options. Ask the person:
   use one of the existing ones, or create a new one (only if `can_create_new`).
2. Call `lead.save` again (with a new action token as usual) with **the same params as before**, plus:
   - `"company_choice"`: the chosen option's `id`, or `"new"`
   - `"contact_choice"`: the chosen option's `id`, or `"new"`
3. Keep the earlier answer when you call again. For example, after answering the company question
   and then getting the contact question, the third call carries both
   `company_choice` and `contact_choice`.
4. Any other 4xx with just `error` is the same as before: show the message.

Example second call:

```json
{
  "kind": "lead.save",
  "params": {
    "company": "Siemens",
    "contact": { "name": "Viswakumar Balasubramaniam", "email": "viswa.bala@siemens.com" },
    "deal": { "name": "…", "source": "Visiting card", "offerings": ["AnytimeHire"] },
    "company_choice": "fcf1ea04-d9c7-4fb8-92f1-c5ea480910e5"
  }
}
```

## Also worth fixing on the Ask Mira side

The deal name should describe the prospect's need (for example "Siemens – AnytimeHire"),
not just the product name. Today's leads were all called "AnytimeHire" or
"Ask Miraa", so four different leads look identical on the board. The product
already goes in `deal.offerings`.

## When choosing an existing contact

Saleinx fills in only the fields that are empty on that contact and never overwrites
what's there. The success reply's `done` list says what was kept.
