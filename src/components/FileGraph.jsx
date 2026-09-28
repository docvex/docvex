import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import Toggle from './Toggle';
import RuleOptions from './RuleOptions';
import { ExtGlyph } from './fileGlyph';
import { useScanState } from '../lib/scanRunner';
import './FileGraph.css';

// THE KNOWLEDGE GRAPH — the Files tab's Graph view. Every file the AI scan has
// read is a NODE, every typed link it found between two files an EDGE
// (lib/dataCollections `loadScanGraph`: { files, connections }). Drawn by
// vis-network on a canvas, lazily imported (its standalone build — its own
// DataSet, no peer libraries), styled from the Design system's tokens: they
// are read off the page as colours (a canvas can't read CSS variables) and the
// graph is redrawn when the theme changes.
//
// Performance: physics runs only while the network first lays itself out
// (nodes pushed apart so none overlap), then it is switched OFF for good — a
// settled graph costs no CPU. Every instance is destroyed when its data
// changes or the view unmounts.

// Which colour a kind of file / a kind of link wears — tokens, resolved below.
const NODE_TONES = {
  document: '--accent',
  image: '--info',
  video: '--cat-update',
  audio: '--success',
  collection: '--warning',
  // The "People & things" lens (lib/caseInsights buildEntityGraph).
  person: '--cat-member',
  company: '--cat-project',
  institution: '--text-secondary',
  property: '--warning',
  vehicle: '--info',
};
const NODE_LABELS = {
  document: 'Documents', image: 'Pictures', video: 'Videos', audio: 'Audio', collection: 'Collections',
  person: 'People', company: 'Companies', institution: 'Institutions', property: 'Properties', vehicle: 'Vehicles',
};
const NODE_ONE = {
  document: 'Document', image: 'Picture', video: 'Video', audio: 'Audio', collection: 'Collection',
  person: 'Person', company: 'Company', institution: 'Institution', property: 'Property', vehicle: 'Vehicle',
};
const EDGE_TONES = {
  contradicts: '--danger',
  amends: '--info',
  supersedes: '--warning',
  financial_link: '--success',
  same_party: '--cat-member',
  same_subject: '--cat-project',
  evidence_for: '--cat-update',
  represents: '--cat-project',
  property: '--warning',
  vehicle: '--info',
};
export const CONNECTION_LABELS = {
  amends: 'Amends', supersedes: 'Supersedes', contradicts: 'Contradicts', same_party: 'Same party',
  same_subject: 'Same subject', dependency: 'Depends on', financial_link: 'Financial link',
  evidence_for: 'Evidence for', references: 'References', chronological: 'Follows',
  represents: 'Represents', property: 'Property', vehicle: 'Vehicle', same_document: 'Named together',
};
// Links that read the same either way round get no arrow.
const SYMMETRIC = new Set(['contradicts', 'same_party', 'same_subject', 'same_document']);

// A token's colour as [r, g, b] — resolved by the browser (a probe element's
// computed colour), so `color-mix()` and theme overrides come out right.
function tokenRgb(host, name, fallback = [128, 128, 128]) {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (c.startsWith('color(')) return nums.slice(0, 3).map((v) => Math.round(v * 255));
  return nums.length >= 3 ? nums.slice(0, 3) : fallback;
}
const rgba = ([r, g, b], a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(name || '')?.[1] || '').toLowerCase();

// A hover card vis-network shows (its `title`): plain DOM, styled by
// FileGraph.css on the tooltip ground.
function tipEl(kicker, head, body) {
  const el = document.createElement('div');
  el.className = 'fg-tip';
  const k = document.createElement('div'); k.className = 'fg-tip-kind'; k.textContent = kicker; el.appendChild(k);
  const h = document.createElement('div'); h.className = 'fg-tip-head'; h.textContent = head; el.appendChild(h);
  if (body) { const b = document.createElement('div'); b.className = 'fg-tip-body'; b.textContent = body; el.appendChild(b); }
  return el;
}

// The network itself. `data` = { files, connections }; `onSelectConnection`
// is handed the clicked edge's connection (null when the background is
// clicked); `onOpenFile(file)` on a double-click on a node.
export function FileGraph({ data, onSelectConnection, onOpenFile, onSelectNode = null, selectedKey = null }) {
  const boxRef = useRef(null);
  const netRef = useRef(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || '');
  const [layout, setLayout] = useState(null);   // null | 0…1 while laying out
  const selectRef = useRef(onSelectConnection);
  selectRef.current = onSelectConnection;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  const nodeRef = useRef(onSelectNode);
  nodeRef.current = onSelectNode;

  // The graph is drawn in the theme's colours: redraw when it changes.
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || ''));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !data?.files?.length) return undefined;
    let dead = false;
    let network = null;
    (async () => {
      const { Network, DataSet } = await import('vis-network/standalone');
      if (dead) return;
      const ground = tokenRgb(box, '--bg-page', [245, 243, 238]);
      const text = tokenRgb(box, '--text-primary', [30, 30, 30]);
      const muted = tokenRgb(box, '--text-secondary', [110, 110, 110]);
      const hair = tokenRgb(box, '--border', [200, 200, 200]);
      const tone = (name) => tokenRgb(box, name, muted);
      const nodeTone = Object.fromEntries(Object.entries(NODE_TONES).map(([k, v]) => [k, tone(v)]));
      const edgeTone = Object.fromEntries(Object.entries(EDGE_TONES).map(([k, v]) => [k, tone(v)]));
      const degree = new Map();
      data.connections.forEach((c) => {
        degree.set(c.from_file_id, (degree.get(c.from_file_id) || 0) + 1);
        degree.set(c.to_file_id, (degree.get(c.to_file_id) || 0) + 1);
      });
      const nodes = new DataSet(data.files.map((f) => {
        const t = nodeTone[f.type] || nodeTone.document;
        const fill = mix(ground, t, 0.14);
        return {
          id: f.id,
          label: f.name.length > 34 ? `${f.name.slice(0, 32)}…` : f.name,
          title: tipEl(NODE_ONE[f.type] || 'File', f.name, f.path
            ? `${degree.get(f.id) || 0} connection${degree.get(f.id) === 1 ? '' : 's'} · double-click to open`
            : [f.detail, `In ${f.sources?.length || 0} file${f.sources?.length === 1 ? '' : 's'} · click for details`].filter(Boolean).join(' · ')),
          shape: 'box',
          margin: { top: 7, bottom: 7, left: 10, right: 10 },
          shapeProperties: { borderRadius: 8 },
          borderWidth: 1.2,
          borderWidthSelected: 2,
          mass: 1 + Math.min(4, (degree.get(f.id) || 0) * 0.4),
          color: {
            background: rgba(fill),
            border: rgba(t, 0.55),
            highlight: { background: rgba(mix(ground, t, 0.26)), border: rgba(t) },
            hover: { background: rgba(mix(ground, t, 0.2)), border: rgba(t, 0.85) },
          },
          font: { face: 'Inter, Segoe UI, sans-serif', size: 12.5, color: rgba(text), multi: false },
        };
      }));
      const conn = new Map();
      const nameOf = new Map(data.files.map((f) => [f.id, f.name]));
      const edges = new DataSet(data.connections.map((c, i) => {
        const id = `e${i}`;
        conn.set(id, c);
        const t = edgeTone[c.connection_type] || muted;
        const label = c.label || CONNECTION_LABELS[c.connection_type] || c.connection_type;
        return {
          id,
          from: c.from_file_id,
          to: c.to_file_id,
          label,
          title: tipEl(label, `${nameOf.get(c.from_file_id) || c.from_file_id.split('/').pop()} ${SYMMETRIC.has(c.connection_type) ? '↔' : '→'} ${nameOf.get(c.to_file_id) || c.to_file_id.split('/').pop()}`, c.explanation ? (c.explanation.length > 220 ? `${c.explanation.slice(0, 218)}…` : c.explanation) : ''),
          arrows: SYMMETRIC.has(c.connection_type) ? '' : { to: { enabled: true, scaleFactor: 0.55 } },
          width: 1 + 1.6 * Math.max(0, Math.min(1, c.confidence || 0.5)),
          selectionWidth: 1.6,
          hoverWidth: 1.2,
          color: { color: rgba(t, 0.5), highlight: rgba(t), hover: rgba(t, 0.85) },
          font: { face: 'Inter, Segoe UI, sans-serif', size: 10, color: rgba(mix(muted, t, 0.45)), strokeWidth: 4, strokeColor: rgba(ground), align: 'middle' },
          smooth: { enabled: true, type: 'continuous', roundness: 0.35 },
        };
      }));
      network = new Network(box, { nodes, edges }, {
        autoResize: true,
        layout: { improvedLayout: data.files.length <= 150, randomSeed: 7 },
        physics: {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: { gravitationalConstant: -70, centralGravity: 0.008, springLength: 150, springConstant: 0.06, avoidOverlap: 0.9 },
          stabilization: { enabled: true, iterations: 320, updateInterval: 20, fit: true },
        },
        interaction: {
          hover: true,
          tooltipDelay: 160,
          zoomView: true,
          dragView: true,
          zoomSpeed: 0.7,
          multiselect: false,
          hideEdgesOnDrag: data.connections.length > 300,
        },
        edges: { color: { inherit: false }, chosen: true },
        nodes: { chosen: true },
      });
      netRef.current = { network, conn };
      setLayout(0);
      network.on('stabilizationProgress', (p) => setLayout(p.total ? p.iterations / p.total : 0));
      // Laid out: physics OFF for good (a settled graph costs no CPU), then
      // a smooth fit to what is there.
      network.once('stabilizationIterationsDone', () => {
        network.setOptions({ physics: false });
        setLayout(null);
        network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      });
      network.on('click', (p) => {
        if (p.nodes.length) {
          const f = data.files.find((x) => x.id === p.nodes[0]);
          if (f && nodeRef.current) nodeRef.current(f);
        } else if (p.edges.length) selectRef.current?.(conn.get(p.edges[0]) || null);
        else { selectRef.current?.(null); nodeRef.current?.(null); }
      });
      network.on('doubleClick', (p) => {
        const f = p.nodes.length ? data.files.find((x) => x.id === p.nodes[0]) : null;
        if (f) openRef.current?.(f);
      });
      network.on('hoverNode', () => { box.style.cursor = 'pointer'; });
      network.on('hoverEdge', () => { box.style.cursor = 'pointer'; });
      network.on('blurNode', () => { box.style.cursor = ''; });
      network.on('blurEdge', () => { box.style.cursor = ''; });
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[file-graph] could not draw:', err);
      setLayout(null);
    });
    return () => {
      dead = true;
      try { network?.destroy(); } catch { /* already gone */ }
      netRef.current = null;
    };
  }, [data, theme]);

  // The connection shown in the drawer stays selected on the canvas.
  useEffect(() => {
    const n = netRef.current;
    if (!n) return;
    const id = selectedKey ? [...n.conn.entries()].find(([, c]) => connKey(c) === selectedKey)?.[0] : null;
    try { if (id) n.network.selectEdges([id]); else n.network.unselectAll(); } catch { /* not drawn yet */ }
  }, [selectedKey]);

  const fit = () => netRef.current?.network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  const zoom = (f) => {
    const n = netRef.current?.network;
    if (!n) return;
    n.moveTo({ scale: Math.max(0.15, Math.min(3, n.getScale() * f)), animation: { duration: 220, easingFunction: 'easeInOutQuad' } });
  };

  return (
    <div className="fg-stage">
      <div ref={boxRef} className="fg-canvas" />
      {layout != null && (
        <div className="fg-layout" role="status">
          <span className="fg-spin" aria-hidden="true" />
          Arranging {data.files.length} files… {Math.round(layout * 100)}%
        </div>
      )}
      <div className="fg-zoom">
        <Tooltip content="Zoom out"><button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.3)}>−</button></Tooltip>
        <Tooltip content="Fit the whole graph"><button type="button" className="fg-zoom-fit" onClick={fit}>Fit</button></Tooltip>
        <Tooltip content="Zoom in"><button type="button" aria-label="Zoom in" onClick={() => zoom(1.3)}>+</button></Tooltip>
      </div>
    </div>
  );
}

export const connKey = (c) => (c ? `${c.from_file_id}>${c.to_file_id}|${c.connection_type}` : null);

// The Graph VIEW: loads the graph (again when a scan finishes), the legend
// and filters, the canvas, and the DRAWER a clicked connection opens — the AI's
// explanation, its evidence, both files (a click opens one).
const LENS_KEY = 'docvex:graph:lens:v1';
const LENS_FIELD = {
  label: 'Show',
  options: [
    { id: 'files', label: 'Files', example: 'Every file the scan read, and the typed links it found between them' },
    { id: 'people', label: 'People & things', example: 'The people, companies, properties and vehicles the files name, and how they are tied together' },
  ],
};
const joinPath = (dir, rel) => {
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${String(rel).split('/').join(sep)}`;
};

export default function FileGraphView({ dir, projectId, onOpenPath }) {
  const [data, setData] = useState(null);     // null = loading
  const [error, setError] = useState('');
  const [linkedOnly, setLinkedOnly] = useState(true);
  const [picked, setPicked] = useState(null);
  const [node, setNode] = useState(null);     // an entity picked (People & things)
  const [lens, setLens] = useState(() => { try { return localStorage.getItem(LENS_KEY) === 'people' ? 'people' : 'files'; } catch { return 'files'; } });
  const pickLens = (l) => { setLens(l); setPicked(null); setNode(null); try { localStorage.setItem(LENS_KEY, l); } catch { /* per device */ } };
  const scan = useScanState(dir);
  const running = !!scan && !scan.finished;
  const wasScanning = useRef(running);
  const load = useCallback(async () => {
    try {
      if (lens === 'people') {
        // The relationship map: built locally from what the scan understood
        // of every file (its parties, their roles, the properties and plates).
        const ci = await import('../lib/caseInsights');
        const cd = await ci.loadCaseData(dir, { projectId });
        const texts = await ci.loadTexts(cd);
        setData(ci.buildEntityGraph(cd, texts));
      } else {
        const { loadScanGraph } = await import('../lib/dataCollections');
        setData(await loadScanGraph(dir, { projectId }));
      }
      setError('');
    } catch (err) {
      setError(err?.message || String(err));
      setData({ files: [], connections: [] });
    }
  }, [dir, projectId, lens]);
  useEffect(() => { setData(null); setPicked(null); setNode(null); load(); }, [load]);
  // A scan that ends has new links to show.
  useEffect(() => {
    if (wasScanning.current && !running) load();
    wasScanning.current = running;
  }, [running, load]);

  const shown = useMemo(() => {
    if (!data) return null;
    if (!linkedOnly) return data;
    const ends = new Set(data.connections.flatMap((c) => [c.from_file_id, c.to_file_id]));
    return { files: data.files.filter((f) => ends.has(f.id)), connections: data.connections };
  }, [data, linkedOnly]);
  const counts = useMemo(() => {
    const m = {};
    (shown?.files || []).forEach((f) => { m[f.type] = (m[f.type] || 0) + 1; });
    return m;
  }, [shown]);
  const fileOf = (id) => data?.files.find((f) => f.id === id) || { id, name: String(id).split('/').pop(), path: '' };
  // The files an entity or a tie was read in, as files that open.
  const sourceFiles = (rels) => (rels || []).map((rel) => ({ id: rel, name: String(rel).split('/').pop(), path: joinPath(dir, rel) }));
  const FileButton = ({ f }) => (
    <Tooltip content={f.path ? 'Open this file' : f.name}>
      <button type="button" className="fg-file" onClick={() => open(f)} disabled={!f.path}>
        <span className="fg-file-glyph"><ExtGlyph ext={extOf(f.name)} /></span>
        <span className="fg-file-name">{f.name}</span>
      </button>
    </Tooltip>
  );
  const open = (f) => { if (f?.path) onOpenPath?.(f.path, f.name); };

  let body;
  if (!shown) {
    body = <div className="fg-empty"><span className="fg-spin" aria-hidden="true" /><p className="fg-empty-sub">Reading the graph…</p></div>;
  } else if (!shown.files.length) {
    body = (
      <div className="fg-empty">
        <svg className="fg-empty-mark" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <circle cx="12" cy="14" r="5" /><circle cx="36" cy="12" r="5" /><circle cx="24" cy="36" r="5" />
          <path d="M16.5 16.5 21 32M31.5 15 26.5 31.5M17 13.5h14" />
        </svg>
        <p className="fg-empty-title">{data.files.length ? 'No connections yet' : lens === 'people' ? 'No people or things yet' : 'Nothing scanned yet'}</p>
        <p className="fg-empty-sub">
          {error || (lens === 'people'
            ? 'Run the AI scan: the people, companies, properties and vehicles its files name are mapped here, tied together by the roles the files give them.'
            : data.files.length
            ? 'The AI scan has read the files but found no links between them. Scan again with Cross-reference switched on.'
            : 'Tag files for the AI scan and run it — with Cross-reference on, the links it finds between files are drawn here.')}
        </p>
      </div>
    );
  } else {
    body = (
      <FileGraph
        data={shown}
        onSelectConnection={(c) => { setPicked(c); if (c) setNode(null); }}
        onOpenFile={open}
        onSelectNode={lens === 'people' ? (n) => { setNode(n); if (n) setPicked(null); } : null}
        selectedKey={connKey(picked)}
      />
    );
  }

  const tone = picked ? (EDGE_TONES[picked.connection_type] || '--text-secondary') : null;
  return (
    <div className="fg-view">
      <div className="fg-bar">
        <div className="fg-legend">
          <RuleOptions field={LENS_FIELD} value={lens} onPick={pickLens} className="fg-lens" />
          {Object.keys(NODE_TONES).filter((k) => counts[k]).map((k) => (
            <span key={k} className="fg-legend-item" style={{ '--fg-tone': `var(${NODE_TONES[k]})` }}>
              <span className="fg-legend-dot" aria-hidden="true" />
              {NODE_LABELS[k]} <b>{counts[k]}</b>
            </span>
          ))}
          {shown?.connections.length > 0 && (
            <span className="fg-legend-item is-links"><b>{shown.connections.length}</b> connection{shown.connections.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <div className="fg-bar-tools">
          <Toggle on={linkedOnly} onChange={setLinkedOnly} label={lens === 'people' ? 'Only tied together' : 'Only connected files'} />
          <Tooltip content="Read the graph again">
            <button type="button" className="fg-tool" onClick={load} aria-label="Refresh">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="fg-body">
        {body}
        {picked && (
          <aside className="fg-drawer" style={{ '--fg-tone': `var(${tone})` }} aria-label="Connection">
            <div className="fg-drawer-head">
              <span className="fg-drawer-kicker">Connection</span>
              <Tooltip content="Close">
                <button type="button" className="fg-drawer-close" aria-label="Close" onClick={() => setPicked(null)}>×</button>
              </Tooltip>
            </div>
            <span className="fg-pill">{picked.label || CONNECTION_LABELS[picked.connection_type] || picked.connection_type}</span>
            <div className="fg-ends">
              {[picked.from_file_id, picked.to_file_id].map((id, i) => {
                const f = fileOf(id);
                return (
                  <React.Fragment key={id}>
                    {i === 1 && <span className="fg-ends-arrow" aria-hidden="true">{SYMMETRIC.has(picked.connection_type) ? '↔' : '↓'}</span>}
                    {f.path ? <FileButton f={f} /> : (
                      <div className="fg-entity" style={{ '--fg-tone': `var(${NODE_TONES[f.type] || '--text-secondary'})` }}>
                        <span className="fg-legend-dot" aria-hidden="true" />
                        <span className="fg-file-name">{f.name}</span>
                        <span className="fg-entity-kind">{NODE_ONE[f.type] || ''}</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            {picked.confidence > 0 && (
              <div className="fg-conf">
                <span>How sure the AI is</span>
                <span className="fg-conf-bar"><span style={{ width: `${Math.round(picked.confidence * 100)}%` }} /></span>
                <b>{Math.round(picked.confidence * 100)}%</b>
              </div>
            )}
            {picked.explanation && (
              <>
                <div className="fg-drawer-label">Why</div>
                <p className="fg-why">{picked.explanation}</p>
              </>
            )}
            {picked.evidence?.length > 0 && (
              <>
                <div className="fg-drawer-label">Evidence</div>
                <ul className="fg-evidence">{picked.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>
              </>
            )}
            {picked.sources?.length > 0 && (
              <>
                <div className="fg-drawer-label">Found in</div>
                <div className="fg-ends">{sourceFiles(picked.sources).map((f) => <FileButton key={f.id} f={f} />)}</div>
              </>
            )}
          </aside>
        )}
        {node && !picked && (
          <aside className="fg-drawer" style={{ '--fg-tone': `var(${NODE_TONES[node.type] || '--text-secondary'})` }} aria-label={NODE_ONE[node.type] || 'Entity'}>
            <div className="fg-drawer-head">
              <span className="fg-drawer-kicker">{NODE_ONE[node.type] || 'Entity'}</span>
              <Tooltip content="Close">
                <button type="button" className="fg-drawer-close" aria-label="Close" onClick={() => setNode(null)}>×</button>
              </Tooltip>
            </div>
            <p className="fg-node-name">{node.name}</p>
            {node.detail && <p className="fg-why">{node.detail}</p>}
            {(() => {
              const ties = (data?.connections || []).filter((c) => c.from_file_id === node.id || c.to_file_id === node.id);
              return ties.length > 0 && (
                <>
                  <div className="fg-drawer-label">Tied to</div>
                  <ul className="fg-ties">
                    {ties.slice(0, 30).map((c, k) => {
                      const other = fileOf(c.from_file_id === node.id ? c.to_file_id : c.from_file_id);
                      return (
                        <li key={k}>
                          <button type="button" className="fg-tie" onClick={() => { setPicked(c); }}>
                            <span className="fg-legend-dot" style={{ '--fg-tone': `var(${NODE_TONES[other.type] || '--text-secondary'})` }} aria-hidden="true" />
                            <span className="fg-file-name">{other.name}</span>
                            <span className="fg-entity-kind">{c.label || CONNECTION_LABELS[c.connection_type] || ''}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
            {node.sources?.length > 0 && (
              <>
                <div className="fg-drawer-label">Named in</div>
                <div className="fg-ends">{sourceFiles(node.sources).map((f) => <FileButton key={f.id} f={f} />)}</div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
