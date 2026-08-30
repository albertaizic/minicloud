import pg from 'pg';

const E2E_DATABASE = 'minicloud_e2e';
const DEFAULT_E2E_URL = `postgres://minicloud:minicloud@localhost:5433/${E2E_DATABASE}`;

export function isGitHubActions(env = process.env) {
  return env.GITHUB_ACTIONS === 'true';
}

export function databaseUrls(env = process.env) {
  const e2e = new URL(env.MINICLOUD_E2E_DATABASE_URL ?? DEFAULT_E2E_URL);
  if (e2e.protocol !== 'postgres:' && e2e.protocol !== 'postgresql:') {
    throw new Error('MINICLOUD_E2E_DATABASE_URL must use postgres:// or postgresql://');
  }
  if (decodeURIComponent(e2e.pathname.slice(1)) !== E2E_DATABASE) {
    throw new Error(`MINICLOUD_E2E_DATABASE_URL must target ${E2E_DATABASE}`);
  }
  const admin = new URL(e2e);
  admin.pathname = '/postgres';
  admin.search = '';
  admin.hash = '';
  return { e2eUrl: e2e.toString(), adminUrl: admin.toString() };
}

async function connectAdmin(adminUrl, attempts = 60, delayMs = 500) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client({ connectionString: adminUrl });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function recreateE2eDatabase(env = process.env) {
  const { adminUrl } = databaseUrls(env);
  const client = await connectAdmin(adminUrl);
  try {
    await client.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${E2E_DATABASE}`);
  } finally {
    await client.end();
  }
}

export async function dropE2eDatabase(env = process.env) {
  const { adminUrl } = databaseUrls(env);
  const client = await connectAdmin(adminUrl, 10, 250);
  try {
    await client.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
