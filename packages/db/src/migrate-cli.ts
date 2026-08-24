// Minimal migration runner CLI: `npm run migrate -w @minicloud/db`
// Load .env from the repo root (two levels up from this package).
import { config } from 'dotenv';
config({ path: new URL('../../../.env', import.meta.url) });
import { databaseFromEnv, runMigrations } from './index.ts';

const db = databaseFromEnv();
try {
  const applied = await runMigrations(db);
  if (applied.length === 0) {
    console.log('migrations: up to date');
  } else {
    for (const m of applied) console.log(`applied ${m}`);
  }
} finally {
  await db.close();
}
