import { config } from 'dotenv';

config({ path: '.env.local' });
config();

async function main() {
  const { client } = await import('../src/db/index');
  try {
    const tag = await client`select current_user, session_user`;
    console.log('connection identity:', JSON.stringify(tag));

    const role = await client`select rolname from pg_roles where rolname = 'app_user'`;
    console.log('app_user exists:', role.length > 0);

    // Run SET ROLE / SELECT in a single transaction via postgres.js's tx API.
    try {
      await client.begin(async (sql) => {
        await sql`set local role app_user`;
        const inner = await sql`select current_user`;
        console.log('inside transaction:', JSON.stringify(inner));
      });
    } catch (err) {
      console.log('raw error:', err);
    }
  } finally {
    await client.end({ timeout: 3 });
  }
}

void main();
