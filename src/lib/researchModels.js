// RESEARCH'S MODEL PICKER — every Claude model Research can answer with, plus
// AUTO: a small, fast routing call (Haiku) reads the question and picks the
// model that fits it, with a one-sentence reason (the routing prompt below is
// the user's own, kept word for word). Every answer records which model ran
// and, under Auto, why — the page prints it under the result.
//
// `run` is the model actually requested from the `project-ai` Edge Function,
// which allow-lists model ids (MODEL_ALLOW in supabase/functions/project-ai):
// Fable 5.1 is NOT on that list yet, so a Fable pick runs on Opus 5.5 and the
// label says so rather than claiming a model that never answered.
import { askProjectAi } from './projectAi';

export const RESEARCH_MODELS = [
  { id: 'auto', label: 'Auto', tip: 'Picks the model for each question' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1 (not enabled)', name: 'Fable 5.1', run: 'claude-opus-5-5', unavailable: true, tip: 'Not enabled on the server yet — answers with Opus 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', name: 'Opus 5.5', run: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', name: 'Sonnet 5', run: 'claude-sonnet-5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', name: 'Opus 4.8', run: 'claude-opus-4-8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', name: 'Opus 4.7', run: 'claude-opus-4-7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', name: 'Sonnet 4.6', run: 'claude-sonnet-4-6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', name: 'Haiku 4.5', run: 'claude-haiku-4-5' },
];
const BY_ID = new Map(RESEARCH_MODELS.map((m) => [m.id, m]));
export const researchModel = (id) => BY_ID.get(id) || BY_ID.get('auto');
/** The display name of a model id that ran ("claude-sonnet-5" → "Sonnet 5"). */
export const modelName = (id) => BY_ID.get(id)?.name || id || 'unknown model';

const KEY = 'docvex:research:model:v1';
export function loadResearchModel() {
  try { const v = localStorage.getItem(KEY); return BY_ID.has(v) ? v : 'auto'; } catch { return 'auto'; }
}
export function saveResearchModel(id) {
  try { localStorage.setItem(KEY, id); } catch { /* quota */ }
}

// The routing prompt — the user's, word for word.
const ROUTER_PROMPT = `You are an expert AI Routing Engine. Your sole task is to analyze the user's prompt and determine which AI model from the Claude family is best suited to handle the request efficiently, balancing intelligence, speed, and cost.

Respond ONLY with a valid JSON object containing two fields: "model" and "reasoning". Do not include any other text, markdown blocks, or explanation.

### Available Models & Target Use Cases:
- "claude-fable-5.1": Best for long-horizon agentic workflows, autonomous planning, executing multi-step projects, and multi-agent system coordination.
- "claude-opus-5.5": Best for advanced reasoning, complex mathematics, logic puzzles, heavy programming/enterprise software architecture, and highly accurate data analysis.
- "claude-sonnet-5": Best for general-purpose productivity, daily writing, standard coding assistance, summarizing, and standard tool use.
- "claude-haiku-4.5": Best for simple, high-volume tasks, fast chat responses, content moderation, text classification, and simple data extraction.

### Output Format:
{
  "model": "model-id-here",
  "reasoning": "A concise one-sentence explanation of why this model was chosen based on the task complexity."
}

User Prompt to analyze:`;

const ROUTER_MODEL = 'claude-haiku-4-5';
// The router's names ("claude-opus-5.5") → the picker's ids.
const ROUTED = {
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
};

/**
 * Pick a model for `question`.
 * → `{ id, run, reasoning, routedOk }` — `id` the picker entry chosen, `run`
 * the id actually requested (Fable → Opus 5.5 until enabled).
 */
export async function routeModel(question) {
  const fallback = { id: 'claude-sonnet-5', run: 'claude-sonnet-5', reasoning: 'The router did not answer, so the general-purpose model was used.', routedOk: false };
  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: `${ROUTER_PROMPT}\n${String(question || '').slice(0, 4000)}` }],
      model: ROUTER_MODEL,
      tools: false,
      usageAction: 'research-route',
    });
    if (res?.error) return fallback;
    const m = /\{[\s\S]*\}/.exec(res.text || '');
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    const raw = String(parsed?.model || '').trim().toLowerCase();
    const id = ROUTED[raw] || ROUTED[raw.replace(/-(\d)-(\d)$/, '-$1.$2')] || (BY_ID.has(raw) ? raw : null);
    if (!id || id === 'auto') return fallback;
    const entry = BY_ID.get(id);
    return { id, run: entry.run, reasoning: String(parsed?.reasoning || '').trim(), routedOk: true };
  } catch {
    return fallback;
  }
}
