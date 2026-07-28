// ============================================================
// Watson — 012 : Bluebeam intent detection and next-best-question selection
// ------------------------------------------------------------
// Deterministic. No model call, no network. The classifier is intentionally
// conservative: when the statement does not clearly indicate a family it
// returns null rather than guessing, because guessing the family sends the
// employee down the wrong decision tree and wastes their time.
// ============================================================
import { BLUEBEAM_FAMILIES, type BluebeamFamilyKey, type BluebeamFamily, type DiagnosticBranch } from './families';

// Does this statement concern Bluebeam at all?
export function isBluebeamIntent(text: string): boolean {
  const t = (text ?? '').toLowerCase();

  // STRONG cues: the brand, or vocabulary that exists nowhere else in this
  // business's toolset. These stand on their own.
  if (/\b(bluebeam|revu|blue beam)\b/.test(t)) return true;
  if (/\b(tool ?chest|tool ?set|studio session|studio project|slip.?sheet|takeoff|take.?off|calibrate|calibration)\b/.test(t)) return true;

  // WEAK cues ("markup", "measurement", "scale", "my tools", "studio") are
  // shared with other software and with physical objects. The 014 adversarial
  // review captured "the scale on my Excel chart is wrong", "Word document
  // markup is missing" and "the scale in the warehouse is broken" on these
  // alone. A weak cue is therefore honoured only when nothing else in the
  // sentence has a stronger claim to it.
  const COMPETING_CONTEXT =
    /\b(excel|word|powerpoint|outlook|teams|sharepoint|onedrive|adobe|acrobat|chrome|edge|firefox|browser|spreadsheet|chart|warehouse|weighing|weigh|bathroom|kitchen|apartment)\b/;
  if (COMPETING_CONTEXT.test(t)) return false;

  return /\b(markups?|measurements?)\b/.test(t) ||
    /\bscale\b/.test(t) ||
    /\bmy tools\b/.test(t) ||
    // "Studio" only where it is used the way Bluebeam Studio is used.
    /\bstudio\b.*\b(connect|session|project|join|sign|sync|upload)\b/.test(t) ||
    /\bprofiles?\b.*\b(missing|gone|lost)\b/.test(t) ||
    /\bpdf\b.*(lock|read.?only)/.test(t) ||
    /someone else has .*\bopen\b/.test(t);
}

interface FamilyMatcher {
  key: BluebeamFamilyKey;
  // Every `all` term must appear, or any `any` term must appear.
  any?: RegExp[];
  all?: RegExp[];
  weight: number;
}

// Order matters only for readability; scoring decides. Weights encode how
// diagnostic a phrase is — "will not open" is weaker than "measurements are
// wrong", because the latter can only mean one family.
const MATCHERS: FamilyMatcher[] = [
  { key: 'measurement_scale', any: [/measurement/, /measure/, /\bscale\b/, /calibrat/, /takeoff/, /take.?off/, /dimension/, /length.*(wrong|off|double)/], weight: 5 },
  { key: 'printing_plotting', any: [/\bprint/, /\bplot/, /plotter/, /paper size/, /clipped/, /landscape/, /portrait/, /black and white/, /monochrome/], weight: 5 },
  { key: 'studio', any: [/studio/, /\bsession\b/, /checked out/, /check.?out/, /pending change/], weight: 5 },
  { key: 'markups_toolchest', any: [/tool chest/, /toolchest/, /tool ?set/, /markup/, /\bstamp/, /my tools/, /legend/, /custom column/], weight: 5 },
  { key: 'ocr_search_overlay', any: [/\bocr\b/, /text search/, /search.*(drawing|sheet|pdf)/, /overlay/, /slip.?sheet/, /hyperlink/, /compare document/], weight: 5 },
  { key: 'file_sync_locking', any: [/read.?only/, /locked/, /someone else has/, /conflicting copy/, /sync/, /sharepoint/, /onedrive/, /checked out/], weight: 4 },
  { key: 'signin_licensing', any: [/licen[cs]/, /sign.?in/, /log.?in/, /activation/, /entitlement/, /demo mode/, /trial.*expire/, /expired/], weight: 4 },
  { key: 'pdf_rendering', any: [/blank/, /missing (content|linework|text)/, /wont open|will not open|won.t open/, /corrupt/, /render/, /font/], weight: 3 },
  { key: 'profiles_settings', any: [/settings.*(gone|lost|reset|chang)/, /profiles?.*(gone|lost|corrupt|missing)/, /workspace.*(gone|reset)/, /forgotten.*settings/], weight: 6 },
  { key: 'launch_stability', any: [/(will not|won.t|wont|cannot|can.t) open/, /crash/, /freez/, /not responding/, /unresponsive/, /slow/, /hang/, /lock(ed)? up/], weight: 3 }
];

export interface BluebeamClassification {
  family: BluebeamFamilyKey | null;
  confidenceHint: 'strong' | 'weak' | 'none';
  // Families that also matched; used to ask a disambiguating question rather
  // than silently picking the top score.
  alternatives: BluebeamFamilyKey[];
}

export function classifyBluebeam(text: string): BluebeamClassification {
  const t = (text ?? '').toLowerCase();
  const scores = new Map<BluebeamFamilyKey, number>();

  for (const m of MATCHERS) {
    let hit = false;
    if (m.any && m.any.some((r) => r.test(t))) hit = true;
    if (m.all && m.all.every((r) => r.test(t))) hit = true;
    if (hit) scores.set(m.key, (scores.get(m.key) ?? 0) + m.weight);
  }

  if (scores.size === 0) return { family: null, confidenceHint: 'none', alternatives: [] };

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topKey, topScore] = ranked[0];
  const alternatives = ranked.slice(1).filter(([, s]) => s >= topScore - 1).map(([k]) => k);

  // A clear winner is "strong"; a tie means we matched several families and
  // should disambiguate rather than assume.
  const confidenceHint = alternatives.length === 0 && topScore >= 4 ? 'strong' : 'weak';
  return { family: topKey, confidenceHint, alternatives };
}

// ------------------------------------------------------------
// Next-best question.
//
// Watson asks exactly ONE question per turn and never re-asks something already
// answered. Branch order within a family is the diagnostic order — the earlier
// branches split the search space fastest.
// ------------------------------------------------------------
export interface NextQuestion {
  question: string;
  evidenceKey: string;
  familyKey: BluebeamFamilyKey;
  // Remaining unanswered branches, so callers can show progress honestly.
  remaining: number;
}

export function nextBestQuestion(
  familyKey: BluebeamFamilyKey,
  known: Record<string, unknown>
): NextQuestion | null {
  const family: BluebeamFamily = BLUEBEAM_FAMILIES[familyKey];
  const unanswered = family.branches.filter((b: DiagnosticBranch) => !(b.evidenceKey in (known ?? {})));
  if (unanswered.length === 0) return null;
  const b = unanswered[0];
  return {
    question: b.question,
    evidenceKey: b.evidenceKey,
    familyKey,
    remaining: unanswered.length
  };
}

// Has enough evidence been gathered to propose anything at all?
export function hasMinimumEvidence(familyKey: BluebeamFamilyKey, known: Record<string, unknown>): boolean {
  const family = BLUEBEAM_FAMILIES[familyKey];
  // Minimum evidence is expressed as branch coverage: every branch that can
  // change the cause must have been answered.
  return family.branches.every((b) => b.evidenceKey in (known ?? {}));
}

// A disambiguating question when two families tie. Asking this is strictly
// better than picking one and walking the wrong tree.
export function disambiguationQuestion(c: BluebeamClassification): string | null {
  if (!c.family || c.alternatives.length === 0) return null;
  const labels = [c.family, ...c.alternatives].map((k) => BLUEBEAM_FAMILIES[k].label);
  return `I want to be sure I am looking at the right thing. Is this closer to "${labels[0]}" or "${labels[1]}"?`;
}
