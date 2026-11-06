import postgres from 'postgres';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set. Add it to .env before running db:clean.');
  process.exit(1);
}

async function cleanDatabase() {
  console.log('Connecting to database to wipe all data...');
  const sql = postgres(connectionString);

  try {
    console.log('Fetching all table names from public schema...');
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename != '__drizzle_migrations'
    `;

    if (tables.length === 0) {
      console.log('No data tables found in public schema to truncate.');
      return;
    }

    const tableNames = tables.map((t) => `"${t.tablename}"`).join(', ');
    console.log(`Truncating tables: ${tables.map((t) => t.tablename).join(', ')}`);

    await sql.unsafe(`TRUNCATE TABLE ${tableNames} CASCADE;`);
    console.log('All database tables have been successfully truncated and data completely wiped.');
  } catch (err) {
    console.error('Error wiping database:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

cleanDatabase();

