import { execFileSync } from 'node:child_process';
import { dropE2eDatabase } from './postgres.mjs';

export default async function globalTeardown() {
  try {
    const out = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'label=minicloud.managed=true'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    for (const id of out.split('\n').filter(Boolean)) {
      try { execFileSync('docker', ['rm', '-f', id], { stdio: 'pipe', timeout: 15_000 }); } catch { /* gone */ }
    }
    const nets = execFileSync(
      'docker',
      ['network', 'ls', '--filter', 'name=minicloud-app-', '--format', '{{.Name}}'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    for (const name of nets.split('\n').filter(Boolean)) {
      try { execFileSync('docker', ['network', 'rm', name], { stdio: 'pipe', timeout: 15_000 }); } catch { /* in use or gone */ }
    }
  } catch (error) {
    console.warn('[e2e-teardown] Docker cleanup incomplete:', String(error).slice(0, 200));
  }

  try {
    await dropE2eDatabase();
  } catch (error) {
    console.warn('[e2e-teardown] database cleanup incomplete:', String(error).slice(0, 200));
  }
}
