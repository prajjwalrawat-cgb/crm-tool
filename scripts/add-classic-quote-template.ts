import { config } from 'dotenv';

config({ path: '.env.local' });
config();

/**
 * Add the classic (boxed GST proforma) quote template to one workspace.
 * The template is added alongside the existing ones and never replaces the
 * default; make it the default from Settings → Quote templates if wanted.
 *
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/add-classic-quote-template.ts --tenant <slug|uuid>
 *   ... --tenant artbox --name "Proforma Invoice" --apply
 *
 * Dry run (prints the target DB host and workspace) unless --apply.
 * Database: loads .env.local, then .env; never overrides a variable already set.
 */

type Args = { tenant: string | null; name: string; apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { tenant: null, name: 'Proforma Invoice', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--tenant') out.tenant = val();
    else if (a === '--name') out.name = val();
    else if (a === '--apply') out.apply = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!out.tenant) throw new Error('--tenant <slug|uuid> is required');
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { eq, or, ilike } = await import('drizzle-orm');
  const { db, client } = await import('../src/db/index');
  const { tenants } = await import('../src/db/schema');
  const { runWithSystemContext, SYSTEM_ACTOR_ID } = await import('../src/lib/db-context');
  const { classicProformaTemplateBody } = await import('../src/lib/quotes/classic-template');
  const { listQuoteTemplates, saveQuoteTemplate } = await import('../src/lib/quotes/queries');

  try {
    const host = (() => {
      try {
        return new URL(process.env.DATABASE_URL ?? '').host;
      } catch {
        return '(unparseable DATABASE_URL)';
      }
    })();
    console.log(`Database: ${host}`);

    const t = args.tenant!;
    const matches = await db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(UUID_RE.test(t) ? eq(tenants.id, t) : or(eq(tenants.slug, t), ilike(tenants.name, `%${t}%`)));
    if (matches.length !== 1) {
      console.log(matches.length ? `"${t}" matches ${matches.length} workspaces; pass the uuid:` : `No workspace matches "${t}".`);
      for (const m of matches) console.log(`  ${m.id}  ${m.slug}  ${m.name}`);
      process.exitCode = 1;
      return;
    }
    const tenant = matches[0];
    console.log(`Workspace: ${tenant.name} (${tenant.slug}, ${tenant.id})`);

    await runWithSystemContext(tenant.id, async () => {
      const existing = await listQuoteTemplates(tenant.id);
      console.log(`Existing templates: ${existing.map((x) => `${x.name}${x.isDefault ? ' [default]' : ''}`).join(', ') || '(none)'}`);
      if (existing.some((x) => x.name === args.name)) {
        console.log(`A template named "${args.name}" already exists; nothing to do (pass --name to add another).`);
        return;
      }
      if (!args.apply) {
        console.log(`Dry run: would add "${args.name}" (classic layout). Re-run with --apply.`);
        return;
      }
      const { id } = await saveQuoteTemplate(tenant.id, SYSTEM_ACTOR_ID, { name: args.name, body: classicProformaTemplateBody() });
      console.log(`Added "${args.name}" (${id}).`);
    });
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
