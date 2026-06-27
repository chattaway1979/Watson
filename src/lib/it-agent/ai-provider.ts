// ============================================================
// Watson — H&R AI IT Agent : AI Provider Abstraction
// ------------------------------------------------------------
// Watson never hard-fails when no model key is present. The
// deterministic provider gives explainable, rule-based output.
// An LLM provider (Anthropic / Azure OpenAI) can be plugged in
// later behind this same interface WITHOUT changing callers.
// ============================================================
import type { AiDiagnosis, TroubleshootingPlan, RecommendedAction, Ticket, TriageResult } from './types';
import { classifyIssue } from './triage';
import { buildTroubleshootingPlan } from './troubleshooting';
import { nowIso } from '../store/db';

export interface AiProvider {
  readonly name: string;
  readonly isLlm: boolean;
  classifyIssue(text: string): Promise<AiDiagnosis>;
  generateTroubleshootingPlan(text: string, diagnosis: AiDiagnosis): Promise<TroubleshootingPlan>;
  summarizeTicket(ticket: Ticket): Promise<string>;
  recommendActions(text: string, diagnosis: AiDiagnosis): Promise<RecommendedAction[]>;
  triage(text: string): Promise<TriageResult>;
}

// ---- Deterministic, no-network provider -------------------
class DeterministicProvider implements AiProvider {
  readonly name = 'deterministic';
  readonly isLlm = false;

  async classifyIssue(text: string): Promise<AiDiagnosis> {
    const r = classifyIssue(text);
    const plan = buildTroubleshootingPlan(r.category, r.priority);
    return {
      category: r.category,
      priority: r.priority,
      confidence: r.confidence,
      likelyCauses: plan.likelyCauses,
      summary:
        r.category === 'other'
          ? 'Could not confidently classify; routing for human triage.'
          : `Classified as ${r.category} (priority ${r.priority}) based on keywords: ${r.matchedKeywords.join(', ') || 'n/a'}.`,
      provider: this.name,
      createdAt: nowIso()
    };
  }

  async generateTroubleshootingPlan(_text: string, diagnosis: AiDiagnosis): Promise<TroubleshootingPlan> {
    return buildTroubleshootingPlan(diagnosis.category, diagnosis.priority);
  }

  async recommendActions(_text: string, diagnosis: AiDiagnosis): Promise<RecommendedAction[]> {
    return buildTroubleshootingPlan(diagnosis.category, diagnosis.priority).recommendedActions;
  }

  async summarizeTicket(ticket: Ticket): Promise<string> {
    const last = ticket.aiDiagnosis?.summary ?? 'No AI diagnosis yet.';
    return `Ticket ${ticket.shortId} — ${ticket.subject}. Category: ${ticket.category}, priority: ${ticket.priority}, status: ${ticket.status}. ${last}`;
  }

  async triage(text: string): Promise<TriageResult> {
    const diagnosis = await this.classifyIssue(text);
    const plan = await this.generateTroubleshootingPlan(text, diagnosis);
    return { diagnosis, plan };
  }
}

// Factory: chooses provider from env. Falls back to deterministic.
let _provider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (_provider) return _provider;
  const kind = (process.env.AI_PROVIDER ?? 'deterministic').toLowerCase();
  // Future: if (kind === 'anthropic' && process.env.AI_API_KEY) _provider = new AnthropicProvider();
  // For this build, any value without a configured+implemented backend => deterministic.
  switch (kind) {
    case 'deterministic':
    default:
      _provider = new DeterministicProvider();
  }
  return _provider;
}

export function providerInfo() {
  const p = getAiProvider();
  return { name: p.name, isLlm: p.isLlm, fallback: !p.isLlm, configured: process.env.AI_PROVIDER ?? 'deterministic' };
}
