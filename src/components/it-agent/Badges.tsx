import { STATUS_LABELS, PRIORITY_LABELS, RISK_LABELS, CATEGORY_LABELS } from '@/lib/it-agent/constants';

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-slate-100 text-slate-700 border-slate-200',
  triaged: 'bg-sky-100 text-sky-800 border-sky-200',
  waiting_on_employee: 'bg-amber-100 text-amber-800 border-amber-200',
  waiting_on_admin: 'bg-amber-100 text-amber-800 border-amber-200',
  approval_required: 'bg-purple-100 text-purple-800 border-purple-200',
  in_progress: 'bg-blue-100 text-blue-800 border-blue-200',
  resolved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  closed: 'bg-slate-200 text-slate-600 border-slate-300',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200'
};
const PRIORITY_STYLES: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  normal: 'bg-sky-100 text-sky-800 border-sky-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  urgent: 'bg-red-100 text-red-800 border-red-200'
};
const RISK_STYLES: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  high: 'bg-orange-100 text-orange-800 border-orange-200',
  critical: 'bg-red-100 text-red-800 border-red-200'
};

function Pill({ text, cls }: { text: string; cls: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Pill text={STATUS_LABELS[status] ?? status} cls={STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700 border-slate-200'} />;
}
export function PriorityBadge({ priority }: { priority: string }) {
  return <Pill text={PRIORITY_LABELS[priority] ?? priority} cls={PRIORITY_STYLES[priority] ?? 'bg-slate-100'} />;
}
export function RiskBadge({ risk }: { risk: string }) {
  return <Pill text={RISK_LABELS[risk] ?? risk} cls={RISK_STYLES[risk] ?? 'bg-slate-100'} />;
}
export function CategoryBadge({ category }: { category: string }) {
  return <Pill text={CATEGORY_LABELS[category] ?? category} cls="bg-watson-accentSoft text-watson-accent border-blue-200" />;
}
