import { useEffect, useRef, useState } from 'react';

interface Props {
  deploymentId: string;
}

interface LogEntry {
  source: string;
  message: string;
}

/** Live log stream over SSE from the MiniCloud API. */
export default function LogStream({ deploymentId }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([]);
    setConnected(false);
    const ctrl = new AbortController();
    fetch(`/api/deployments/${deploymentId}/logs`, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.body) throw new Error('no stream');
        setConnected(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const evt = JSON.parse(line.slice(6));
                  setLogs((prev) => [...prev.slice(-500), evt]);
                } catch { /* ignore */ }
              }
            }
          }
        };
        void pump().catch(() => setConnected(false));
      })
      .catch(() => setConnected(false));
    return () => ctrl.abort();
  }, [deploymentId]);

  useEffect(() => {
    if (autoscroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logs, autoscroll]);

  return (
    <div className="logstream">
      <div className="logstream-bar">
        <span className={connected ? 'live' : 'dead'}>
          {connected ? '● live' : '○ disconnected'}
        </span>
        <label>
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          autoscroll
        </label>
        <button onClick={() => setLogs([])}>clear</button>
      </div>
      <div className="logstream-box" ref={boxRef}>
        {logs.length === 0 && <div className="log-empty">No output yet…</div>}
        {logs.map((l, i) => (
          <div key={i} className={`log-line log-${l.source}`}>
            {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
