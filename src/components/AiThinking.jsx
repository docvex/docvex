import React from 'react';
import gavelLoader from '../gavel-loader.svg';

// THE "THINKING" STATUS — the Advisor's: the gavel loader, a status word that
// changes every 2 s (picked from a set matching what was asked — maths,
// writing, law, files, code, a summary), and three dots. `label` holds one
// line instead (Research: "Searching the portals", "Auto is picking a
// model"). Styles: `.aichat-thinking*` in pages/Projects/ProjectAIChat.css.
// Shared by the Advisor and Research.

// Contextual "thinking" status — cycles through short status words picked from
// a set matching what the user asked for (math, writing, files, code, …).
const THINKING_SETS = {
  math: ['Calculating', 'Crunching the numbers', 'Working through the math', 'Checking the figures'],
  write: ['Drafting', 'Composing', 'Choosing the words', 'Polishing'],
  legal: ['Reviewing', 'Checking the clauses', 'Weighing the details', 'Consulting the rules'],
  files: ['Reading your files', 'Scanning the documents', 'Gathering context', 'Looking things up'],
  code: ['Writing code', 'Reasoning about the logic', 'Tracing the flow', 'Working it out'],
  summary: ['Reading', 'Summarising', 'Distilling the key points', 'Pulling it together'],
  general: ['Thinking', 'Working on it', 'Reasoning', 'Putting it together'],
};

function pickThinkingSet(text) {
  const t = (text || '').toLowerCase();
  if (/(calcul|\bsum\b|total|\bmath|number|average|percent|\bcost|price|budget|amount|equation|formula|multipl|divid|add up|how much)/.test(t)) return 'math';
  if (/(write|draft|compose|email|letter|essay|paragraph|rewrite|rephrase|\bmessage\b|reply)/.test(t)) return 'write';
  if (/(legal|\blaw\b|clause|contract|statute|regulation|complian|gdpr|liabilit|court|\bcase\b|tax)/.test(t)) return 'legal';
  if (/(file|document|folder|search|\bfind\b|look up|\bpdf\b|\bdoc\b|spreadsheet|attach)/.test(t)) return 'files';
  if (/(\bcode\b|function|\bbug\b|script|\bapi\b|json|\bcss\b|html|javascript|python|\bsql\b|\berror\b|program)/.test(t)) return 'code';
  if (/(summar|tl;?dr|overview|recap|key points|\bbrief\b|explain)/.test(t)) return 'summary';
  return 'general';
}

export default function ThinkingStatus({ query, label = '' }) {
  const set = React.useMemo(() => THINKING_SETS[pickThinkingSet(query)], [query]);
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
    setI(0);
    const id = window.setInterval(() => setI((n) => (n + 1) % set.length), 2000);
    return () => window.clearInterval(id);
  }, [set]);
  return (
    <span className="aichat-thinking" role="status" aria-label="DocVex AI is working">
      <img className="aichat-thinking-gavel" src={gavelLoader} alt="" aria-hidden="true" />
      <span className="aichat-thinking-text" key={label || i}>{label || set[i]}</span>
      <span className="aichat-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}

