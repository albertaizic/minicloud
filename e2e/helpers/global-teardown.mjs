import { execFileSync } from 'node:child_process';

export default async function globalTeardown() {
  const isCI = process.env.CI === 'true';
  try {
    // Clean up any MiniCloud-managed containers
    const out = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'label=minicloud.managed=true'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    for (const id of out.split('\n').filter(Boolean)) {
      try { execFileSync('docker', ['rm', '-f', id], { stdio: 'pipe', timeout: 15_000 }); } catch { /* gone */ }
    }
    const nets = execFileSync('docker', ['network', 'ls', '--filter', 'name=minicloud-app-', '--format', '{{.Name}}'], { encoding: 'utf8', timeout: 15_000 });
    for (const n of nets.split('\n').filter(Boolean)) {
      try { execFileSync('docker', ['network', 'rm', n], { stdio: 'pipe', timeout: 15_000 }); } catch { /* gone */ }
    }
    // Clean up the test database
    if (isCI) {
      execFileSync('psql', ['-h', 'localhost', '-p', '5433', '-U', 'minicloud', '-c', 'DROP DATABASE IF EXISTS minicloud_e2e WITH (FORCE)'], { stdio: 'pipe', timeout: 15_000 });
    } else {
      execFileSync('docker', ['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c', 'DROP DATABASE IF EXISTS minicloud_e2e WITH (FORCE)'], { stdio: 'pipe', timeout: 15_000 });
    }
  } catch (e) {
    console.warn('[e2e-teardown] cleanup incomplete:', String(e).slice(0, 200));
  }
}
