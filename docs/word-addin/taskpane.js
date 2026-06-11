/* DocVex Legal AI — Word taskpane logic.
 *
 * Flow: Office.onReady → ensure a DocVex (Supabase) session → read the open
 * document's text via Office.js → POST it to the legal-assist Edge Function
 * (Claude) → render the markdown answer → optionally write it back into Word.
 *
 * Loaded as type="module" so we can dynamically import supabase-js from the
 * ESM CDN (no bundler in this static add-in).
 */

const cfg = window.DOCVEX_ADDIN_CONFIG || {};
let supabase = null;
let lastAnswer = ''; // raw markdown of the latest result, for Copy / Insert

// ── DOM helpers ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function showScreen(name) {
  $('auth').hidden = name !== 'auth';
  $('app').hidden = name !== 'app';
}
function toast(msg) {
  let el = document.querySelector('.da-toast');
  if (!el) { el = document.createElement('div'); el.className = 'da-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('is-show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('is-show'), 1600);
}

// ── Minimal Markdown → HTML (headings, bold, italic, code, lists) ──
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function inlineMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function renderMarkdown(md) {
  const lines = escapeHtml(md || '').split(/\r?\n/);
  let html = '';
  let listType = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inlineMd(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushPara(); closeList(); html += `<h2>${inlineMd(m[1])}</h2>`; continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { flushPara(); if (listType !== 'ul') { closeList(); listType = 'ul'; html += '<ul>'; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) { flushPara(); if (listType !== 'ol') { closeList(); listType = 'ol'; html += '<ol>'; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return html || '<p></p>';
}
// Strip markdown to plain text for clean insertion into the Word document.
function toPlainText(md) {
  return String(md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .trim();
}

// ── Result rendering ────────────────────────────────────────────────
function showThinking(label) {
  $('result-tools').hidden = true;
  $('result').innerHTML = `<div class="da-thinking"><div class="da-spinner"></div><span>${escapeHtml(label || 'Analizez documentul…')}</span></div>`;
}
function showError(msg) {
  $('result-tools').hidden = true;
  $('result').innerHTML = `<p class="da-error">${escapeHtml(msg)}</p>`;
}
function showAnswer(md) {
  lastAnswer = md || '';
  $('result').innerHTML = renderMarkdown(lastAnswer);
  $('result').scrollTop = 0;
  $('result-tools').hidden = !lastAnswer.trim();
}
function setBusy(busy) {
  document.querySelectorAll('.da-chip').forEach((b) => { b.disabled = busy; });
  $('ask-submit').disabled = busy;
}

// ── Office.js: read the document + write back ───────────────────────
async function readDocument() {
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load('text');
    const sel = context.document.getSelection();
    sel.load('text');
    await context.sync();
    return { documentText: body.text || '', selectionText: (sel.text || '').trim() };
  });
}
async function insertIntoDocument(md) {
  const text = toPlainText(md);
  if (!text) return;
  const paras = text.split(/\n+/).filter((p) => p.trim());
  await Word.run(async (context) => {
    const range = context.document.getSelection();
    // Insert bottom-up so paragraphs land in their original order after the
    // current selection / cursor.
    for (let i = paras.length - 1; i >= 0; i--) {
      range.insertParagraph(paras[i], Word.InsertLocation.after);
    }
    await context.sync();
  });
}

// ── AI call ─────────────────────────────────────────────────────────
async function runTask(task, question) {
  if (!supabase) { showError('Conexiune indisponibilă.'); return; }
  setBusy(true);
  showThinking(task === 'ask' ? 'Caut răspunsul…' : 'Analizez documentul…');
  try {
    const doc = await readDocument();
    if (!doc.documentText.trim()) { showError('Documentul pare gol — adaugă text și încearcă din nou.'); return; }

    const { data, error } = await supabase.functions.invoke(cfg.functionName, {
      body: { task, question, documentText: doc.documentText, selectionText: doc.selectionText },
    });

    if (error) {
      // Session expired → bounce back to sign-in.
      const status = error?.context?.status;
      if (status === 401 || status === 403) {
        await supabase.auth.signOut().catch(() => {});
        showScreen('auth');
        return;
      }
      showError(`Eroare la apelul AI: ${error.message || 'necunoscut'}`);
      return;
    }
    if (!data || !data.ok) { showError(`Eroare AI: ${(data && data.error) || 'necunoscut'}`); return; }
    showAnswer(data.answer);
  } catch (err) {
    showError(`Ceva n-a mers: ${err?.message || err}`);
  } finally {
    setBusy(false);
  }
}

// ── Auth ────────────────────────────────────────────────────────────
async function initSupabase() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}
function wireAuth() {
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const btn = $('auth-submit');
    const errEl = $('auth-error');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Se conectează…';
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { errEl.textContent = 'Email sau parolă incorecte.'; errEl.hidden = false; return; }
      showScreen('app');
    } catch (err) {
      errEl.textContent = `Eroare: ${err?.message || err}`;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Conectează-te';
    }
  });
  $('sign-out').addEventListener('click', async () => {
    await supabase.auth.signOut().catch(() => {});
    lastAnswer = '';
    showScreen('auth');
  });
}

// ── App wiring ──────────────────────────────────────────────────────
function wireApp() {
  document.querySelectorAll('.da-chip').forEach((btn) => {
    btn.addEventListener('click', () => runTask(btn.dataset.task));
  });

  const askInput = $('ask-input');
  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = '';
    askInput.style.height = 'auto';
    runTask('ask', q);
  });
  // Enter to send, Shift+Enter for newline; auto-grow.
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ask-form').requestSubmit(); }
  });
  askInput.addEventListener('input', () => {
    askInput.style.height = 'auto';
    askInput.style.height = `${Math.min(askInput.scrollHeight, 120)}px`;
  });

  $('copy-btn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toPlainText(lastAnswer)); toast('Copiat'); }
    catch { toast('Nu am putut copia'); }
  });
  $('insert-btn').addEventListener('click', async () => {
    try { await insertIntoDocument(lastAnswer); toast('Inserat în document'); }
    catch (err) { toast('Inserarea a eșuat'); }
  });
}

// ── Boot ────────────────────────────────────────────────────────────
Office.onReady(async (info) => {
  const boot = $('boot');
  if (!info || info.host !== Office.HostType.Word) {
    boot.innerHTML = '<p>Deschide acest add-in în Microsoft Word.</p>';
    return;
  }
  try {
    await initSupabase();
  } catch (err) {
    boot.innerHTML = `<p class="da-error">Nu am putut inițializa conexiunea: ${escapeHtml(err?.message || String(err))}</p>`;
    return;
  }
  wireAuth();
  wireApp();
  const { data: { session } } = await supabase.auth.getSession();
  showScreen(session ? 'app' : 'auth');
  boot.hidden = true;
});
