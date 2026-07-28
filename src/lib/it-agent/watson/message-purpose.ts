// ============================================================
// Watson — 017 : Employee message purpose classification
// ------------------------------------------------------------
// WHY THIS EXISTS
// Before 017 every employee message was fed back through the global issue
// classifier. An answer to an evidence question therefore competed with the
// original statement for family selection, and a sync case answered with
// "yes, I have markups that have not synced yet" silently became a Tool Chest
// case — discarding the evidence already collected and restarting a different
// question tree.
//
// The fix is to stop treating all employee text as the same kind of input. A
// message is classified by PURPOSE first, and only an explicit correction may
// change the issue family.
//
// Pure module: no network, no I/O.
// ============================================================

export type MessagePurpose =
  | 'evidence_answer'      // answering the question Watson just asked
  | 'explicit_correction'  // "that's not the problem, it's actually X"
  | 'ambiguous_correction' // hedged — ask one clarification, never reclassify
  | 'new_issue'            // a genuinely separate problem
  | 'technician_request'   // explicit request for a human
  | 'followup';            // ordinary remark

// Deliberately narrow. A correction must be unmistakable: hedged speculation
// ("maybe it's my profile") is NOT a correction, because acting on it would
// reintroduce exactly the silent-drift defect this module exists to prevent.
const EXPLICIT_CORRECTION = [
  /\bthat(?:'s| is) not (?:the|my) (?:problem|issue)\b/i,
  /\bthat(?:'s| is)n(?:'|o)t (?:it|right)\b/i,
  /\bwrong (?:issue|problem|type)\b/i,
  /\bi (?:selected|picked|chose) the wrong\b/i,
  /\bthe real (?:issue|problem) is\b/i,
  /\bthis is actually\b/i,
  /\bit(?:'s| is) actually\b/i,
  /\bchange (?:the )?issue type\b/i
];

// Hedges that turn an apparent correction into a question.
const HEDGE = /\b(maybe|might|could (?:this|it) be|perhaps|possibly|not sure|i wonder|i think it might)\b/i;

const NEW_ISSUE = [
  /\b(?:i )?also have (?:a )?(?:separate|another|different)\b/i,
  /\bseparate (?:problem|issue)\b/i,
  /\banother (?:problem|issue)\b/i,
  /\bdifferent (?:problem|issue)\b/i,
  /\bunrelated (?:problem|issue)\b/i,
  /\bnew issue\b/i
];

// Explicit only. "someone" used to appear here and fired on the evidence answer
// "someone else has the file open", escalating mid-diagnosis.
const TECHNICIAN = [
  /\btechnician\b/i,
  /\bspeak to (?:a )?(?:human|person|someone)\b/i,
  /\btalk to (?:a )?(?:human|person)\b/i,
  /\bescalate\b/i,
  /\breal person\b/i
];

export interface PurposeContext {
  // True when Watson has an outstanding evidence question.
  awaitingEvidence: boolean;
  // True when the answer parses within the ACTIVE family.
  answerInterpretable: boolean;
}

export function classifyMessagePurpose(text: string, ctx: PurposeContext): MessagePurpose {
  const t = String(text ?? '');

  // An explicit correction outranks everything except finality, which the
  // caller checks first. It must be unhedged.
  const looksLikeCorrection = EXPLICIT_CORRECTION.some((r) => r.test(t));
  if (looksLikeCorrection) return HEDGE.test(t) ? 'ambiguous_correction' : 'explicit_correction';

  // A hedged guess at a different cause is a question, never a reclassification.
  if (HEDGE.test(t) && /\b(profile|licen[cs]|onedrive|sync|tool ?chest|studio|print|scale|measurement)\b/i.test(t)) {
    return 'ambiguous_correction';
  }

  if (NEW_ISSUE.some((r) => r.test(t))) return 'new_issue';

  // A pending, interpretable answer is evidence — checked BEFORE the technician
  // phrases so a legitimate answer is never mistaken for an escalation request.
  if (ctx.awaitingEvidence && ctx.answerInterpretable) return 'evidence_answer';

  if (TECHNICIAN.some((r) => r.test(t))) return 'technician_request';

  if (ctx.awaitingEvidence) return 'evidence_answer'; // uninterpretable -> re-ask
  return 'followup';
}

// The family the employee named in an explicit correction, or null when they
// only said "that's wrong" without saying what it actually is.
export function correctionTargetText(text: string): string | null {
  const t = String(text ?? '');
  for (const r of [
    /\bthe real (?:issue|problem) is\s+(.+)$/i,
    /\bthis is actually\s+(.+)$/i,
    /\bit(?:'s| is) actually\s+(.+)$/i,
    /\bthat(?:'s| is) not (?:the|my) (?:problem|issue)[.,]?\s*(.+)$/i
  ]) {
    const m = t.match(r);
    if (m && m[1] && m[1].trim().length > 2) return m[1].trim();
  }
  return null;
}
