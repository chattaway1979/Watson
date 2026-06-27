// ============================================================
// Watson — H&R AI IT Agent : Deterministic Triage Classifier
// ------------------------------------------------------------
// Keyword-based, explainable classification. No network, no key.
// Returns a category, a recommended priority, and confidence.
// ============================================================
import type { TicketCategory, Priority } from './types';

interface Rule {
  category: TicketCategory;
  keywords: string[];
  priority: Priority;
}

// Order matters: earlier rules win ties. Security first (highest stakes).
const RULES: Rule[] = [
  { category: 'security', priority: 'urgent', keywords: ['lost laptop', 'stolen', 'lost phone', 'compromise', 'compromised', 'phishing', 'hacked', 'malware', 'ransomware', 'suspicious email', 'breach'] },
  { category: 'offboarding', priority: 'high', keywords: ['offboard', 'offboarding', 'terminated', 'termination', 'disable access', 'leaving', 'last day', 'resign'] },
  { category: 'onboarding', priority: 'normal', keywords: ['onboard', 'onboarding', 'new employee', 'new hire', 'new starter', 'start date', 'set up new'] },
  { category: 'password_mfa', priority: 'high', keywords: ['mfa', 'authenticator', 'login code', 'verification code', 'password', 'locked out', 'lockout', "can't login", 'cant login', 'cannot login', 'cannot log in', 'reset my password', 'forgot password', '2fa', 'two factor'] },
  { category: 'teams', priority: 'normal', keywords: ['teams', 'camera', 'mic', 'microphone', 'meeting', 'video call', 'cant hear', "can't hear", 'no audio'] },
  { category: 'onedrive', priority: 'normal', keywords: ['onedrive', 'sync', 'syncing', 'one drive'] },
  { category: 'sharepoint_access', priority: 'normal', keywords: ['sharepoint', 'share point', 'site access', 'project folder', 'access denied'] },
  { category: 'outlook', priority: 'normal', keywords: ['outlook', 'email not working', 'mail', 'inbox', 'cant send', "can't send", 'not receiving email', 'mailbox full'] },
  { category: 'email_setup', priority: 'normal', keywords: ['email setup', 'set up email', 'configure email', 'signature', 'add my email'] },
  { category: 'printer', priority: 'normal', keywords: ['printer', 'print', 'printing', 'scanner', 'scan', 'paper jam'] },
  { category: 'network', priority: 'high', keywords: ['wifi', 'wi-fi', 'network', 'internet', 'vpn', 'no connection', 'offline', 'cant connect', "can't connect"] },
  { category: 'device_slow', priority: 'normal', keywords: ['slow', 'freezing', 'freeze', 'lagging', 'lag', 'hanging', 'unresponsive', 'spinning'] },
  { category: 'software_install', priority: 'normal', keywords: ['install', 'software', 'app', 'application', 'download program', 'license for'] },
  { category: 'device_access', priority: 'high', keywords: ['cant access my computer', 'locked computer', 'device access', 'cannot unlock', 'pin not working'] }
];

export interface ClassifyResult {
  category: TicketCategory;
  priority: Priority;
  confidence: number;
  matchedKeywords: string[];
}

export function classifyIssue(text: string): ClassifyResult {
  const t = (text || '').toLowerCase();
  let best: { rule: Rule; hits: string[] } | null = null;

  for (const rule of RULES) {
    const hits = rule.keywords.filter((k) => t.includes(k));
    if (hits.length === 0) continue;
    if (!best || hits.length > best.hits.length) {
      best = { rule, hits };
    }
  }

  if (!best) {
    return { category: 'other', priority: 'normal', confidence: 0.3, matchedKeywords: [] };
  }

  // Confidence scales with number of matched keywords (capped).
  const confidence = Math.min(0.95, 0.55 + best.hits.length * 0.12);

  // Urgency bump: explicit "urgent"/"asap"/"down"/"can't work" raises priority.
  let priority = best.rule.priority;
  if (/\b(urgent|asap|emergency|cannot work|can't work|down|everyone)\b/.test(t)) {
    priority = bump(priority);
  }

  return { category: best.rule.category, priority, confidence, matchedKeywords: best.hits };
}

function bump(p: Priority): Priority {
  const order: Priority[] = ['low', 'normal', 'high', 'urgent'];
  const i = order.indexOf(p);
  return order[Math.min(order.length - 1, i + 1)];
}
