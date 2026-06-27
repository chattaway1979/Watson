'use client';
import { CATEGORY_LABELS } from '@/lib/it-agent/constants';

const FEATURED: { category: string; prompt: string; icon: string }[] = [
  { category: 'outlook', prompt: 'My Outlook email is not working', icon: '✉️' },
  { category: 'password_mfa', prompt: "I'm locked out / MFA authenticator issue", icon: '🔐' },
  { category: 'teams', prompt: 'Teams camera or microphone not working', icon: '🎥' },
  { category: 'onedrive', prompt: 'OneDrive is not syncing my files', icon: '☁️' },
  { category: 'printer', prompt: 'I cannot print to the office printer', icon: '🖨️' },
  { category: 'device_slow', prompt: 'My computer is very slow and freezing', icon: '🐢' },
  { category: 'network', prompt: 'No internet / Wi-Fi / VPN problem', icon: '📶' },
  { category: 'software_install', prompt: 'I need software installed', icon: '📦' },
  { category: 'security', prompt: 'Lost device / phishing / security concern', icon: '🛡️' }
];

export function IssueCategoryCards({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {FEATURED.map((c) => (
        <button
          key={c.category}
          onClick={() => onPick(c.prompt)}
          className="btn flex flex-col items-start gap-1 rounded-xl border border-watson-line bg-white p-3 text-left shadow-sm transition hover:border-watson-accent hover:shadow"
        >
          <span className="text-xl">{c.icon}</span>
          <span className="text-xs font-medium text-watson-ink">{CATEGORY_LABELS[c.category]}</span>
        </button>
      ))}
    </div>
  );
}
