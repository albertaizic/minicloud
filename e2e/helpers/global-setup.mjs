import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DB = 'minicloud_e2e';
const repoRoot = path.resolve(import.meta.dirname ?? '.', '../..');

export default async function globalSetup() {
  const docker = (args) => execFileSync('docker', args, { stdio: 'pipe', timeout: 30_000 });

  docker(['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`]);
  docker(['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
  docker(['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c', `CREATE DATABASE ${DB}`]);

  // Apply migrations via the project's own runner.
  const env = { ...process.env, DATABASE_URL: `postgres://minicloud:minicloud@localhost:5433/${DB}` };
  execFileSync('node', ['node_modules/tsx/dist/cli.mjs', 'packages/db/src/migrate-cli.ts'],
    { cwd: repoRoot, env, stdio: 'pipe', timeout: 60_000 });

  console.log(`[e2e-setup] database ${DB} ready`);
}
