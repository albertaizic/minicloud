import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrls, isGitHubActions } from './postgres.mjs';

test('CI=true alone does not impersonate GitHub Actions locally', () => {
  assert.equal(isGitHubActions({ CI: 'true' }), false);
  assert.equal(isGitHubActions({ GITHUB_ACTIONS: 'true' }), true);
});

test('database URLs always target the isolated E2E database and postgres admin DB', () => {
  const urls = databaseUrls({});
  assert.equal(new URL(urls.e2eUrl).pathname, '/minicloud_e2e');
  assert.equal(new URL(urls.adminUrl).pathname, '/postgres');
  assert.equal(new URL(urls.e2eUrl).port, '5433');
});

test('database URL handling preserves opaque credentials without mask replacement', () => {
  const raw = 'postgres://minicloud:***@localhost:5433/minicloud_e2e';
  const urls = databaseUrls({ MINICLOUD_E2E_DATABASE_URL: raw });
  assert.equal(new URL(urls.e2eUrl).password, '***');
  assert.equal(new URL(urls.adminUrl).password, '***');
});

test('database URL override cannot point E2E at a development database', () => {
  assert.throws(
    () => databaseUrls({ MINICLOUD_E2E_DATABASE_URL: 'postgres://minicloud:secret@localhost:5433/minicloud' }),
    /minicloud_e2e/,
  );
});
