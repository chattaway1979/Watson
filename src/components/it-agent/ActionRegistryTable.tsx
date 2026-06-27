'use client';
import { useEffect, useState } from 'react';
import { RiskBadge } from './Badges';
import { api, getCookieRole } from './api';

interface ActionDef {
  key: string; displayName: string; category: string; description: string; riskLevel: string;
  requiredRole: string; requiresApproval: boolean; mockExecutable: boolean; liveExecutable: boolean;
  execMode: string; connectorTarget: string;
}

export function ActionRegistryTable() {
  const [rows, setRows] = useState<ActionDef[]>([]);
  const [role, setRole] = useState('employee');
  const [runKey, setRunKey] = useState('');
  const [arg, setArg] = useState('carlos.field@hrelectriccompany.com');
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRole(getCookieRole());
    api<ActionDef[]>('/api/it-agent/actions').then((r) => r.ok && setRows(r.data));
  }, []);

  const isAdmin = role === 'admin' || role === 'owner';

  async function run() {
    if (!runKey) return;
    setBusy(true); setOut(null);
    const def = rows.find((r) => r.key === runKey);
    const input: Record<string, unknown> = {};
    if (def) {
      if (def.connectorTarget === 'device_rmm' && !def.key.includes('lookup')) input.deviceId = arg;
      else input.email = arg;
      if (def.key === 'search_knowledge_base') { delete input.email; input.query = arg; }
      if (def.key === 'send_setup_instructions') { delete input.email; input.slug = arg; }
      input.reason = 'Demo invocation via action registry';
    }
    const r = await api(`/api/it-agent/actions/invoke`, { method: 'POST', body: JSON.stringify({ actionKey: runKey, input }) });
    setOut(JSON.stringify(r, null, 2));
    setBusy(false);
  }

  const liveOffenders = rows.filter((r) => r.liveExecutable).length;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
        Live-executable actions in registry: <b>{liveOffenders}</b> (must be 0). Every action runs mock/approval-only in this build.
      </div>

      {isAdmin && (
        <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-watson-ink">Try an action (through the Tool Gateway)</h3>
          <div className="flex flex-wrap gap-2">
            <select value={runKey} onChange={(e) => setRunKey(e.target.value)} className="rounded-lg border border-watson-line px-2 py-2 text-xs">
              <option value="">Select action…</option>
              {rows.map((r) => <option key={r.key} value={r.key}>{r.displayName} ({r.riskLevel})</option>)}
            </select>
            <input value={arg} onChange={(e) => setArg(e.target.value)} className="min-w-[220px] flex-1 rounded-lg border border-watson-line px-3 py-2 text-xs" placeholder="email / deviceId / query / slug" />
            <button onClick={run} disabled={busy || !runKey} className="btn rounded-lg bg-watson-ink px-4 py-2 text-xs font-medium text-white disabled:opacity-50">Invoke</button>
          </div>
          <p className="mt-2 text-[11px] text-watson-mist">High/critical actions return an <b>approval_required</b> outcome (queued, not executed). Safe actions return mock data. Critical actions are also live-blocked.</p>
          {out && <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 text-[11px]">{out}</pre>}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-watson-line bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-watson-bg text-left text-watson-mist">
            <tr>
              <th className="px-3 py-2">Action</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Approval</th><th className="px-3 py-2">Exec mode</th><th className="px-3 py-2">Mock</th><th className="px-3 py-2">Live</th><th className="px-3 py-2">Connector</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.key} className="border-t border-watson-line align-top">
                <td className="px-3 py-2"><div className="font-medium text-watson-ink">{a.displayName}</div><div className="font-mono text-[10px] text-watson-mist">{a.key}</div></td>
                <td className="px-3 py-2"><RiskBadge risk={a.riskLevel} /></td>
                <td className="px-3 py-2">{a.requiredRole}</td>
                <td className="px-3 py-2">{a.requiresApproval ? '✅ required' : '—'}</td>
                <td className="px-3 py-2">{a.execMode}</td>
                <td className="px-3 py-2">{a.mockExecutable ? 'yes' : 'no'}</td>
                <td className="px-3 py-2 font-semibold text-red-600">{a.liveExecutable ? 'YES' : 'disabled'}</td>
                <td className="px-3 py-2">{a.connectorTarget}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
