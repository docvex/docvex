// Import — what the Files tab's Import button opens. Files can come from this
// computer (the ordinary picker) or from a PHONE, by one of two QR codes shown
// side by side, each labelled with the route it takes:
//
//   Same Wi-Fi     — the desktop app's own upload server on the local network
//                    (src/phoneUploadServer.js); files go straight into the
//                    folder and never leave the network.
//   Any connection — the phone uploads through DocVex's cloud (lib/
//                    phoneUploadCloud + the `phone-upload` Edge Function); this
//                    app pulls each file into the folder and deletes it there.
//
// The LOCAL address is kept per project (lib/phoneUploadLocal): it is the same
// every time the window opens and goes on receiving when the window is closed,
// so a phone can keep the page open and go on sending — "New address" revokes
// it. With the window closed what the phone sends is HELD for approval
// (components/PhoneIncomingNotifier — the app's notification toasts). The CLOUD code is only
// made when asked for ("Show the cloud QR code"), and its session ends when
// the window closes. Every
// file that arrives while the window is open, by either route, is listed at
// the foot with its progress (with it closed, ProjectFiles says so in a toast).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isElectron, onPhoneUploadEvent, openDocViewerWindow, phoneUploadStop } from '../lib/platform';
import { listIncoming, subscribeIncoming, decideIncoming, setIncomingQuiet } from '../lib/phoneUploadIncoming';
import { describeLocalFile } from '../lib/thumbnailDescriptor';
import { ensureLocalLink } from '../lib/phoneUploadLocal';
import { useAuth } from '../context/AuthContext';
import { startCloudUpload, stopCloudUpload, watchCloudUpload } from '../lib/phoneUploadCloud';
import Tooltip from './Tooltip';
import RuleOptions from './RuleOptions';
import ConfirmModal from './ConfirmModal';
import { FileTile } from './FilesWorkspace';
import './FilesWorkspace.css';
import './PhoneUploadModal.css';

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${Math.round(v / 1024)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
};

const FADE_MS = 160;

// The route switch — the Playbook's segmented control (components/RuleOptions).
const ROUTE_FIELD = {
  label: 'How the phone sends',
  options: [
    { id: 'local', label: 'Local network', example: 'Same Wi-Fi — straight from the phone to this computer' },
    { id: 'cloud', label: 'DocVex cloud', example: 'Any connection — for a phone on mobile data or another network' },
  ],
};   // keep in step with .pum-scrim.is-closing

const LOCAL_ERRORS = {
  unsupported: 'Only the desktop app can receive over the local network.',
  stale_app: 'Restart DocVex to turn this on (the app was updated while running).',
  no_network: 'This computer isn’t connected to a network a phone can reach.',
  no_folder: 'The project folder can’t be reached.',
  EACCES: 'The system refused to open a port for the upload page.',
};
const CLOUD_ERRORS = {
  not_deployed: 'The cloud route isn’t set up on the server yet.',
  not_signed_in: 'Sign in to DocVex to upload through the cloud.',
  unreachable: 'DocVex’s cloud can’t be reached — check the internet connection.',
  no_project: 'You’re not a member of this project on the server.',
};

// A QR code as an SVG, dark on white whatever the theme — phones read
// a light ground most reliably.
function Qr({ value }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (!value) { setSvg(''); return undefined; }
    import('qrcode').then((mod) => {
      const QR = mod.default || mod;
      return QR.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
    }).then((s) => { if (!cancelled) setSvg(s); }).catch(() => { if (!cancelled) setSvg(''); });
    return () => { cancelled = true; };
  }, [value]);
  return <div className="pum-qr-code" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// An arrival as the Files tab's own tile: the same thumbnail (the saved file's,
// once it is on disk) and name. While it is still coming, its progress runs
// along the foot of the thumbnail.
const extOf = (name) => {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1 || n.length - i - 1 > 8) return '';
  return n.slice(i + 1).toLowerCase();
};
// A file WAITING for approval (`held`) is drawn as a plain tile here — no
// faded / download look (that is the Files tab's, where it is accepted) — with
// its × to reject it (deleted). One accepted (`done`) is a project file: the ×
// sends it to the Trash. Still arriving: faded, progress along the thumbnail's foot.
function ArrivalTile({ a, onToggle }) {
  const held = a.state === 'held';
  const done = a.state === 'done' && a.path;
  const item = useMemo(() => ({
    id: a.key,
    kind: 'file',
    name: a.name || 'file',
    ext: extOf(a.name),
    descriptor: (held || done) && a.path ? describeLocalFile({ localFile: { path: a.path, name: a.name } }) : null,
  }), [a.key, a.name, a.path, held, done]);
  const pct = a.size ? Math.min(100, Math.round(((a.received || 0) / a.size) * 100)) : 0;
  const route = a.route === 'cloud' ? 'Cloud' : 'Wi-Fi';
  const ticked = held && a.ticked !== false;
  const tip = held ? `${a.name}${a.live ? ' · Live Photo' : ''} · ${fmtBytes(a.size)} — ${ticked ? 'will be imported. Click to leave it out' : 'left out. Click to include it'}`
    : done ? `${a.name} · ${fmtBytes(a.size)} · added — double-click to open`
      : a.state === 'error' ? `${a.name} · ${a.error}`
        : a.state === 'taking' ? `${a.name} · downloading from the cloud…` : `${a.name} · ${pct}% · ${route}`;
  return (
    <div className="pum-tilewrap">
      <Tooltip content={tip}>
        <FileTile
          item={item}
          className={`pum-tile is-${a.state}${ticked ? ' is-selected' : held ? ' is-unticked' : ''}`}
          onClick={held && !a.busy ? () => onToggle(a) : undefined}
          onDoubleClick={done ? () => openDocViewerWindow({ path: a.path, name: a.name, mime: '' }) : undefined}
        >
          {held && (
            <span className={`pum-tick${ticked ? ' is-on' : ''}`} aria-hidden="true">
              {ticked && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
            </span>
          )}
          {/* A Live Photo: its movement came with it and goes in beside it. */}
          {a.live && <span className="pum-live" aria-label="Live Photo">LIVE</span>}
          {!held && !done && (
            <span className="pum-tile-bar" aria-hidden="true"><i style={{ width: `${a.state === 'error' ? 100 : pct}%` }} /></span>
          )}
        </FileTile>
      </Tooltip>
    </div>
  );
}

function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60000));
}

function RouteCard({ tag, title, sub, points, state, onRenew, kept, onNewAddress, warning }) {
  const mins = useCountdown(kept ? null : state.expiresAt);
  const expired = mins === 0;
  return (
    <section className={`pum-route${state.error ? ' is-off' : ''}`}>
      <span className="pum-route-tag">{tag}</span>
      <div className="pum-route-body">
      <div className="pum-qr">
        {(state.loading || state.idle) && <span className="pum-qr-wait">Preparing the code…</span>}
        {!state.loading && state.error && <span className="pum-qr-off">{state.error}</span>}
        {!state.loading && !state.error && state.url && (
          expired ? (
            <button type="button" className="pum-renew" onClick={onRenew}>Code expired — make a new one</button>
          ) : <Qr value={state.url} />
        )}
      </div>
      <div className="pum-route-info">
        <header className="pum-route-head">
          <h3 className="pum-route-title">{title}</h3>
          <p className="pum-route-sub">{sub}</p>
        </header>
      {warning && <p className="pum-route-warn" role="note">{warning}</p>}
      {!state.loading && !state.error && state.url && !expired && (
        <div className="pum-route-meta">
          {mins != null && <span className="pum-expiry">Valid for {mins} min</span>}
          {kept && (
            <span className="pum-expiry">
              Same address every time — the page on your phone pauses while this window is closed and comes back when you open it.{' '}
              <Tooltip content="Stop the old address working and make a new one">
                <button type="button" className="pum-newaddr" onClick={onNewAddress}>New address</button>
              </Tooltip>
            </span>
          )}
        </div>
      )}
      {state.error && state.retry && (
        <button type="button" className="pum-renew is-small" onClick={onRenew}>Try again</button>
      )}
      <ul className="pum-points">
        {points.map((p) => <li key={p}>{p}</li>)}
      </ul>
      </div>
      </div>
    </section>
  );
}

export default function PhoneUploadModal({ open, onClose, dir, folderLabel, projectId, projectName, onPickFromComputer, onReject }) {
  const { session } = useAuth();
  const userId = session?.user?.id || '';
  const [local, setLocal] = useState({ idle: true });
  const [cloud, setCloud] = useState({ idle: true });
  // Which QR code is shown — DocVex cloud by default: it is encrypted end to
  // end over https, where the Wi-Fi page is plain http (its files are
  // encrypted too, but someone who can tamper with the network could serve
  // the phone a different page).
  const [useCloud, setUseCloud] = useState(true);
  const [arrivals, setArrivals] = useState([]);   // { key, route, name, size, received, state, error }
  const localTokenRef = useRef(null);
  const cloudRef = useRef({ sessionId: null, stop: null });

  const upsert = useCallback((key, patch) => {
    setArrivals((list) => {
      const i = list.findIndex((a) => a.key === key);
      if (i === -1) return [{ key, ...patch }, ...list];
      const next = [...list];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }, []);

  // A file that starts WAITING: one row per waiting file (the main process's
  // 'held' event and the cloud download's may both name it).
  const upsertHeld = useCallback((key, patch) => {
    setArrivals((list) => {
      const rest = list.filter((x) => x.key === key || !patch.heldId || x.heldId !== patch.heldId);
      const i = rest.findIndex((x) => x.key === key);
      if (i === -1) return [{ key, ...patch }, ...rest];
      const next = [...rest];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }, []);

  const startLocal = useCallback(async (fresh = false) => {
    if (!isElectron) { setLocal({ error: LOCAL_ERRORS.unsupported }); return; }
    setLocal((st) => (st.url && !fresh ? st : { loading: true }));
    const res = await ensureLocalLink({ userId, projectId, dir, project: projectName || '', folder: folderLabel || '', fresh: fresh === true, hold: true });
    if (!res?.ok) { setLocal({ error: LOCAL_ERRORS[res?.error] || 'The upload page couldn’t be started.', retry: res?.error !== 'unsupported' }); return; }
    localTokenRef.current = res.token;
    setLocal({ url: res.urls[0], urls: res.urls, expiresAt: res.expiresAt, computer: res.computer });
  }, [dir, projectId, projectName, folderLabel, userId]);

  // The cloud address is kept and REOPENED like the Wi-Fi one (same QR code
  // every time); `fresh` = "New address".
  const startCloud = useCallback(async (fresh = false) => {
    cloudRef.current.stop?.();
    cloudRef.current = { sessionId: null, stop: null };
    setCloud({ loading: true });
    const res = await startCloudUpload({ projectId, projectName, userId, fresh: fresh === true });
    if (!res?.ok) { setCloud({ error: CLOUD_ERRORS[res?.error] || 'The cloud route couldn’t be started.', retry: res?.error !== 'not_deployed' }); return; }
    const stop = watchCloudUpload(res.sessionId, dir, (ev) => {
      const key = `cloud:${ev.id}`;
      if (ev.type === 'start') upsert(key, { route: 'cloud', name: ev.name, size: ev.size, received: 0, state: 'taking' });
      else if (ev.type === 'held') upsertHeld(key, { route: 'cloud', name: ev.name, size: ev.size, received: ev.size, state: 'held', heldId: ev.heldId, path: ev.path, live: !!ev.live });
      else if (ev.type === 'live') setArrivals((list) => list.map((x) => (x.heldId === ev.heldId ? { ...x, live: true } : x)));
      else if (ev.error === 'not_decrypted' || ev.error === 'not_encrypted') upsert(key, { state: 'error', error: ev.error === 'not_decrypted' ? 'Couldn’t be decrypted — deleted' : 'Not encrypted — deleted' });
      else upsert(key, { state: 'error', error: 'Couldn’t save it — retrying' });
    }, userId, { key: res.key, token: res.token, keyAt: res.keyAt });
    cloudRef.current = { sessionId: res.sessionId, stop };
    setCloud({ url: res.url, expiresAt: res.expiresAt });
  }, [dir, projectId, projectName, upsert, upsertHeld, userId]);

  // Both routes open with the window and close with it.
  useEffect(() => {
    if (!open || !dir) return undefined;
    // What already waits in this folder is shown too.
    const same = (x, y) => String(x || '').replace(/[\\/]+$/, '').toLowerCase() === String(y || '').replace(/[\\/]+$/, '').toLowerCase();
    setArrivals(listIncoming().filter((p) => same(p.dir, dir)).sort((x, y) => (y.at || 0) - (x.at || 0)).map((p) => ({
      key: `held:${p.id}`, route: String(p.token || '').startsWith('cloud-') ? 'cloud' : 'local',
      name: p.name, size: p.size, received: p.size, state: 'held', heldId: p.id, path: p.path, live: !!p.live,
    })));
    setIncomingQuiet(true);
    // Only the route on show is started; the other when it is picked.
    setUseCloud(true);
    setLocal({ idle: true });
    startCloud();
    // The portal lives ONLY while this window is open: closing it ends the
    // Wi-Fi session (the server stops once nothing uses it), and the phone's
    // page says the upload was closed. The address itself is kept
    // (lib/phoneUploadLocal), so opening the window again brings the SAME
    // page back to life — the phone picks it up on its own.
    return () => {
      setIncomingQuiet(false);
      if (localTokenRef.current) phoneUploadStop(localTokenRef.current);
      localTokenRef.current = null;
      cloudRef.current.stop?.();
      if (cloudRef.current.sessionId) stopCloudUpload(cloudRef.current.sessionId);
      cloudRef.current = { sessionId: null, stop: null };
    };
  }, [open, dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // A waiting file decided ELSEWHERE (the Files tab, the phone taking it back)
  // leaves the list.
  useEffect(() => {
    if (!open) return undefined;
    return subscribeIncoming((list) => {
      const ids = new Set(list.map((p) => p.id));
      setArrivals((cur) => {
        const next = cur.filter((x) => x.state !== 'held' || x.busy || !x.heldId || ids.has(x.heldId));
        return next.length === cur.length ? cur : next;
      });
    });
  }, [open]);

  // Files arriving over Wi-Fi.
  useEffect(() => {
    if (!open) return undefined;
    return onPhoneUploadEvent((ev) => {
      if (!ev || ev.token !== localTokenRef.current) return;
      const key = `local:${ev.id}`;
      if (ev.type === 'start') upsert(key, { route: 'local', name: ev.name, size: ev.size, received: 0, state: 'receiving' });
      else if (ev.type === 'progress') upsert(key, { received: ev.received, size: ev.size || ev.received });
      else if (ev.type === 'held') upsertHeld(key, { name: ev.name, received: ev.size, size: ev.size, state: 'held', heldId: ev.id, path: ev.path });
      else if (ev.type === 'withdrawn') setArrivals((list) => list.filter((x) => x.heldId !== ev.id));
      else if (ev.type === 'live') setArrivals((list) => list.map((x) => (x.heldId === ev.id ? { ...x, live: true } : x)));
      else if (ev.type === 'error') upsert(key, { state: 'error', error: ev.error === 'connection_lost' ? 'The phone disconnected' : 'Not saved' });
    });
  }, [open, upsert, upsertHeld]);

  // Dismissing FADES the window out: it stays drawn for the fade after `open`
  // goes false (the routes are already closed by then — the effects above
  // answer `open` itself).
  const [shown, setShown] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); setClosing(false); return undefined; }
    if (!shown) return undefined;
    setClosing(true);
    const t = setTimeout(() => { setShown(false); setClosing(false); }, FADE_MS);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing with files still WAITING in the list asks first: they will be
  // rejected (deleted here; the phone page then marks them Rejected, with Send
  // again / Remove). With nothing waiting it just closes.
  const [confirmClose, setConfirmClose] = useState(false);
  const waitingRef = useRef([]);
  waitingRef.current = arrivals.filter((x) => x.state === 'held' && x.heldId);
  const requestClose = useCallback(() => {
    if (waitingRef.current.length) setConfirmClose(true);
    else onClose?.();
  }, [onClose]);
  const rejectAllAndClose = async () => {
    setConfirmClose(false);
    const list = waitingRef.current;
    for (const x of list) await decideIncoming(x.heldId, false);
    onClose?.();
  };
  useEffect(() => { if (!open) setConfirmClose(false); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !confirmClose) requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, requestClose, confirmClose]);

  // A click on a waiting file imports it; Import imports every one.
  const acceptArrival = async (a) => {
    upsert(a.key, { busy: true });
    const res = await decideIncoming(a.heldId, true);
    if (res?.ok) upsert(a.key, { busy: false, state: 'done', path: res.path || a.path, name: res.name || a.name });
    else upsert(a.key, { busy: false });
  };
  const [importing, setImporting] = useState(false);
  // Import: the TICKED files go into the folder; the ones left unticked are
  // discarded (the phone shows them as rejected, to send again if wanted).
  const importAll = async () => {
    setImporting(true);
    for (const x of waitingRef.current) {
      if (x.ticked === false) await rejectArrival(x);
      else await acceptArrival(x);
    }
    setImporting(false);
    // Done: nothing is waiting any more, so the window simply closes.
    onClose?.();
  };
  const toggleArrival = (a) => upsert(a.key, { ticked: a.ticked === false });

  // × : a waiting file is rejected (deleted); one already added goes to the
  // project's Trash. Either way, off the list.
  const rejectArrival = async (a) => {
    upsert(a.key, { busy: true });
    const res = a.state === 'held' ? await decideIncoming(a.heldId, false) : await onReject?.(a.path, a.name);
    if (res?.ok === false) { upsert(a.key, { busy: false }); return; }
    setArrivals((list) => list.filter((x) => x.key !== a.key));
  };

  if (!shown) return null;
  const busy = arrivals.some((a) => a.state === 'receiving' || a.state === 'taking');
  const doneCount = arrivals.filter((a) => a.state === 'done').length;
  const waitCount = arrivals.filter((a) => a.state === 'held').length;
  const tickCount = arrivals.filter((a) => a.state === 'held' && a.ticked !== false).length;
  const leftOut = waitCount - tickCount;

  return createPortal(
    <div className={`pum-scrim${closing ? ' is-closing' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) requestClose(); }}>
      <div className="pum" role="dialog" aria-modal="true" aria-labelledby="pum-title">
        <div className="pum-main">
        <header className="pum-head">
          <div>
            <h2 id="pum-title" className="pum-title">Import files</h2>
            <p className="pum-sub">Into <strong>{folderLabel || 'this folder'}</strong>{projectName ? <> in {projectName}</> : null}.</p>
          </div>
          <button type="button" className="pum-close" aria-label="Close" onClick={requestClose}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <button type="button" className="pum-computer" onClick={() => { onPickFromComputer?.(); }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
          Choose files from this computer
        </button>

        <p className="pum-or"><span>or scan with your phone</span></p>

        {/* ONE code at a time: the local network's, or — switched on — the
            cloud's, made the moment it is asked for (the session lives until
            the window closes, so switching back and forth keeps both). The
            switch stands above the code. */}
        <div className="pum-routes-bar">
          <RuleOptions
            field={ROUTE_FIELD}
            value={useCloud ? 'cloud' : 'local'}
            onPick={(id) => {
              const on = id === 'cloud';
              setUseCloud(on);
              if (on && cloud.idle) startCloud();
              if (!on && local.idle) startLocal();
            }}
          />
        </div>
        <div className="pum-routes">
          {useCloud ? (
            <RouteCard
              tag="Any connection"
              title="DocVex cloud"
              sub="Works on mobile data or another network."
              points={['Files are encrypted on the phone — DocVex’s cloud only ever holds them encrypted, and deletes them as soon as they’re on this computer.', 'Up to 50 MB a file.', 'Works only while this window is open — closing it closes the page on the phone.']}
              state={cloud}
              onRenew={() => startCloud()}
              kept
              onNewAddress={() => startCloud(true)}
            />
          ) : (
            <RouteCard
              tag="Same Wi-Fi"
              title="Local network"
              sub="Straight from the phone to this computer."
              warning="Same Wi-Fi: files are encrypted, but anyone who can tamper with this network could interfere. Prefer DocVex cloud on shared or guest networks."
              points={['The phone must be on the same Wi-Fi as this computer.', 'Files never leave your network.', 'Works only while this window is open — closing it closes the page on the phone.']}
              state={local}
              onRenew={() => startLocal()}
              kept
              onNewAddress={() => startLocal(true)}
            />
          )}
        </div>
        </div>

        {/* What has arrived, as the Files tab shows files — under the QR
            code, newest first. Nothing yet: no section, no Import button. */}
        {arrivals.length > 0 && (
        <aside className="pum-side" aria-label="Received files">
          <div className="pum-side-head">
            <span className="pum-side-title">
              Received
              {arrivals.length > 0 && <span className="pum-side-count">{[waitCount && `${waitCount} waiting`, doneCount && `${doneCount} added`, busy && 'receiving…'].filter(Boolean).join(' · ')}</span>}
            </span>
          </div>
          {arrivals.length > 0 ? (
            <div className="fx-grid pum-grid">
              {arrivals.map((a) => <ArrivalTile key={a.key} a={a} onToggle={toggleArrival} />)}
            </div>
          ) : (
            <p className="pum-side-empty">Files sent from your phone appear here as they arrive.</p>
          )}
        </aside>
        )}

        {/* Import: every waiting file into the folder — the window's
            bottom-right corner. */}
        {arrivals.length > 0 && (
        <footer className="pum-foot">
          {leftOut > 0 && !importing && (
            <span className="pum-foot-note">{leftOut === 1 ? '1 unticked file will be discarded' : `${leftOut} unticked files will be discarded`}</span>
          )}
          <button type="button" className="pum-import" disabled={!waitCount || importing} onClick={importAll}>
            {importing ? 'Importing…' : tickCount ? `Import ${tickCount}` : waitCount ? 'Discard all' : 'Import'}
          </button>
        </footer>
        )}
      </div>
      <ConfirmModal
        open={confirmClose}
        title={waitCount === 1 ? 'Discard the waiting file?' : `Discard ${waitCount} waiting files?`}
        message={`${waitCount === 1 ? 'The file in the list hasn’t' : 'The files in the list haven’t'} been imported and will be lost. Your phone will show ${waitCount === 1 ? 'it' : 'them'} as rejected, so ${waitCount === 1 ? 'it' : 'they'} can be sent again.`}
        confirmLabel="Discard and close"
        cancelLabel="Keep them"
        destructive
        onConfirm={rejectAllAndClose}
        onCancel={() => setConfirmClose(false)}
      />
    </div>,
    document.body,
  );
}
