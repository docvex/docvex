// The machine-readable zone of an identity document, parsed by the AI with
// the MRZ parser prompt (lib/roIdDocuments `MRZ_PROMPT`). Used only when the
// local reader (parseMrz) could not read the strip — an OCR that misread a
// "<" or a letter. Only the strip's lines are sent (the whole text when the
// lines can't be told apart), so the call is small.
import { askProjectAi } from './projectAi';
import { MRZ_PROMPT, normalizeMrzReading, isMrzLine } from './roIdDocuments';

const MODEL = 'claude-sonnet-4-6';

// → the reading ({ last_name, first_names: [], birth, sex, expiry, nationality }) or null.
export async function readMrzWithAi(text, { projectId, projectName } = {}) {
  const lines = String(text || '').split(/\r?\n/).filter(isMrzLine);
  const input = lines.length >= 2 ? lines.join('\n') : String(text || '').slice(0, 4000);
  if (!input.trim()) return null;
  const res = await askProjectAi({
    messages: [{ role: 'user', content: `${MRZ_PROMPT}\n\nINPUT:\n${input}` }],
    tools: false, model: MODEL, projectName, usageProject: projectId, usageAction: 'mrz',
  });
  if (res?.error) return null;
  const m = /\{[\s\S]*\}/.exec(String(res.text || ''));
  if (!m) return null;
  try { return normalizeMrzReading(JSON.parse(m[0])); } catch { return null; }
}
