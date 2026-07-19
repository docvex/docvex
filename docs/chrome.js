// Shared site chrome for sub-pages (auth, account): injects the same navbar +
// footer as the homepage and wires theme toggle, the signed-in account chip,
// the dropdown, sign out, and the activity-status dot. Single source so the
// sub-pages can't drift from each other.
const SUPABASE_AUTH_KEY = 'sb-pntxlvhkqfryyyxlqytr-auth-token';
const AVATAR_PALETTE = ['#0891B2','#BE185D','#4F46E5','#047857','#B45309','#6D28D9','#DC2626','#0369A1','#DB2777','#059669','#7C3AED','#EA580C'];
const STATUS_COLORS = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e' };

function djb2(seed) { let h = 0; seed = seed || ''; for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; } return Math.abs(h); }
function avatarColor(seed) { return AVATAR_PALETTE[djb2(seed) % AVATAR_PALETTE.length]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const ICON_THEME =
  '<svg data-theme-icon="cream" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
  '<svg data-theme-icon="ink" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const ICON_CARET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px;"><polyline points="6 9 12 15 18 9"/></svg>';
const ICON_USER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>';
const ICON_APP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';
const ICON_OUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

// ── Theme (shared via localStorage with the homepage) ──
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const root = document.getElementById('dv-root');
  if (root) root.setAttribute('data-theme', t);
  document.querySelectorAll('[data-theme-icon]').forEach((el) => {
    el.style.display = el.getAttribute('data-theme-icon') === (t === 'cream' ? 'ink' : 'cream') ? '' : 'none';
  });
  try { localStorage.setItem('docvex.site.theme', t); } catch (e) {}
}
function currentTheme() {
  try { return localStorage.getItem('docvex.site.theme') || 'cream'; } catch (e) { return 'cream'; }
}

// ── Session read (same logic as the homepage chip) ──
function readUser() {
  let raw; try { raw = localStorage.getItem(SUPABASE_AUTH_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let parsed; try { parsed = JSON.parse(raw); } catch (e) { return null; }
  const session = parsed && parsed.currentSession ? parsed.currentSession : parsed;
  const user = (session && session.user) || (parsed && parsed.user);
  if (!user) return null;
  const exp = session && session.expires_at;
  if (exp && !(session.refresh_token) && (exp * 1000) < Date.now()) return null;
  return user;
}

function navbarHTML() {
  return (
    '<header class="dvx-header"><div class="dvx-header-inner">' +
      '<a class="dvx-logo" href="index.html"><img class="dvx-lockup" src="assets/logo-lockup.png" alt="DocVex — Intelligent Legal Workflows"></a>' +
      '<nav class="dvx-nav">' +
        '<a href="index.html">Home</a>' +
        '<a href="company.html">Company</a>' +
        '<a href="legal.html">Legal</a>' +
        '<a href="installers.html">Download</a>' +
        '<a href="enroll.html">Enroll</a>' +
      '</nav>' +
      '<div class="dvx-actions">' +
        '<button type="button" class="dvx-theme" id="dvxTheme" title="Toggle theme" aria-label="Toggle theme">' + ICON_THEME + '</button>' +
        '<span id="dvxAuthButtons" style="display:contents;">' +
          '<a class="dvx-signin" href="auth.html">Sign in</a>' +
          '<a class="dvx-signup" href="auth.html?mode=signup">Sign up</a>' +
        '</span>' +
        '<div class="dvx-chip" id="dvxChip" hidden>' +
          '<button class="dvx-chip-trigger" id="dvxChipTrigger" type="button" title="Account">' +
            '<span class="dvx-chip-avatarwrap"><span class="dvx-chip-avatar" id="dvxAvatar"></span><span class="dvx-chip-status" id="dvxStatus" hidden></span></span>' +
            '<span class="dvx-chip-text"><span class="dvx-chip-name" id="dvxName"></span><span class="dvx-chip-email" id="dvxEmail"></span></span>' +
            ICON_CARET +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div></header>'
  );
}

// Scroll-aware header: transparent + taller at the very top, compact + bordered
// on scroll — identical to the homepage's inline .dv-header behaviour.
function wireScrollHeader() {
  var hdr = document.querySelector('.dvx-header');
  if (!hdr) return;
  function onScroll() {
    var atTop = window.scrollY < 8;
    hdr.classList.toggle('at-top', atTop);
    document.documentElement.classList.toggle('dvx-attop', atTop);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// Mark the nav link matching the current page so the active tab reads at a glance.
function markActiveNav() {
  var path = window.location.pathname.replace(/\/+$/, '');
  var page = path.split('/').pop() || 'index.html';
  if (page === '' || page === 'index') page = 'index.html';
  // The legal document pages live under the "Legal" nav item.
  if (['terms.html', 'privacy.html', 'cookies.html', 'gdpr.html', 'security.html', 'dpa.html'].indexOf(page) !== -1) page = 'legal.html';
  var links = document.querySelectorAll('.dvx-nav a');
  for (var i = 0; i < links.length; i++) {
    var href = (links[i].getAttribute('href') || '').split('#')[0].split('?')[0];
    var on = href === page;
    links[i].classList.toggle('is-active', on);
    if (on) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}

function footerHTML() {
  const col = (title, links) =>
    '<div class="dvx-footer-col"><p class="dvx-footer-coltitle">' + title + '</p><ul>' +
    links.map((l) => '<li><a href="' + l[1] + '">' + l[0] + '</a></li>').join('') + '</ul></div>';
  return (
    '<footer class="dvx-footer"><div class="dvx-footer-inner">' +
      '<div class="dvx-footer-grid">' +
        '<div>' +
          '<div class="dvx-footer-brandrow"><img class="dvx-footer-lockup" src="assets/logo-lockup.png" alt="DocVex — Intelligent Legal Workflows"></div>' +
          '<p class="dvx-footer-tag">Intelligent legal workflows for modern law firms.</p>' +
          '<div class="dvx-footer-contact"><p><a href="mailto:docvexteam@docvex.ro">docvexteam@docvex.ro</a></p><p><a href="https://docvex.ro">docvex.ro</a></p></div>' +
          '<div class="dvx-footer-news">' +
            '<p class="dvx-footer-newstitle">Legal Newsfeed — weekly briefing</p>' +
            '<form class="dvx-footer-newsform" id="dvxNewsForm">' +
              '<input class="dvx-footer-newsinput" id="dvxNewsEmail" type="email" placeholder="you@firm.law" autocomplete="email" aria-label="Email for the newsletter">' +
              '<button class="dvx-footer-newsbtn" type="submit">Subscribe</button>' +
            '</form>' +
            '<p class="dvx-footer-newsmsg" id="dvxNewsMsg" hidden></p>' +
          '</div>' +
        '</div>' +
        col('Product', [['Features','index.html#features'],['Security','index.html#security'],['Updates','index.html#updates'],['Pricing','index.html#pricing'],['FAQ','index.html#faq'],['Download','installers.html']]) +
        col('Company', [['About','company.html#about'],['Customers','company.html#customers'],['Careers','company.html#careers'],['Contact','company.html#contact']]) +
        col('Legal', [['Terms &amp; Conditions','terms.html'],['Privacy Policy','privacy.html'],['Cookie Policy','cookies.html'],['GDPR Compliance','gdpr.html'],['Security Policy','security.html'],['Data Processing Agreement','dpa.html']]) +
      '</div>' +
      '<div class="dvx-footer-bottom"><p>© 2026 DOCVEX. All rights reserved.</p><p style="text-transform:uppercase; letter-spacing:0.22em;">Intelligent Legal Workflows</p></div>' +
    '</div></footer>'
  );
}

// Footer newsletter signup → enrollments table (type 'newsletter'; degrades to
// a tagged 'waitlist' row if the live table constrains the type column).
function wireNewsletter() {
  var form = document.getElementById('dvxNewsForm');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = (document.getElementById('dvxNewsEmail').value || '').trim();
    var msg = document.getElementById('dvxNewsMsg');
    var show = function (text, ok) { msg.textContent = text; msg.style.color = ok ? '' : 'var(--danger-soft)'; msg.hidden = false; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { show('Please enter a valid email address.', false); return; }
    import('./supabase.js').then(function (m) {
      return m.supabase.from('enrollments').insert({ type: 'newsletter', name: null, email: email, firm: null, message: null }).then(function (res) {
        if (res.error) return m.supabase.from('enrollments').insert({ type: 'waitlist', name: null, email: email, firm: null, message: '[newsletter subscription]' });
        return res;
      });
    }).then(function (res) {
      if (res && res.error) { show('Something went wrong — try again later.', false); return; }
      form.hidden = true;
      show('Subscribed — welcome to the briefing.', true);
    }).catch(function () { show('Something went wrong — try again later.', false); });
  });
}

function renderChip() {
  const auth = document.getElementById('dvxAuthButtons');
  const chip = document.getElementById('dvxChip');
  if (!auth || !chip) return;
  const user = readUser();
  if (!user) { auth.style.display = 'contents'; chip.hidden = true; return; }

  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || user.email || 'Account';
  document.getElementById('dvxName').textContent = name;
  document.getElementById('dvxEmail').textContent = user.email || '';

  const av = document.getElementById('dvxAvatar');
  if (meta.avatar_url) {
    av.style.background = 'transparent';
    av.innerHTML = '<img src="' + esc(meta.avatar_url) + '" alt="" referrerpolicy="no-referrer">';
  } else {
    av.textContent = (name.trim()[0] || '?').toUpperCase();
    av.style.background = avatarColor(user.id || user.email || name);
  }

  const dot = document.getElementById('dvxStatus');
  const status = meta.status || 'online';
  const color = STATUS_COLORS[status] || STATUS_COLORS.online;
  if (status === 'offline') { dot.style.background = 'var(--bg-page)'; dot.style.boxShadow = '0 0 0 2.5px var(--bg-page), inset 0 0 0 2px ' + color; }
  else { dot.style.background = color; dot.style.boxShadow = '0 0 0 2.5px var(--bg-page)'; }
  dot.title = status.charAt(0).toUpperCase() + status.slice(1);
  dot.hidden = false;

  auth.style.display = 'none';
  chip.hidden = false;
}

function wireChipMorph() {
  var trigger = document.getElementById('dvxChipTrigger');
  if (!trigger) return;

  var pill = null;   // current portalled pill (tooltip or menu)
  var curX = 0, curY = 0;
  var isMenu = false;
  var oldRect = null;
  var onKey = null, onDown = null;

  function getName() {
    var el = document.getElementById('dvxName');
    return (el && el.textContent) || 'Account';
  }

  function clamp(el) {
    var w = el.offsetWidth, h = el.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    // left-placed: grow leftward from cursor, matching the app's 'placement: left'
    var x = Math.max(8, Math.min(curX - 8 - w, vw - 8 - w));
    var y = Math.max(8, Math.min(curY + 8, vh - 8 - h));
    return { x: x, y: y };
  }

  function removePill() {
    if (pill) { pill.remove(); pill = null; }
  }

  function doSignOut() {
    import('./supabase.js').then(function(m) { return m.supabase.auth.signOut(); })
      .catch(function() { try { localStorage.removeItem(SUPABASE_AUTH_KEY); } catch(e) {} })
      .then(function() { renderChip(); });
  }

  function addDismiss() {
    onKey = function(e) { if (e.key === 'Escape') closeMenu(); };
    onDown = function(e) {
      if (pill && pill.contains(e.target)) return;
      if (trigger.contains(e.target)) return;
      closeMenu();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
  }
  function removeDismiss() {
    if (onKey) { window.removeEventListener('keydown', onKey); onKey = null; }
    if (onDown) { window.removeEventListener('mousedown', onDown, true); onDown = null; }
  }

  function openMenu() {
    // Snapshot tooltip rect for FLIP before removing it
    if (pill) { oldRect = pill.getBoundingClientRect(); removePill(); }
    isMenu = true;

    pill = document.createElement('div');
    pill.className = 'dvx-morph-pill is-menu';
    pill.setAttribute('role', 'menu');
    pill.innerHTML =
      '<ul class="dvx-morph-list" role="none">' +
        '<li role="none"><a class="dvx-morph-item" href="account.html" role="menuitem">' + ICON_USER + 'Account</a></li>' +
        '<li role="none"><button class="dvx-morph-item dvx-morph-danger" type="button" role="menuitem">' + ICON_OUT + 'Sign out</button></li>' +
      '</ul>';
    document.body.appendChild(pill);

    pill.querySelector('.dvx-morph-danger').addEventListener('click', function() {
      closeMenu(); doSignOut();
    });

    // Snap to position, then FLIP from tooltip size → menu size
    var pos = clamp(pill);
    pill.style.transition = 'none';
    pill.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
    void pill.offsetWidth;

    if (oldRect) {
      var newRect = pill.getBoundingClientRect();
      var sx = oldRect.width / newRect.width;
      var sy = oldRect.height / newRect.height;
      pill.style.transformOrigin = 'top right';
      pill.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px) scale(' + sx + ',' + sy + ')';
      void pill.offsetWidth;
      pill.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
      pill.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px) scale(1,1)';
      oldRect = null;
    } else {
      pill.style.transition = '';
    }

    addDismiss();
  }

  function closeMenu() {
    isMenu = false;
    removeDismiss();
    removePill();
  }

  // Cursor-following tooltip
  trigger.addEventListener('mousemove', function(e) {
    curX = e.clientX; curY = e.clientY;
    if (isMenu) return;
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'dvx-morph-pill';
      pill.setAttribute('role', 'tooltip');
      document.body.appendChild(pill);
    }
    pill.textContent = getName();
    var pos = clamp(pill);
    var first = !pill._placed;
    pill._placed = true;
    if (first) {
      pill.style.transition = 'none';
      pill.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
    }
  });

  trigger.addEventListener('mouseleave', function() {
    if (!isMenu) removePill();
  });

  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    if (isMenu) closeMenu(); else openMenu();
  });
}

function wire() {
  // Theme toggle
  document.getElementById('dvxTheme').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'cream' ? 'ink' : 'cream'));
  applyTheme(currentTheme()); // also syncs the icon visibility

  renderChip();
  window.addEventListener('storage', (e) => { if (e.key === SUPABASE_AUTH_KEY) renderChip(); });
  // Live same-tab updates: re-render on sign-in / sign-out / status change.
  // Registered unconditionally so a session adopted after load (e.g. the desktop
  // app's "Open account" hands one across in the URL) updates the chip without a reload.
  import('./supabase.js').then((m) => { m.supabase.auth.onAuthStateChange(() => renderChip()); }).catch(() => {});

  wireChipMorph();
}

function mount() {
  // A page can opt out of the navbar (e.g. the login tab) with
  // <html data-dvx-no-navbar> — the footer + theme still apply.
  var noNav = document.documentElement.hasAttribute('data-dvx-no-navbar');
  document.documentElement.classList.add('dvx-has-chrome');
  if (!noNav) {
    document.documentElement.classList.add('dvx-has-navbar');
    document.body.insertAdjacentHTML('afterbegin', navbarHTML());
    markActiveNav();
    wireScrollHeader();
  }
  document.body.insertAdjacentHTML('beforeend', footerHTML());
  wireNewsletter();
  if (!noNav) wire();
  else applyTheme(currentTheme());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
