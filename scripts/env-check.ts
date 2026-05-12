import { config } from 'dotenv';

config({ path: '.env.local' });
config();

async function main() {
  const { validateEnv } = await import('../src/lib/env');
  const result = validateEnv();

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const w of result.warnings) console.log(`  ! ${w}`);
    console.log('');
  }

  if (!result.ok) {
    console.error('Errors:');
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    console.error('');
    console.error(
      `Environment validation FAILED (${result.errors.length} required field${
        result.errors.length === 1 ? '' : 's'
      } missing or invalid).`,
    );
    process.exit(1);
  }

  console.log('Environment validation passed.');
}

main().catch((err) => {
  console.error('env-check fatal:', err);
  process.exit(2);
});
