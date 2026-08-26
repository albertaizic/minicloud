import { useCallback, useEffect, useState } from 'react';
import { api, configApi, type AppConfigDto, type LimitsDto } from '../api.js';

/**
 * Per-application configuration editor: plain env vars (readable), secrets
 * (write-only — the API never returns values), and container resource limits.
 * Changes apply to new deployments and restarts of existing ones.
 */
export default function ConfigPanel({ appId }: { appId: string }) {
  const [cfg, setCfg] = useState<AppConfigDto | null>(null);
  const [limits, setLimits] = useState<LimitsDto | null>(null);
  const [error, setError] = useState('');

  // forms
  const [varKey, setVarKey] = useState('');
  const [varValue, setVarValue] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [memLimit, setMemLimit] = useState('');
  const [cpuLimit, setCpuLimit] = useState('');

  const load = useCallback(() => {
    configApi.listEnv(appId).then(setCfg).catch((e) => setError(e.message));
    api.getApp(appId).then((a) => {
      setLimits((a as unknown as { limits: LimitsDto }).limits);
    }).catch(() => {});
  }, [appId]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, successMessage: string) => {
    setError('');
    try {
      await fn();
      load();
      return successMessage;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  if (!cfg && !error) return <p className="dim">Loading configuration…</p>;

  return (
    <div>
      {error && <p className="error">{error}</p>}

      <h3>Environment variables</h3>
      <table className="table">
        <thead>
          <tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr>
        </thead>
        <tbody>
          {cfg!.variables.length === 0 && (
            <tr><td colSpan={4} className="dim">none</td></tr>
          )}
          {cfg!.variables.map((v) => (
            <tr key={v.key}>
              <td className="mono">{v.key}</td>
              <td className="mono">{v.value}</td>
              <td className="dim">{new Date(v.updatedAt).toLocaleString()}</td>
              <td><button onClick={() => void act(() => configApi.deleteEnvKey(appId, v.key), '')}>delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!varKey.trim()) return;
          void act(() => configApi.setEnvVar(appId, varKey.trim(), varValue), '').then(() => {
            setVarKey('');
            setVarValue('');
          });
        }}
      >
        <input placeholder="KEY" value={varKey} onChange={(e) => setVarKey(e.target.value)} className="mono" />
        <input placeholder="value" value={varValue} onChange={(e) => setVarValue(e.target.value)} className="mono" />
        <button type="submit" className="primary">Set variable</button>
      </form>

      <h3>Secrets</h3>
      <p className="dim">
        Encrypted at rest (AES-256-GCM) and injected into containers at start.
        Values are write-only: they can be replaced or deleted but never read back
        through the dashboard, CLI or API.
      </p>
      <table className="table">
        <thead>
          <tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr>
        </thead>
        <tbody>
          {cfg!.secrets.length === 0 && (
            <tr><td colSpan={4} className="dim">none</td></tr>
          )}
          {cfg!.secrets.map((s) => (
            <tr key={s.key}>
              <td className="mono">{s.key}</td>
              <td className="mono dim">••••••••</td>
              <td className="dim">{new Date(s.updatedAt).toLocaleString()}</td>
              <td><button onClick={() => void act(() => configApi.deleteSecret(appId, s.key), '')}>delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!secretKey.trim() || !secretValue) return;
          void act(() => configApi.setSecret(appId, secretKey.trim(), secretValue), '').then(() => {
            setSecretKey('');
            setSecretValue('');
          });
        }}
      >
        <input placeholder="KEY" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className="mono" />
        <input
          type="password"
          placeholder="secret value"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          className="mono"
          autoComplete="off"
        />
        <button type="submit" className="primary">Store secret</button>
      </form>

      <h3>Resource limits</h3>
      <p className="dim">
        Applied by Docker to the app's containers: hard memory cap and CPU quota
        (--cpus). Changes take effect on the next deploy or restart.
        Memory {limits?.memoryLimitMb ?? '—'} MB · CPU {limits?.cpuLimit ?? '—'}
      </p>
      <form
        className="actions"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const payload: { memoryLimitMb?: number; cpuLimit?: number } = {};
          if (memLimit !== '') payload.memoryLimitMb = Number(memLimit);
          if (cpuLimit !== '') payload.cpuLimit = Number(cpuLimit);
          void act(() => configApi.setLimits(appId, payload), '');
        }}
      >
        <input
          type="number"
          min={16}
          max={65536}
          placeholder="memory MB (16–65536)"
          value={memLimit}
          onChange={(e) => setMemLimit(e.target.value)}
        />
        <input
          type="number"
          min={0.1}
          max={64}
          step={0.1}
          placeholder="CPUs (0.1–64)"
          value={cpuLimit}
          onChange={(e) => setCpuLimit(e.target.value)}
        />
        <button type="submit" className="primary">Save limits</button>
        <button type="button" onClick={() => void act(() => configApi.clearLimits(appId), '').then(() => { setMemLimit(''); setCpuLimit(''); })}>
          Clear
        </button>
      </form>
    </div>
  );
}
