// Minimal migration runner CLI: `npm run migrate -w @minicloud/db`
import { databaseFromEnv, runMigrations } from './index.js';

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
