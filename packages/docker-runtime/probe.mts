import { DockerRuntime } from '@minicloud/docker-runtime';
import path from 'node:path';
const rt = new DockerRuntime();
const ctx = path.resolve(process.cwd(), 'examples/hello-node');
console.log('build');
const t = Date.now();
await Promise.race([
  rt.build({ contextDir: ctx, tag: 'probe-fast:latest', onOutput: () => process.stdout.write('.') }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('HANG 90s')), 90000)),
]);
console.log(` ok ${Date.now() - t}ms`);
process.exit(0);
