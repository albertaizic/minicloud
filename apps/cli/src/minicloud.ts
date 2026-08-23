#!/usr/bin/env node
// minicloud CLI
import { api, ApiError, type AppDto, type DeploymentDto } from './api-client.js';

const c = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

function statusColor(status: string): string {
  switch (status) {
    case 'RUNNING': return green(status);
    case 'FAILED': return red(status);
    case 'STOPPED': return dim(status);
    case 'QUEUED': case 'CLONING': case 'BUILDING': case 'STARTING': case 'HEALTH_CHECKING':
      return yellow(status);
    default: return status;
  }
}

function help(): void {
  console.log(`minicloud - deploy git repos to local Docker

Usage:
  minicloud deploy <git-url> [options]   Create an app (if needed) and deploy it
  minicloud apps                         List applications
  minicloud deployments [app-name]       List deployments
  minicloud status <deployment-id>       Show deployment details
  minicloud logs <deployment-id>         Stream live logs (Ctrl+C to stop)
  minicloud stop <deployment-id>         Stop a deployment
  minicloud restart <deployment-id>      Restart a deployment
  minicloud delete <deployment-id>       Delete a deployment
  minicloud wait <deployment-id>         Wait for a deployment to finish

Options for deploy:
  --name <name>       App name (defaults to repo name)
  --ref <git-ref>     Branch/tag to deploy (default: default branch)

Environment:
  MINICLOUD_API_URL   API base URL (default http://localhost:4000)`);
}

function fail(msg: string): never {
  console.error(red(`error: ${msg}`));
  process.exit(1);
}

function short(id: string): string {
  return id.slice(0, 8);
}

async function waitForTerminal(deploymentId: string): Promise<DeploymentDto> {
  const spinner = ['|', '/', '-', '\\'];
  let i = 0;
  for (;;) {
    const d = await api.getDeployment(deploymentId);
    const active = ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING'].includes(d.status);
    process.stdout.write(`\r${spinner[i++ % 4]} ${d.status}   `);
    if (!active) {
      process.stdout.write('\n');
      return d;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function cmdDeploy(url: string, opts: { name?: string; ref?: string }): Promise<void> {
  if (!url) fail('usage: minicloud deploy <git-url>');
  const repoName = (opts.name ?? url.split('/').pop() ?? 'app').replace(/\.git$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'app';

  let app: AppDto | undefined;
  const existing = (await api.listApps()).find((a) => a.name === repoName);
  if (existing) {
    app = existing;
    console.log(`app ${cyan(repoName)} already exists (${dim(short(app.id))})`);
  } else {
    app = await api.createApp(repoName, url);
    console.log(`created app ${cyan(app.name)} ${dim(short(app.id))}`);
  }
  const { deployment } = await api.deploy(app.id);
  console.log(`deploying ${bold(url)} -> deployment ${dim(short(deployment.id))}`);
  const final = await waitForTerminal(deployment.id);
  if (final.status === 'RUNNING') {
    console.log(green(`✔ deployment is RUNNING at ${final.url}`));
  } else {
    console.log(red(`✖ deployment ${final.status}`));
    if (final.failureReason) console.error(`  reason: ${final.failureReason}`);
    console.log(`  logs: minicloud logs ${final.id}`);
    process.exit(1);
  }
}

async function cmdLogs(id: string): Promise<void> {
  const d = await api.getDeployment(id).catch(() => fail(`deployment ${id} not found`));
  console.log(dim(`--- logs for ${short(d.id)} (${d.status}) ---`));
  await api.streamLogs(id, (line) => console.log(line)).catch((err) => fail(err instanceof ApiError ? err.message : String(err)));
  // keep the process alive while the stream is open
  setInterval(() => {}, 1 << 30);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const val = args[++i];
      flags[a.slice(2)] = val ?? 'true';
    } else positional.push(a);
  }

  switch (cmd) {
    case 'help': case '--help': case '-h': case undefined:
      help();
      return;
    case 'deploy':
      await cmdDeploy(positional[0] ?? '', { name: flags.name, ref: flags.ref });
      return;
    case 'apps': {
      const apps = await api.listApps();
      if (apps.length === 0) return console.log('no applications yet — try: minicloud deploy <git-url>');
      console.log(bold('NAME'.padEnd(20)) + dim('ID'.padEnd(12)) + 'LATEST DEPLOYMENT');
      for (const a of apps) {
        const latest = a.latestDeployment;
        const latestStr = latest ? `${statusColor(latest.status).padEnd(18)} ${dim(short(latest.id))} ${latest.hostPort ? dim(`:${latest.hostPort}`) : ''}` : dim('—');
        console.log(a.name.padEnd(20) + short(a.id).padEnd(12) + latestStr);
      }
      return;
    }
    case 'deployments': {
      const apps = await api.listApps();
      let deps = await api.listDeployments();
      if (positional[0]) {
        const app = apps.find((a) => a.name === positional[0]);
        if (!app) fail(`app ${positional[0]} not found`);
        deps = deps.filter((d) => d.applicationId === app!.id);
      }
      if (deps.length === 0) return console.log('no deployments');
      console.log(bold('ID'.padEnd(12)) + 'STATUS'.padEnd(20) + 'PORT'.padEnd(8) + 'COMMIT'.padEnd(10) + 'CREATED');
      for (const d of deps) {
        console.log(
          short(d.id).padEnd(12) +
            statusColor(d.status).padEnd(20) +
            String(d.hostPort ?? '—').padEnd(8) +
            (d.commitSha?.slice(0, 7) ?? '—').padEnd(10) +
            dim(d.createdAt.slice(0, 19)),
        );
      }
      return;
    }
    case 'status': {
      const d = await api.getDeployment(positional[0] ?? '').catch(() => fail('deployment not found'));
      console.log(`deployment ${bold(d.id)}`);
      console.log(`  status:   ${statusColor(d.status)}`);
      console.log(`  commit:   ${d.commitSha ?? '—'}`);
      console.log(`  url:      ${d.url ?? '—'}`);
      console.log(`  created:  ${d.createdAt}`);
      if (d.startedAt) console.log(`  started:  ${d.startedAt}`);
      if (d.stoppedAt) console.log(`  stopped:  ${d.stoppedAt}`);
      if (d.failureReason) console.log(red(`  failure:  ${d.failureReason}`));
      return;
    }
    case 'logs':
      await cmdLogs(positional[0] ?? '');
      return;
    case 'stop': {
      const d = await api.stop(positional[0] ?? '');
      console.log(`${yellow('■')} deployment ${short(d.id)} ${d.status}`);
      return;
    }
    case 'restart': {
      console.log('restarting…');
      const d = await waitForTerminal((await api.restart(positional[0] ?? '')).id);
      if (d.status === 'RUNNING') console.log(green(`✔ restarted: ${d.url}`));
      else {
        console.log(red(`✖ restart ended in ${d.status}`));
        if (d.failureReason) console.error(`  reason: ${d.failureReason}`);
        process.exit(1);
      }
      return;
    }
    case 'delete': {
      await api.deleteDeployment(positional[0] ?? '');
      console.log(`deleted deployment ${short(positional[0] ?? '')}`);
      return;
    }
    case 'wait': {
      const d = await waitForTerminal(positional[0] ?? '');
      console.log(`${d.status}${d.url ? ` ${d.url}` : ''}`);
      return;
    }
    default:
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  fail(err instanceof ApiError ? err.message : String(err));
});
