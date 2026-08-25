// Unit tests for minicloud.yml parsing/validation (no Docker needed).
import { describe, it, expect } from 'vitest';
import { parseManifest, ManifestError, topoSort } from './manifest.js';

const valid = `
version: 1
services:
  web:
    dockerfile: web/Dockerfile
    context: web
    port: 3000
    public: true
    depends_on:
      - api
  api:
    dockerfile: api/Dockerfile
    context: api
    port: 4000
    public: false
    resources:
      memory_mb: 128
      cpus: 0.25
    volumes:
      - data:/data
  worker:
    dockerfile: worker/Dockerfile
    context: worker
    public: false
    restart: on-failure
    max_restart_attempts: 2
    depends_on:
      - api
volumes:
  data:
    driver: local
`;

describe('parseManifest', () => {
  it('accepts a valid manifest and computes start order', () => {
    const { manifest } = parseManifest(valid);
    expect(manifest.version).toBe(1);
    expect(manifest.services).toHaveLength(3);
    expect(manifest.startOrder.indexOf('api')).toBeLessThan(manifest.startOrder.indexOf('web'));
    expect(manifest.startOrder.indexOf('api')).toBeLessThan(manifest.startOrder.indexOf('worker'));
    const api = manifest.services.find((s) => s.name === 'api')!;
    expect(api.resources?.memoryLimitMb).toBe(128);
    expect(api.volumes).toEqual(['data:/data']);
  });

  it('rejects dependency cycles with the cycle path', () => {
    const cyc = `
version: 1
services:
  a: { dockerfile: a/Dockerfile, public: true, port: 80, depends_on: [b] }
  b: { dockerfile: b/Dockerfile, depends_on: [c] }
  c: { dockerfile: c/Dockerfile, depends_on: [a] }
`;
    expect(() => parseManifest(cyc)).toThrow(/dependency cycle|services\.a\.depends_on/);
  });

  it('rejects unknown dependencies and self-dependencies', () => {
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80, depends_on: [ghost] }'))
      .toThrow(/depends_on|unknown service/i);
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80, depends_on: [a] }'))
      .toThrow(/depends on itself/);
  });

  it('rejects path traversal in dockerfile/context', () => {
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: ../../etc/passwd, public: true, port: 80 }'))
      .toThrow(/traverse|relative/);
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: /etc/passwd, public: true, port: 80 }'))
      .toThrow(/repository-relative/);
  });

  it('rejects undeclared volume mounts and invalid mount shapes', () => {
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80, volumes: ["nope:/data"] }'))
      .toThrow(/undeclared volume|volumes:/);
    expect(() => parseManifest('version: 1\nvolumes:\n  data:\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80, volumes: ["data:relative/path"] }'))
      .toThrow(/volume mount/);
  });

  it('requires a public service and a port on it', () => {
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: false }'))
      .toThrow(/at least one service must be public|services\.a/);
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true }'))
      .toThrow(/must declare a port/);
  });

  it('rejects unknown fields, bad service names and invalid ports', () => {
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80, privileged: true }'))
      .toThrow(/Unrecognized key/);
    expect(() => parseManifest('version: 1\nservices:\n  Bad_Name: { dockerfile: a/Dockerfile, public: true, port: 80 }'))
      .toThrow(/service name/);
    expect(() => parseManifest('version: 1\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 99999 }'))
      .toThrow(/port/);
    expect(() => parseManifest('version: 2\nservices:\n  a: { dockerfile: a/Dockerfile, public: true, port: 80 }'))
      .toThrow();
  });

  it('topoSort orders dependencies first', () => {
    expect(topoSort({ web: ['api'], api: [], worker: ['api'] })).toEqual(['api', 'web', 'worker']);
  });
});
