// The selected project's AI usage this month.
//
// `useAiUsage(projectId)` is the data: the project's tokens this month (sent +
// generated) — the server-side roll-up of every member's AI requests
// (get_project_ai_usage) — against the monthly allowance (lib/plan). Re-read
// whenever an AI request finishes anywhere in the app (aiTokenMeter's event,
// which the Doc Viewer's requests reach through the `storage` event) — a beat
// later, since the usage row is written fire-and-forget after the request
// returns.
//
// `AiUsageBar` is the bare bar, no words: it sits inside the Sidebar's account
// row, and the numbers are in that row's hover card (Sidebar.jsx).
import React, { useEffect, useState } from 'react';
import { getProjectAiUsage } from '../lib/projects';
import { AI_TOKENS_CHANGED_EVENT } from '../lib/aiTokenMeter';
import { AI_MONTHLY_TOKENS } from '../lib/plan';
import './AiUsageMeter.css';

// "1,240" · "214K" · "2.1M"
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
}

// { loaded, tokens, cap, pct, tint, requests } — `pct` 0…100.
export function useAiUsage(projectId) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    setUsage(null);
    if (!projectId) return undefined;
    let alive = true;
    let timer = null;
    const load = () => {
      getProjectAiUsage(projectId).then(({ data }) => { if (alive && data) setUsage(data); });
    };
    load();
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(load, 1500); };
    window.addEventListener(AI_TOKENS_CHANGED_EVENT, onChange);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener(AI_TOKENS_CHANGED_EVENT, onChange);
    };
  }, [projectId]);

  const tokens = (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0);
  const pct = Math.max(0, Math.min(100, (tokens / AI_MONTHLY_TOKENS) * 100));
  return {
    loaded: !!usage,
    tokens,
    cap: AI_MONTHLY_TOKENS,
    pct,
    // Colour says how close the allowance is.
    tint: pct >= 90 ? 'var(--danger)' : pct >= 75 ? 'var(--warning)' : 'var(--accent)',
    requests: Number(usage?.requests) || 0,
  };
}

export function AiUsageBar({ usage, className = '' }) {
  if (!usage) return null;
  return (
    <span
      className={`aim-track ${className}`.trim()}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(usage.pct)}
      aria-label={`AI usage this month: ${Math.round(usage.pct)}%`}
    >
      <span className="aim-fill" style={{ width: `${usage.pct}%`, background: usage.tint }} />
    </span>
  );
}
