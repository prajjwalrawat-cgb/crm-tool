/**
 * Pure self-test for AskMiraa lead.save choices (src/lib/askmira/lead-choices.ts):
 * when an existing company or contact makes lead.save stop and ask, and what
 * each answer ("new" or an option's id) leads to. No database.
 */
import {
  ChoiceError,
  decideCompany,
  decideContact,
  fillBlanks,
  parseChoice,
  type ContactFields,
} from '../src/lib/askmira/lead-choices';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}
function throws(fn: () => unknown): ChoiceError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ChoiceError ? err : null;
  }
}

const ID = '3b3d43e4-89d1-42f1-80b3-547cd7542c5b';
const company = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    label: i === 0 ? 'Siemens Financial Services' : `Siemens ${i}`,
    sublabel: i === 0 ? 'siemens.com' : null,
    kind: (i === 0 ? 'exact' : 'fuzzy') as 'exact' | 'fuzzy',
  }));

// parseChoice
check('choice "NEW " is new', parseChoice('NEW ', 'company_choice') === 'new');
const up = parseChoice(ID.toUpperCase(), 'company_choice');
check('choice uuid is lowercased id', typeof up === 'object' && up?.id === ID);
check('choice empty is null', parseChoice(undefined, 'company_choice') === null && parseChoice('', 'contact_choice') === null);
const bad = throws(() => parseChoice('abc', 'company_choice'));
check('choice garbage is a 422', bad?.status === 422 && bad.message.includes('company_choice must be "new"'));

// decideCompany
const none = decideCompany({ name: 'Siemens', matches: [], choice: null });
check('no company match creates', none.kind === 'create' && !none.override);
const askOne = decideCompany({ name: 'Siemens', matches: company(1), choice: null });
check(
  'one company match asks',
  askOne.kind === 'ask' &&
    askOne.needs.message ===
      'A company like "Siemens" is already in Saleinx: Siemens Financial Services. Use it, or create a new company?' &&
    askOne.needs.answer_with === 'company_choice' &&
    askOne.needs.field === 'company' &&
    askOne.needs.can_create_new === true &&
    askOne.needs.options[0]?.detail === 'siemens.com · same name',
  JSON.stringify(askOne),
);
const askMany = decideCompany({ name: 'Siemens', matches: company(4), choice: null });
check(
  'four company matches show three',
  askMany.kind === 'ask' &&
    askMany.needs.options.length === 3 &&
    askMany.needs.message.startsWith('Companies like "Siemens" are already in Saleinx: Siemens Financial Services, Siemens 1, Siemens 2.') &&
    askMany.needs.options[1]?.detail === 'similar name',
  JSON.stringify(askMany),
);
const asNew = decideCompany({ name: 'Siemens', matches: company(1), choice: 'new' });
check('company "new" creates with override', asNew.kind === 'create' && asNew.override);
const asUse = decideCompany({ name: 'Siemens', matches: company(1), choice: { id: ID } });
check('company id uses it', asUse.kind === 'use' && asUse.id === ID);

// decideContact
const base = { displayName: 'Viswa Bala', email: 'viswa@siemens.test', hasDetails: true, nameMatches: [] };
const emailMatch = { id: ID, name: 'Viswa Bala' };
const askEmail = decideContact({ ...base, emailMatch, choice: null });
check(
  'email match asks with no "new"',
  askEmail.kind === 'ask' &&
    askEmail.needs.can_create_new === false &&
    askEmail.needs.field === 'contact' &&
    askEmail.needs.answer_with === 'contact_choice' &&
    askEmail.needs.options[0]?.id === ID &&
    askEmail.needs.message === 'Viswa Bala (viswa@siemens.test) is already in Saleinx with this email. Use Viswa Bala for this lead?',
  JSON.stringify(askEmail),
);
const emailNew = throws(() => decideContact({ ...base, emailMatch, choice: 'new' }));
check('email match + "new" is a 422', emailNew?.status === 422 && emailNew.message.includes("can't be made with that email"));
const askName = decideContact({
  ...base,
  emailMatch: null,
  nameMatches: [{ id: ID, label: 'Viswa B', sublabel: null }],
  choice: null,
});
check(
  'name match asks with "new"',
  askName.kind === 'ask' &&
    askName.needs.can_create_new === true &&
    askName.needs.answer_with === 'contact_choice' &&
    askName.needs.message === 'A contact like "Viswa Bala" is already in Saleinx: Viswa B. Use it, or create a new contact?',
  JSON.stringify(askName),
);
const nameNew = decideContact({ ...base, emailMatch: null, nameMatches: [{ id: ID, label: 'Viswa B', sublabel: null }], choice: 'new' });
check('name match + "new" creates', nameNew.kind === 'create');
const useId = decideContact({ ...base, emailMatch, choice: { id: ID } });
check('contact id uses it', useId.kind === 'use' && useId.id === ID);
check('no contact match creates', decideContact({ ...base, emailMatch: null, choice: null }).kind === 'create');
check(
  'nothing to save skips',
  decideContact({ ...base, email: null, hasDetails: false, emailMatch: null, choice: null }).kind === 'skip',
);

// fillBlanks
const blank: ContactFields = { firstName: null, lastName: null, email: null, phone: null, title: null };
const filled = fillBlanks({ ...blank, firstName: 'Viswa', phone: '111' }, { ...blank, firstName: 'viswa', phone: '222', title: 'CTO' });
check(
  'fillBlanks fills only empty fields',
  JSON.stringify(filled.patch) === JSON.stringify({ title: 'CTO' }),
  JSON.stringify(filled),
);
check(
  'fillBlanks reports a differing phone',
  filled.kept.length === 1 && filled.kept[0] === 'kept the phone already on the contact',
  JSON.stringify(filled.kept),
);
const names = fillBlanks({ ...blank, firstName: 'Viswa', lastName: 'Bala' }, { ...blank, firstName: 'Vishwa', lastName: 'Balan' });
check('fillBlanks reports a differing name once', names.kept.length === 1 && names.kept[0] === 'kept the name already on the contact');

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(exitCode);
