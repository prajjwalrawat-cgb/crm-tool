// When AskMiraa's lead.save must stop and ask (src/lib/askmira/actions.ts).
//
// A lead from a visiting card or a LinkedIn screenshot may name a company or a
// contact already in Saleinx. Rather than quietly reusing it or making a second
// one, lead.save answers 409 with the question; AskMiraa asks the person and
// calls again with `company_choice` / `contact_choice` ("new" or an option's id).
// The contract AskMiraa follows: docs/askmira/lead-save-choices.md.
//
// Pure: no database, no Next. actions.ts gathers the matches and acts on the
// decision.

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
  | { kind: 'skip' };

export type ContactFields = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
};

/** A refusal with an HTTP status; actions.ts turns it into AskMiraa's error reply. */
export class ChoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OPTIONS = 3;

export function parseChoice(value: unknown, what: 'company_choice' | 'contact_choice'): Choice {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.toLowerCase() === 'new') return 'new';
  if (UUID_RE.test(text)) return { id: text.toLowerCase() };
  throw new ChoiceError(422, `${what} must be "new" or the id of one of the options.`);
}

function question(
  field: 'company' | 'contact',
  name: string,
  options: Option[],
): string {
  const labels = options.map((o) => o.label).join(', ');
  return options.length === 1
    ? `A ${field} like "${name}" is already in Saleinx: ${labels}. Use it, or create a new ${field}?`
    : `${field === 'company' ? 'Companies' : 'Contacts'} like "${name}" are already in Saleinx: ${labels}. ` +
        `Use one of them, or create a new ${field}?`;
}

export function decideCompany(a: {
  name: string;
  matches: Array<{ id: string; label: string; sublabel: string | null; kind: 'exact' | 'fuzzy' }>;
  choice: Choice;
}): Decision {
  if (a.matches.length === 0) return { kind: 'create', override: false };
  if (a.choice === 'new') return { kind: 'create', override: true };
  if (a.choice) return { kind: 'use', id: a.choice.id };
  const options = a.matches.slice(0, MAX_OPTIONS).map((m) => ({
    id: m.id,
    label: m.label,
    detail: [m.sublabel, m.kind === 'exact' ? 'same name' : 'similar name'].filter(Boolean).join(' · '),
  }));
  return {
    kind: 'ask',
    needs: {
      field: 'company',
      message: question('company', a.name, options),
      options,
      can_create_new: true,
      answer_with: 'company_choice',
    },
  };
}

export function decideContact(a: {
  displayName: string;
  email: string | null;
  hasDetails: boolean;
  emailMatch: { id: string; name: string } | null;
  nameMatches: Array<{ id: string; label: string; sublabel: string | null }>;
  choice: Choice;
}): Decision {
  if (a.choice && a.choice !== 'new') return { kind: 'use', id: a.choice.id };
  if (a.emailMatch) {
    const { id, name } = a.emailMatch;
    if (a.choice === 'new') {
      throw new ChoiceError(
        422,
        `A contact with ${a.email} is already in Saleinx (${name}), so a second one can't be made with that email. ` +
          'Answer with their id to use them.',
      );
    }
    return {
      kind: 'ask',
      needs: {
        field: 'contact',
        message: `${name} (${a.email}) is already in Saleinx with this email. Use ${name} for this lead?`,
        options: [{ id, label: name, detail: a.email }],
        can_create_new: false,
        answer_with: 'contact_choice',
      },
    };
  }
  if (a.choice === 'new') return { kind: 'create', override: false };
  if (a.nameMatches.length > 0) {
    const options = a.nameMatches
      .slice(0, MAX_OPTIONS)
      .map((m) => ({ id: m.id, label: m.label, detail: m.sublabel }));
    return {
      kind: 'ask',
      needs: {
        field: 'contact',
        message: question('contact', a.displayName, options),
        options,
        can_create_new: true,
        answer_with: 'contact_choice',
      },
    };
  }
  return a.hasDetails ? { kind: 'create', override: false } : { kind: 'skip' };
}

const blank = (v: string | null) => !v || !v.trim();
const same = (a: string | null, b: string | null) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** What the card adds to an existing contact: only its empty fields, never an overwrite. */
export function fillBlanks(
  existing: ContactFields,
  card: ContactFields,
): { patch: Partial<ContactFields>; kept: string[] } {
  const patch: Partial<ContactFields> = {};
  const kept = new Set<string>();
  const fields: Array<[keyof ContactFields, string]> = [
    ['firstName', 'name'],
    ['lastName', 'name'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['title', 'title'],
  ];
  for (const [key, label] of fields) {
    const was = existing[key];
    const now = card[key];
    if (blank(now)) continue;
    if (blank(was)) patch[key] = now;
    else if (!same(was, now)) kept.add(`kept the ${label} already on the contact`);
  }
  return { patch, kept: [...kept] };
}
