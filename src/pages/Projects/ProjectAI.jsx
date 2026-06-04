import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import { ICONS as I, MATTER as D, TONE_CAT } from './aiHub';
import {
  GenerateTool, ReviewTool, AskTool, ResearchTool, AutomateTool, ComplianceTool,
} from './ProjectAITools';
import './ProjectScoped.css';
import './ProjectAI.css';

// AI — the project's AI hub. Ported from the Claude Design "ai-tab-v1" handoff
// (Command Center / Briefing Desk, Romanian). A Command Center landing plus six
// tools (Generate · Review · Ask · Research · Automate · Compliance). The
// prototype's own app-shell + theme toggle are dropped — AppShell, the
// ProjectBanner, and the global ThemeContext already supply chrome + theming.
// AI output is simulated; the legal content is a static placeholder until the
// `legal-ai`-style edge-function wiring lands.

const LAYOUT_KEY = 'docvex.ai.layout';

// ── Landing ─────────────────────────────────────────────────────────

function CommandBar({ onOpen, onAsk, compact }) {
  const [val, setVal] = useState('');
  const suggestions = [
    { t: 'Summarize the matter in 10 points', tab: 'ask' },
    { t: 'Draft written submissions', tab: 'generate' },
    { t: 'What are the risks in the framework agreement?', tab: 'ask' },
  ];
  const submit = () => {
    const q = val.trim();
    if (q) { onAsk(q); setVal(''); } else { onOpen('ask'); }
  };
  return (
    <div className="cmd">
      <div className="cmd-row">
        <div className="ai-orb">{I.spark()}</div>
        <div className="cmd-input">
          <textarea
            rows={compact ? 1 : 2}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Ask DocVex AI, or describe what you want to do in this matter…"
          />
        </div>
      </div>
      <div className="cmd-foot">
        <span className="cmd-ctx">{I.files({ width: 13, height: 13 })} Context: <b>{D.files.length} files</b></span>
        {suggestions.map((s, i) => (
          <button type="button" key={i} className="cmd-chip" onClick={() => (s.tab === 'ask' ? onAsk(s.t) : onOpen(s.tab))}>{I.spark({ width: 13, height: 13 })}{s.t}</button>
        ))}
        <button type="button" className="cmd-send" onClick={submit}>{I.send()} Send</button>
      </div>
    </div>
  );
}

function ActionCard({ a, onOpen }) {
  return (
    <button type="button" className="acard" data-tone={a.tone} onClick={() => onOpen(a.tab)}>
      <div className="acard-ico">{I[a.icon]()}</div>
      <div className="acard-t">{a.t}</div>
      <div className="acard-d">{a.d}</div>
      <div className="acard-tag"><span className="dot" />{a.tag}</div>
    </button>
  );
}

function RecentFeed({ limit }) {
  const rows = limit ? D.recent.slice(0, limit) : D.recent;
  return (
    <div className="panel">
      <div className="panel-h">{I.clock({ width: 16, height: 16, style: { color: 'var(--text-muted)' } })}<h3>Recent AI activity</h3><button type="button" className="more">View all</button></div>
      {rows.map((r, i) => (
        <div className="feed-row" key={i}>
          <div className="feed-ico" style={{ background: `color-mix(in srgb, var(--cat-${TONE_CAT[r.tone] || 'system'}) 13%, transparent)`, color: `var(--cat-${TONE_CAT[r.tone] || 'system'})` }}>{I[r.icon]({ style: { color: 'currentColor' } })}</div>
          <div className="feed-b">
            <div className="feed-t" dangerouslySetInnerHTML={{ __html: r.t }} />
            <div className="feed-m"><span>{r.m}</span></div>
          </div>
          <span className={`feed-status ${r.status}`}>{r.sl}</span>
        </div>
      ))}
    </div>
  );
}

function MiniAutomations({ onOpen }) {
  const items = [
    { icon: 'tag', t: 'Auto-tag uploaded files', sub: '24 files classified' },
    { icon: 'bell', t: 'Procedural deadline alerts', sub: 'Next: Jun 3' },
    { icon: 'inbox', t: 'New-client intake', sub: '2 awaiting review' },
  ];
  return (
    <div className="panel">
      <div className="panel-h">{I.bolt({ width: 16, height: 16, style: { color: 'var(--cat-auth)' } })}<h3>Active automations</h3><button type="button" className="more" onClick={() => onOpen('automate')}>Manage</button></div>
      {items.map((it, i) => (
        <div className="feed-row" key={i}>
          <div className="feed-ico" style={{ background: 'color-mix(in srgb, var(--cat-auth) 13%, transparent)', color: 'var(--cat-auth)' }}>{I[it.icon]()}</div>
          <div className="feed-b">
            <div className="feed-t">{it.t}</div>
            <div className="feed-m"><span>{it.sub}</span></div>
          </div>
          <span className="toggle on" />
        </div>
      ))}
    </div>
  );
}

function StatStrip() {
  return (
    <div className="stats">
      {D.stats.map((s, i) => (
        <div className="stat" key={i}>
          <div className="stat-n">{s.n}{s.sm && <small>{s.sm}</small>}</div>
          <div className="stat-l">{s.l}</div>
          <div className="stat-d">{s.d}</div>
        </div>
      ))}
    </div>
  );
}

// Vertical task row used in Direction B (Briefing Desk).
function TaskRow({ a, onOpen }) {
  return (
    <button type="button" className="feed-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', borderBottom: '1px solid var(--border)' }} onClick={() => onOpen(a.tab)}>
      <div className="acard-ico" style={{ width: 36, height: 36 }} data-tone={a.tone}>
        <span style={{ display: 'contents' }}>{I[a.icon]()}</span>
      </div>
      <div className="feed-b">
        <div className="acard-t" style={{ fontSize: '0.95rem' }}>{a.t}</div>
        <div className="acard-d" style={{ marginTop: 3 }}>{a.d}</div>
      </div>
      <span className="acard-tag" style={{ alignSelf: 'center' }}><span className="dot" />{a.tag}</span>
    </button>
  );
}

// Compact 2x2 stat block for the Direction B rail.
function StatStrip2() {
  return (
    <div className="panel">
      <div className="panel-h">{I.target({ width: 16, height: 16, style: { color: 'var(--accent)' } })}<h3>AI impact · this month</h3></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {D.stats.map((s, i) => (
          <div className="stat" key={i} style={{ borderBottom: i < 2 ? '1px solid var(--border)' : 'none', borderRight: i % 2 === 0 ? '1px solid var(--border)' : 'none' }}>
            <div className="stat-n" style={{ fontSize: '1.4rem' }}>{s.n}{s.sm && <small>{s.sm}</small>}</div>
            <div className="stat-l">{s.l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Landing({ onOpen, onAsk, layout }) {
  if (layout === 'B') {
    // Direction B — "Briefing Desk": editorial split, task list + sticky rail.
    return (
      <div className="split" style={{ marginTop: 24 }}>
        <div className="stack">
          <CommandBar onOpen={onOpen} onAsk={onAsk} compact />
          <div>
            <div className="sec-label">AI tools<span className="rule" /><span className="count">{D.actions.length}</span></div>
            <div className="panel">
              {D.actions.map((a, i) => <TaskRow key={i} a={a} onOpen={onOpen} />)}
            </div>
          </div>
        </div>
        <div className="stack">
          <StatStrip2 />
          <RecentFeed limit={4} />
          <MiniAutomations onOpen={onOpen} />
        </div>
      </div>
    );
  }
  // Direction A — "Command Center": hero command bar + card grid + split.
  return (
    <div className="stack" style={{ marginTop: 24, gap: 0 }}>
      <CommandBar onOpen={onOpen} onAsk={onAsk} />
      <div className="sec-label">What do you want to do?<span className="rule" /></div>
      <div className="cards c3">
        {D.actions.map((a, i) => <ActionCard key={i} a={a} onOpen={onOpen} />)}
      </div>
      <div className="sec-label" style={{ marginTop: 34 }}>In this matter today<span className="rule" /></div>
      <div className="split">
        <RecentFeed />
        <div className="stack">
          <MiniAutomations onOpen={onOpen} />
        </div>
      </div>
      <div className="sec-label" style={{ marginTop: 34 }}>Impact<span className="rule" /></div>
      <StatStrip />
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'generate', label: 'Generate', icon: 'pen' },
  { id: 'review', label: 'Review', icon: 'shield' },
  { id: 'ask', label: 'Ask', icon: 'chat' },
  { id: 'research', label: 'Research', icon: 'scale' },
  { id: 'automate', label: 'Automate', icon: 'bolt' },
  { id: 'compliance', label: 'Compliance', icon: 'target' },
];

export default function ProjectAI() {
  const { selectedProject, loading } = useSelectedProject();
  const [tab, setTab] = useState('overview');
  const [layout, setLayout] = useState(() => localStorage.getItem(LAYOUT_KEY) || 'A');
  // A question typed into the landing command bar is parked here, then the
  // Ask tab picks it up and fires it once (clearing the seed afterward).
  const [askSeed, setAskSeed] = useState(null);

  useEffect(() => { localStorage.setItem(LAYOUT_KEY, layout); }, [layout]);

  const openAsk = (question) => { setAskSeed(question); setTab('ask'); };

  if (loading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to use the AI tools.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  const projectName = selectedProject.name;
  const fileNames = D.files.map((f) => f.name);
  const heads = {
    overview: { eyebrow: 'Legal AI assistant', title: 'AI Dashboard', sub: <>Generation, review, research and automation for <b>{projectName}</b>. Everything AI in this matter, in one place.</> },
    generate: { eyebrow: 'Generate · 14 templates', title: 'Draft documents', sub: <>Pleadings, contracts and correspondence, drafted from the matter context — with legal basis and citations.</> },
    review: { eyebrow: 'Review · risk & redline', title: 'Contract review', sub: <>Risky clauses, obligations and deadlines flagged automatically, with concrete redline suggestions.</> },
    ask: { eyebrow: 'Ask · Q&A with citations', title: 'Ask about the matter', sub: <>Answers grounded in the case files, each with verifiable citations to the source document.</> },
    research: { eyebrow: 'Research · RO + EU', title: 'Legal research', sub: <>Romanian legislation, EU directives and HCCJ case law relevant to the dispute, ready to cite.</> },
    automate: { eyebrow: 'Automate · no code', title: 'Automations', sub: <>“When X happens, do Y” rules for the matter — tagging, deadline alerts, routing and intake.</> },
    compliance: { eyebrow: 'Compliance · GDPR', title: 'Compliance check', sub: <>GDPR and conflict-of-interest scanning for the matter and its clients, with suggested fixes.</> },
  };
  const h = heads[tab];

  return (
    <div className="ai-hub">
      <div className="ai-head">
        <div>
          <div className="ai-eyebrow"><span className="spark">{I.spark()}</span> {h.eyebrow}</div>
          <h1 className="ai-title">{h.title}</h1>
          <p className="ai-sub">{h.sub}</p>
        </div>
        {tab === 'overview' && (
          <div className="layout-switch">
            <button type="button" className={layout === 'A' ? 'active' : ''} onClick={() => setLayout('A')}>Command Center</button>
            <button type="button" className={layout === 'B' ? 'active' : ''} onClick={() => setLayout('B')}>Briefing Desk</button>
          </div>
        )}
      </div>

      <div className="ai-tabs" role="tablist">
        {TABS.map((t) => (
          <button type="button" key={t.id} role="tab" aria-selected={tab === t.id} className={`ai-tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
            {I[t.icon]()}<span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'overview' && <Landing onOpen={setTab} onAsk={openAsk} layout={layout} />}
      {tab === 'generate' && <GenerateTool projectName={projectName} fileNames={fileNames} />}
      {tab === 'review' && <ReviewTool />}
      {tab === 'ask' && <AskTool projectName={projectName} fileNames={fileNames} seedQuestion={askSeed} onSeedConsumed={() => setAskSeed(null)} />}
      {tab === 'research' && <ResearchTool />}
      {tab === 'automate' && <AutomateTool />}
      {tab === 'compliance' && <ComplianceTool />}
    </div>
  );
}
