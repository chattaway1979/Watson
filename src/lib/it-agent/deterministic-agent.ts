// ============================================================
// Watson — H&R AI IT Agent : Watson Conversational Agent
// ------------------------------------------------------------
// Orchestrates triage + troubleshooting + safe recommendations
// into a chat-style response. Clearly labels every action by
// its execution disposition. Never claims to have executed
// external IT work.
// ============================================================
import { getAiProvider } from './ai-provider';
import { getAction } from './action-registry';
import { searchArticles, getArticleBySlug } from './knowledge';
import { writeAudit } from './audit';
import type { Actor, RecommendedAction, TriageResult, KnowledgeArticle } from './types';
import { SAFETY_BANNER } from './constants';

export type ActionDisposition =
  | 'recommended'         // suggested next step
  | 'prepared'            // a request packet can be assembled
  | 'approval_required'   // must be approved before any (simulated) execution
  | 'mock_executable'     // can be simulated now
  | 'unavailable_live';   // real execution disabled in this build

export interface DispositionedAction extends RecommendedAction {
  disposition: ActionDisposition;
}

export interface WatsonReply {
  message: string;
  triage: TriageResult;
  actions: DispositionedAction[];
  articles: { slug: string; title: string; summary: string }[];
  safety: string;
}

function disposition(a: RecommendedAction): ActionDisposition {
  const def = getAction(a.actionKey);
  if (!def) return 'recommended';
  if (def.execMode === 'future_live') return 'unavailable_live';
  if (def.requiresApproval || a.requiresApproval || def.riskLevel === 'high' || def.riskLevel === 'critical') {
    return 'approval_required';
  }
  if (def.execMode === 'preparatory') return 'prepared';
  if (def.execMode === 'mock_executable' || def.mockExecutable) return 'mock_executable';
  return 'recommended';
}

export async function watsonRespond(actor: Actor, text: string): Promise<WatsonReply> {
  const ai = getAiProvider();
  const triage = await ai.triage(text);

  const actions: DispositionedAction[] = triage.plan.recommendedActions.map((a) => ({
    ...a,
    disposition: disposition(a)
  }));

  const articles: KnowledgeArticle[] = [];
  for (const slug of triage.plan.relatedArticleSlugs) {
    const art = getArticleBySlug(slug);
    if (art) articles.push(art);
  }
  if (articles.length === 0) {
    articles.push(...searchArticles(triage.diagnosis.category, { limit: 2 }));
  }

  // Audit the triage outcome (agent acting).
  writeAudit({
    actorType: 'agent',
    actorId: 'watson',
    action: 'agent_triage_completed',
    targetType: 'conversation',
    targetId: actor.id,
    metadata: {
      category: triage.diagnosis.category,
      priority: triage.diagnosis.priority,
      confidence: triage.diagnosis.confidence,
      provider: triage.diagnosis.provider
    }
  });
  for (const a of actions) {
    writeAudit({
      actorType: 'agent',
      actorId: 'watson',
      action: 'agent_action_recommended',
      targetType: 'action',
      targetId: a.actionKey,
      metadata: { disposition: a.disposition, riskLevel: a.riskLevel }
    });
  }

  const lines: string[] = [];
  lines.push(
    triage.diagnosis.category === 'other'
      ? "I couldn't pin down the exact category, so I'll route this to a human admin if you'd like."
      : `This looks like a ${humanize(triage.diagnosis.category)} issue (priority: ${triage.diagnosis.priority}).`
  );
  lines.push('');
  lines.push('Likely causes: ' + triage.plan.likelyCauses.join('; ') + '.');
  lines.push('');
  lines.push('First things to try:');
  triage.plan.steps.slice(0, 5).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push('');
  lines.push(`When to escalate: ${triage.plan.whenToEscalate}`);

  return {
    message: lines.join('\n'),
    triage,
    actions,
    articles: articles.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary })),
    safety: SAFETY_BANNER
  };
}

function humanize(cat: string): string {
  return cat.replace(/_/g, ' ');
}
