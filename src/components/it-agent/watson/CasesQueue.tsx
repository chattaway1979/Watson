'use client';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface QueueRow {
  caseId: string; shortId: string; employee: string; device: string; platform: string;
  summary: string; state: string; confidence: string | null; priority: string;
  expectedResponse: string | null; estimatedRepair: string | null; queue: string | null; approvalRequired: boolean;
}

export function CasesQueue() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    api<QueueRow[]>('/api/it-agent/cases').then((r) => { if (r.ok) setRows(r.data); else setDenied(true); });
  }, []);

  if (denied) {
    return <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">The support queue requires an <b>administrator</b>. Enforced by the backend.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-watson-line bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-watson-mist">
          <tr>
            <th className="p-2">Priority</th><th className="p-2">Case</th><th className="p-2">Employee</th>
            <th className="p-2">Device</th><th className="p-2">Issue</th><th className="p-2">State</th>
            <th className="p-2">Confidence</th><th className="p-2">Response</th><th className="p-2">Repair</th><th className="p-2">Queue</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={10} className="p-4 text-center text-watson-mist">No cases yet.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.caseId} className="border-t border-slate-100">
              <td className="p-2 font-medium">{r.priority}</td>
              <td className="p-2">{r.shortId}</td>
              <td className="p-2">{r.employee}</td>
              <td className="p-2">{r.device} ({r.platform})</td>
              <td className="p-2">{r.summary}</td>
              <td className="p-2">{r.state}</td>
              <td className="p-2">{r.confidence ?? '—'}</td>
              <td className="p-2">{r.expectedResponse ?? '—'}</td>
              <td className="p-2">{r.estimatedRepair ?? '—'}</td>
              <td className="p-2">{r.queue ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
