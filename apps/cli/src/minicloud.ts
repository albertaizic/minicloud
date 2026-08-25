#!/usr/bin/env node
// minicloud CLI
import { api, ApiError, configApi, reliabilityApi, resolveAppId, resolveDeploymentId, assertPlausibleId, type AppDto, type DeploymentDto, type LimitsDto } from './api-client.js';

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

  minicloud limits clear <app>           Remove limits

Reliability & observability:
  minicloud events <deployment-id>       Lifecycle event timeline
  minicloud stats <deployment-id>        Live CPU/memory metrics (--watch to refresh)
  minicloud rollback <app> <deployment>  Roll back to a previous successful deployment
  minicloud restart-policy <app> [policy] [--max N]
                                         Show or set restart policy (disabled|on-failure)
  minicloud prune [--yes]                Remove stopped containers, unreferenced
                                         MiniCloud images, stale workspaces
  minicloud routes                       Show gateway routing table

Stable app URLs: http://<app>.localhost:<gateway-port> routes to whichever
deployment is active. stop/delete of the ACTIVE deployment requires --force.
  minicloud env set <app> KEY=VALUE      Create or update an env var
  minicloud env delete <app> KEY         Remove an env var or secret entry
  minicloud secret set <app> KEY [value] Store a secret; value is prompted
                                         hidden or read from stdin if piped.
                                         Secrets are encrypted at rest and are
                                         never displayed again.
  minicloud secret delete <app> KEY      Remove a secret
  minicloud limits show <app>            Show CPU/memory limits
  minicloud limits set <app> [--memory MB] [--cpu CPUS]
                                         Set container resource limits
  minicloud limits clear <app>           Remove limits

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

/** Accept a full UUID or an unambiguous 4-12 char prefix; fail clearly otherwise. */
async function deploymentIdArg(raw: string): Promise<string> {
  if (!raw) fail('missing <deployment-id> argument');
  try {
    assertPlausibleId(raw);
    return await resolveDeploymentId(raw);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
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
  const { deployment } = await api.deploy(app.id, { ref: opts.ref });
  console.log(`deploying ${bold(url)} -> deployment ${dim(short(deployment.id))}`);
  const final = await waitForTerminal(deployment.id);
  if (final.status === 'RUNNING') {
    console.log(green(`✔ deployment is RUNNING at ${final.url}`));
  } else {
    console.log(red(`✖ deployment ${final.status}`));
    if (final.failureReason) console.error(`  reason: ${final.failureReason}`);
  const { deployment } = await api.deploy(app.id, { ref: opts.ref });
    process.exit(1);
  }
}

async function cmdLogs(idOrPrefix: string, service?: string): Promise<void> {
  const id = await deploymentIdArg(idOrPrefix);
  const d = await api.getDeployment(id).catch(() => fail(`deployment ${id} not found`));
  const fullId = d.id;
  console.log(dim(`--- logs for ${short(d.id)} (${d.status})${service ? ` service ${service}` : ''} ---`));
  await api.streamLogs(fullId, (line) => console.log(line), service).catch((err) => fail(err instanceof ApiError ? err.message : String(err)));
  // keep the process alive while the stream is open
  setInterval(() => {}, 1 << 30);
}

// ---- application configuration commands ------------------------------------

async function requireAppId(raw: string): Promise<string> {
  if (!raw) fail('missing <app> argument (name, short id or full id)');
  return resolveAppId(raw);
}

/**
 * Secret values are read from an explicit argument only when provided;
 * otherwise from stdin — hidden prompt on a TTY, piped input otherwise.
 * Piped values keep trailing whitespace except one final newline.
 */
async function readSecretValue(explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    const value = chunks.join('').replace(/\r?\n$/, '');
    if (!value) fail('empty secret on stdin');
    return value;
  }
  process.stderr.write('secret value (input hidden, Enter to confirm): ');
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  await new Promise<void>((resolve) => {
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8');
      if (s === '\r' || s === '\n') {
        stdin.off('data', onData);
        process.stderr.write('\n');
        resolve();
      } else if (s === '\u0003') {
        // Ctrl+C
        process.stderr.write('\naborted\n');
        process.exit(130);
      } else if (s === '\u007f' || s === '\b') {
        value = value.slice(0, -1);
      } else {
        value += s;
      }
    };
    stdin.on('data', onData);
  });
  stdin.setRawMode(false);
  stdin.pause();
  if (!value) fail('empty secret value');
  return value;
}

async function cmdEnvList(appArg: string): Promise<void> {
  const cfg = await configApi.listEnv(await requireAppId(appArg));
  console.log(bold('VARIABLES'));
  if (cfg.variables.length === 0) console.log(dim('  (none)'));
  for (const v of cfg.variables) {
    console.log(`  ${cyan(v.key)}=${v.value} ${dim(v.updatedAt.slice(0, 19))}`);
  }
  console.log(bold('SECRETS') + dim('  (values encrypted at rest, never displayed)'));
  if (cfg.secrets.length === 0) console.log(dim('  (none)'));
  for (const s of cfg.secrets) {
    console.log(`  ${yellow(s.key)}=•••••••••• ${dim(s.updatedAt.slice(0, 19))}`);
  }
}

async function cmdLimitsShow(appArg: string): Promise<void> {
  const limits = await configApi.getLimits(await requireAppId(appArg));
  printLimits(limits);
}

function printLimits(limits: LimitsDto): void {
  console.log(
    `memory: ${limits.memoryLimitMb !== null ? bold(`${limits.memoryLimitMb} MB`) : dim('unlimited')}  ` +
      `cpu: ${limits.cpuLimit !== null ? bold(String(limits.cpuLimit)) : dim('unlimited')}`,
  );
}

function parseLimitFlags(flags: Record<string, string>): { memoryLimitMb?: number; cpuLimit?: number } {
  const out: { memoryLimitMb?: number; cpuLimit?: number } = {};
  if (flags.memory !== undefined) {
    const n = Number(flags.memory);
    if (!Number.isInteger(n)) fail(`--memory must be an integer number of MB, got "${flags.memory}"`);
    out.memoryLimitMb = n;
  }
  if (flags.cpu !== undefined) {
    const n = Number(flags.cpu);
    if (Number.isNaN(n)) fail(`--cpu must be a number of CPUs, got "${flags.cpu}"`);
    out.cpuLimit = n;
  }
  if (out.memoryLimitMb === undefined && out.cpuLimit === undefined) {
    fail('nothing to set: pass --memory <MB> and/or --cpu <CPUS>');
  }
  return out;
}

// ---- reliability & observability commands -----------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function cmdEvents(idOrPrefix: string): Promise<void> {
  const id = await deploymentIdArg(idOrPrefix);
  const { events } = await reliabilityApi.events(id);
  if (events.length === 0) return console.log('no events recorded');
  for (const e of events) {
    const time = new Date(e.createdAt).toLocaleTimeString();
    const meta = e.metadata && Object.keys(e.metadata).length > 0 ? dim(` ${JSON.stringify(e.metadata)}`) : '';
    console.log(`${dim(time)}  ${cyan(e.type.padEnd(24))} ${e.message}${meta}`);
  }
}

function printStats(m: {
  status: string;
  restartCount: number;
  autoRestartCount: number;
  startedAt: string | null;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
}): void {
  const mem = `${formatBytes(m.memoryUsedBytes)} / ${m.memoryLimitBytes > 0 ? formatBytes(m.memoryLimitBytes) : 'unlimited'}`;
  console.log(`CPU        ${m.cpuPercent.toFixed(1)}%`);
  console.log(`Memory     ${mem}${m.memoryLimitBytes > 0 ? ` (${m.memoryPercent.toFixed(1)}%)` : ''}`);
  console.log(`Uptime     ${formatUptime(m.startedAt)}`);
  console.log(`Restarts   ${m.restartCount}${m.autoRestartCount > 0 ? ` (${m.autoRestartCount} automatic)` : ''}`);
  console.log(`Status     ${statusColor(m.status)}`);
}

async function cmdStats(idOrPrefix: string, watch: boolean, service?: string): Promise<void> {
  const id = await deploymentIdArg(idOrPrefix);
  const render = async (): Promise<void> => {
    const m = await reliabilityApi.metrics(id, service);
    if (watch) process.stdout.write('\x1b[2J\x1b[H');
    printStats(m);
  };
  await render();
  if (!watch) return;
  console.log(dim('(watching, Ctrl+C to stop)'));
  const timer = setInterval(() => void render().catch(() => {}), 2000);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
}

async function cmdRollback(appArg: string, targetArg: string): Promise<void> {
  if (!appArg || !targetArg) fail('usage: minicloud rollback <app> <deployment-id>');
  const appId = await requireAppId(appArg);
  const targetId = await deploymentIdArg(targetArg);
  const target = await api.getDeployment(targetId);
  if (target.applicationId !== appId) fail('target deployment belongs to a different application');
  const { deployment } = await reliabilityApi.rollback(appId, targetId);
  console.log(`rollback queued: ${short(deployment.id)} (from ${short(targetId)}), waiting…`);
  const d = await waitForTerminal(deployment.id);
  if (d.status === 'RUNNING') console.log(green(`✔ rolled back to ${short(targetId)}: ${d.url}`));
  else {
    console.log(red(`✖ rollback ended in ${d.status}`));
    if (d.failureReason) console.error(`  reason: ${d.failureReason}`);
    process.exit(1);
  }
}

async function cmdRestartPolicy(appArg: string, policyArg?: string, maxArg?: string): Promise<void> {
  const appId = await requireAppId(appArg);
  if (!policyArg || policyArg === 'show') {
    const p = await reliabilityApi.getRestartPolicy(appId);
    console.log(`policy: ${bold(p.policy)}   max restart attempts: ${bold(String(p.maxRestartAttempts))}`);
    return;
  }
  const normalized = policyArg === 'on' ? 'on-failure' : policyArg === 'off' ? 'disabled' : policyArg;
  if (normalized !== 'on-failure' && normalized !== 'disabled') {
    fail(`unknown policy "${policyArg}" (use disabled or on-failure)`);
  }
  let max: number | undefined;
  if (maxArg !== undefined) {
    max = Number(maxArg);
    if (!Number.isInteger(max) || max < 0 || max > 10) fail('--max must be an integer 0-10');
  }
  const p = await reliabilityApi.setRestartPolicy(appId, normalized, max);
  console.log(`${green('✔')} restart policy: ${bold(p.policy)}, max attempts: ${p.maxRestartAttempts}`);
}

async function cmdPrune(skipConfirm: boolean): Promise<void> {
  if (!skipConfirm) {
    process.stderr.write('Remove stopped MiniCloud containers, unreferenced MiniCloud images and stale workspaces? [y/N] ');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const answer = chunks.join('').trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') return console.log('aborted');
  }
  const r = await reliabilityApi.prune();
  console.log(
    `${green('✔')} pruned: ${r.containersRemoved} container(s), ${r.imagesRemoved} image(s), ${r.workspacesRemoved} workspace(s)`,
  );
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
      console.log(
        bold('NAME'.padEnd(20)) +
        'STATUS'.padEnd(12) +
        'ACTIVE'.padEnd(12) +
        'URL',
      );
      for (const a of apps) {
        const latest = a.latestDeployment;
        const status = latest ? statusColor(latest.status) : dim('—');
        const active = a.activeDeploymentId ? short(a.activeDeploymentId) : dim('—');
        console.log(
          a.name.padEnd(20) +
          status.padEnd(20) +
          String(active).padEnd(12) +
          (a.url ? cyan(a.url) : dim('no route')),
        );
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
      const id = await deploymentIdArg(positional[0] ?? '');
      const d = await api.getDeployment(id).catch(() => fail('deployment not found'));
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
      await cmdLogs(positional[0] ?? '', flags.service);
      return;
    case 'stop': {
      const id = await deploymentIdArg(positional[0] ?? '');
      const d = await api.stop(id, { force: flags.force === 'true' });
      console.log(`${yellow('■')} deployment ${short(d.id)} ${d.status}`);
      return;
    }
    case 'restart': {
      const id = await deploymentIdArg(positional[0] ?? '');
      console.log('restarting…');
      const d = await waitForTerminal((await api.restart(id)).id);
      if (d.status === 'RUNNING') console.log(green(`✔ restarted: ${d.url}`));
      else {
        console.log(red(`✖ restart ended in ${d.status}`));
        if (d.failureReason) console.error(`  reason: ${d.failureReason}`);
        process.exit(1);
      }
      return;
    }
    case 'delete': {
      const id = await deploymentIdArg(positional[0] ?? '');
      await api.deleteDeployment(id, { force: flags.force === 'true' });
      console.log(`deleted deployment ${short(id)}`);
      return;
    }
    case 'wait': {
      const id = await deploymentIdArg(positional[0] ?? '');
      const d = await waitForTerminal(id);
      console.log(`${d.status}${d.url ? ` ${d.url}` : ''}`);
      return;
    }
    case 'env': {
      const sub = positional[0];
      const isListWord = sub === undefined || sub === 'list' || sub === 'ls';
      if (isListWord) {
        await cmdEnvList(positional[1] ?? '');
      } else if (sub === 'set') {
        const appId = await requireAppId(positional[1] ?? '');
        const kv = positional[2] ?? '';
        const eq = kv.indexOf('=');
        if (eq <= 0) fail('expected KEY=VALUE, e.g.: minicloud env set my-app LOG_LEVEL=debug');
        await configApi.setEnvVar(appId, kv.slice(0, eq), kv.slice(eq + 1));
        console.log(`${green('✔')} set ${cyan(kv.slice(0, eq))} (applied on next deploy/restart)`);
      } else if (sub === 'delete' || sub === 'rm') {
        const appId = await requireAppId(positional[1] ?? '');
        const key = positional[2];
        if (!key) fail('missing KEY argument');
        await configApi.deleteKey(appId, key);
        console.log(`${green('✔')} deleted ${key}`);
      } else {
        // Not a subcommand: `env <app>` lists that app's configuration.
        await cmdEnvList(sub);
      }
      return;
    }
    case 'secret': {
      const sub = positional[0];
      if (sub === 'set') {
        const appId = await requireAppId(positional[1] ?? '');
        const key = positional[2];
        if (!key) fail('missing KEY argument, e.g.: minicloud secret set my-app API_TOKEN');
        const value = await readSecretValue(positional[3]);
        await configApi.setSecret(appId, key, value);
        console.log(`${green('✔')} secret ${yellow(key)} stored (encrypted at rest; applied on next deploy/restart)`);
      } else if (sub === 'delete' || sub === 'rm') {
        const appId = await requireAppId(positional[1] ?? '');
        const key = positional[2];
        if (!key) fail('missing KEY argument');
        await configApi.deleteSecret(appId, key);
        console.log(`${green('✔')} secret ${key} deleted`);
      } else {
        fail(`unknown secret subcommand "${sub}" (secrets are write-only: use set or delete; "env <app>" lists keys)`);
      }
      return;
    }
    case 'limits': {
      const sub = positional[0];
      if (!sub || sub === 'show') {
        await cmdLimitsShow(positional[1] ?? '');
      } else if (sub === 'set') {
        const appId = await requireAppId(positional[1] ?? '');
        const limits = parseLimitFlags(flags);
        printLimits(await configApi.setLimits(appId, limits));
        console.log(dim('(applied on next deploy/restart)'));
      } else if (sub === 'clear' || sub === 'delete' || sub === 'rm') {
        const appId = await requireAppId(positional[1] ?? '');
        printLimits(await configApi.clearLimits(appId));
      } else {
        fail(`unknown limits subcommand "${sub}" (use show, set, clear)`);
      }
      return;
    }
    case 'events':
      await cmdEvents(positional[0] ?? '');
      return;
    case 'stats':
      await cmdStats(positional[0] ?? '', flags.watch === 'true', flags.service);
      return;
    case 'rollback':
      await cmdRollback(positional[0] ?? '', positional[1] ?? '');
      return;
    case 'restart-policy':
      await cmdRestartPolicy(positional[0] ?? '', positional[1], flags.max);
      return;
    case 'prune':
      await cmdPrune(flags.yes === 'true');
      return;
    case 'services': {
      const appId = await requireAppId(positional[0] ?? '');
      const app = (await api.listApps()).find((a) => a.id === appId);
      const latest = app?.latestDeployment;
      if (!latest) fail('application has no deployments');
      const { services } = await reliabilityApi.getServices(latest.id);
      console.log(bold('SERVICE'.padEnd(14)) + 'STATUS'.padEnd(12) + 'VISIBILITY'.padEnd(12) + 'PORT'.padEnd(8) + 'RESTARTS');
      for (const svc of services) {
        console.log(
          svc.service.padEnd(14) +
          statusColor(svc.status).padEnd(20) +
          (svc.public ? 'public' : 'private').padEnd(12) +
          String(svc.hostPort ?? '—').padEnd(8) +
          String(svc.restartCount),
        );
      }
      return;
    }
    case 'volumes': {
      const appId = await requireAppId(positional[0] ?? '');
      const { volumes } = await reliabilityApi.getVolumes(appId);
      if (volumes.length === 0) return console.log('no volumes');
      for (const v of volumes) {
        console.log(`${cyan(v.name).padEnd(24)} ${dim(v.dockerVolume)}  created ${v.createdAt.slice(0, 19)}  ${dim('(persists across deploys; NOT deleted with the app unless forced)')}`);
      }
      return;
    }
    case 'git-status': {
      const appId = await requireAppId(positional[0] ?? '');
      const a = (await api.listApps()).find((x) => x.id === appId);
      if (!a) fail('application not found');
      const ago = a.lastGitCheck ? `${Math.round((Date.now() - new Date(a.lastGitCheck).getTime()) / 1000)}s ago` : 'never';
      console.log(`Repository       ${a.repositoryUrl}`);
      console.log(`Branch           ${a.gitBranch}`);
      console.log(`Auto deploy      ${a.autoDeploy ? 'enabled' : 'disabled'}`);
      console.log(`Latest commit    ${a.lastObservedSha?.slice(0, 12) ?? '\u2014'}`);
      console.log(`Deployed commit  ${a.lastDeployedSha?.slice(0, 12) ?? '\u2014'}`);
      console.log(`Last checked     ${ago}`);
      return;
    }
    case 'sync': {
      const appId = await requireAppId(positional[0] ?? '');
      const result = await reliabilityApi.sync(appId);
      if (result.upToDate) console.log(`${green('\u2714')} already up to date (${result.sha?.slice(0, 12)})`);
      else if (result.deploymentId) console.log(`${green('\u2714')} sync queued deployment for ${result.sha?.slice(0, 12)}`);
      else console.log(dim(result.message ?? 'nothing to do'));
      return;
    }
    case 'auto-deploy': {
      const appId = await requireAppId(positional[0] ?? '');
      const setting = positional[1];
      if (!setting || setting === 'show') {
        const a = (await api.listApps()).find((x) => x.id === appId);
        console.log(`auto deploy: ${a?.autoDeploy ? 'enabled' : 'disabled'}`);
        return;
      }
      const on = setting === 'on' || setting === 'enabled';
      const off = setting === 'off' || setting === 'disabled';
      if (!on && !off) fail('use on or off');
      await reliabilityApi.setGitConfig(appId, { autoDeploy: on });
      console.log(`${green('\u2714')} auto-deploy ${on ? 'enabled' : 'disabled'}`);
      return;
    }
    case 'routes': {
      const { gatewayPort, routes } = await reliabilityApi.routes();
      if (routes.length === 0) return console.log('no routes (no application has an active deployment)');
      console.log(bold(`GATEWAY :${gatewayPort}`));
      for (const r of routes) {
        const s2 = r.stats;
        console.log(
          cyan(r.url.padEnd(46)) +
          short(r.deploymentId).padEnd(12) +
          dim(`reqs ${s2.requests} · active ${s2.active} · 2xx ${s2.ok2xx} · 4xx ${s2.client4xx} · 5xx ${s2.server5xx}`),
        );
      }
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
