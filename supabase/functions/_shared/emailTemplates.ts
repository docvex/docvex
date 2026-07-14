// Shared HTML/text email builders for every transactional email the
// Docvex backend produces (welcome, invite, legal-newsfeed digest,
// password reset, role changed, notification digest, support receipt).
// Lives outside any single function so every email renders with the
// same chrome and only the inner body changes — same visual brand for
// every email the user sees from us.
//
// Layout convention is `<table>` + inline styles because that's the
// only reliable way to render consistently across Gmail web/mobile,
// Apple Mail, Outlook 365 web, and Outlook Desktop (which strips most
// modern CSS). CSS variables don't survive in email HTML; brand hex
// codes are pinned literally below — keep them in sync with
// `src/styles/tokens.css` if the brand palette ever shifts.

// ── Brand palette (mirrors src/styles/tokens.css `--color-*`) ────────────
const COLOR_INK = "#0F172A";     // dark navy — outer page bg
const COLOR_SLATE = "#1E293B";   // mid-navy — content card bg
const COLOR_DIVIDER = "#334155"; // 1px hairline used between feature rows
const COLOR_TEXT = "#F5F2EA";    // primary body text (the brand "cream")
const COLOR_MUTED = "#94A3B8";   // secondary text + footer copyright
const COLOR_GOLD = "#DCC9A3";    // brand sand — accents + CTA fill
const COLOR_INK_ON_GOLD = "#0F172A"; // CTA text color (navy on gold)
const COLOR_PANEL = "#15213A";       // inset panel bg (AI briefing, ticket summary, "Was" chip)
const COLOR_PANEL_LABEL = "#8A93A8"; // tiny uppercase labels inside inset panels
const COLOR_PANEL_VALUE = "#C9CEDC"; // de-emphasised values inside inset panels

// Public Supabase Storage URL for the brand logo. The bucket is created
// in migration `create_email_assets_bucket`; the file is uploaded once
// out-of-band via the Supabase Dashboard. Until the upload happens the
// `<img>` falls back to its alt text — emails still send and the
// layout still works, the brand mark is just absent.
const LOGO_URL =
  "https://pntxlvhkqfryyyxlqytr.supabase.co/storage/v1/object/public/email-assets/big_logo.png";

// Tagline echoed in the header bar AND the footer band — same string
// pulled from the brand PDF mockup so we keep it identical across the
// two surfaces. Stored as a constant so a future rename is a 1-line
// change.
const TAGLINE = "INTELLIGENT LEGAL WORKFLOWS";

// Bouncer / landing URL — same target the existing invite email uses.
// Deep-links into the desktop app on Windows when installed, falls
// back to the web app otherwise.
export const APP_URL = "https://docvex.ro";

// HTML-escape for any user-supplied string going into the body. Tiny
// because none of our values are HTML; we only need to neutralise the
// five characters that affect HTML parsing.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Outer chrome: dark-navy page bg, centered 640px-wide column with the
// brand strip → hero → content card → footer. Every email reuses this
// shell; callers pass the hero copy + a chunk of inner HTML that goes
// inside the content card.
//
// `previewText` populates the hidden Gmail/Apple Mail snippet shown
// next to the subject line in the inbox listing. Without it, mail
// clients pull the first visible line of the body — which would be
// the hero ("Welcome to DocVex."). The preview text is more useful
// when it's the next sentence ("Your workspace is ready.").
function wrapEmailShell(args: {
  heroTitle: string;
  bodyHtml: string;
  previewText: string;
  // Small gold eyebrow line above the hero ("Legal Newsfeed · Weekly").
  heroEyebrow?: string;
  // Content-card inset override — digest-style emails use a slightly
  // tighter 34px inset in the mockups (default 36px).
  cardPadding?: string;
  // Copyright line override (raw HTML, trusted constants only) — the
  // newsletter footer carries the SRL + postal-address line digest mail
  // legally needs instead of the plain "All rights reserved.".
  copyrightHtml?: string;
  // Extra pre-built footer rows (<tr>…</tr>, raw HTML) appended after the
  // copyright line — unsubscribe / notification-settings links.
  footerExtraHtml?: string;
}): string {
  const eyebrowRow = args.heroEyebrow
    ? `<tr><td align="center" style="padding:0 16px 6px;">
          <div style="color:${COLOR_GOLD};font-size:11px;letter-spacing:0.2em;text-transform:uppercase;font-weight:600;">${esc(args.heroEyebrow)}</div>
        </td></tr>`
    : "";
  const cardPadding = args.cardPadding ?? "36px 36px 32px";
  const copyrightHtml = args.copyrightHtml ?? "&copy; 2026 DOCVEX. All rights reserved.";
  // With extra rows below, the copyright row gives up its bottom flush so
  // the footer lines read as one block (4px + 2px rhythm from the mockups).
  const copyrightPad = args.footerExtraHtml ? "6px 16px 4px" : "6px 16px 0";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docvex</title>
</head>
<body style="margin:0;padding:0;background:${COLOR_INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${COLOR_TEXT};">
  <!-- Hidden preview text for the inbox listing. Padding spaces push
       any quoted text out of the snippet so the listing reads cleanly. -->
  <div style="display:none;font-size:1px;color:${COLOR_INK};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${esc(args.previewText)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR_INK};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;">

        <!-- Header band: logo + tagline -->
        <tr><td align="center" style="padding:8px 0 24px;">
          <img src="${LOGO_URL}" width="180" height="auto" alt="Docvex" style="display:block;border:0;outline:none;max-width:180px;height:auto;">
        </td></tr>

        <!-- Hero -->
        ${eyebrowRow}
        <tr><td align="center" style="padding:0 16px 28px;">
          <h1 style="margin:0;font-size:32px;line-height:1.2;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">
            ${esc(args.heroTitle)}
          </h1>
        </td></tr>

        <!-- Content card -->
        <tr><td style="padding:0 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR_SLATE};border-radius:12px;">
            <tr><td style="padding:${cardPadding};color:${COLOR_TEXT};font-size:15px;line-height:1.6;">
              ${args.bodyHtml}
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:32px 16px 8px;color:${COLOR_GOLD};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">
          ${TAGLINE}
        </td></tr>
        <tr><td align="center" style="padding:${copyrightPad};color:${COLOR_MUTED};font-size:11px;">
          ${copyrightHtml}
        </td></tr>
        ${args.footerExtraHtml ?? ""}

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Gold CTA button block. Tables-with-bg-color instead of <a style="display:inline-block">
// because Outlook Desktop ignores padding on inline <a>. The bulletproof
// pattern is a `<table>` whose cell holds the link and provides padding.
function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 0;">
    <tr><td align="center" bgcolor="${COLOR_GOLD}" style="background:${COLOR_GOLD};border-radius:8px;">
      <a href="${href}" target="_blank" rel="noopener"
         style="display:inline-block;padding:14px 36px;color:${COLOR_INK_ON_GOLD};font-weight:600;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        ${esc(label)}
      </a>
    </td></tr>
  </table>`;
}

// Compact left-aligned CTA variant used INSIDE callout boxes (the digest's
// "Affects your project" panel) — same bulletproof table pattern, smaller
// inset + type so it doesn't overpower the email's primary CTA.
function ctaButtonSmall(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td bgcolor="${COLOR_GOLD}" style="background:${COLOR_GOLD};border-radius:7px;">
      <a href="${href}" target="_blank" rel="noopener"
         style="display:inline-block;padding:10px 22px;color:${COLOR_INK_ON_GOLD};font-weight:600;font-size:11.5px;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        ${esc(label)}
      </a>
    </td></tr>
  </table>`;
}

// Thin hairline divider row — full-width table so Outlook honours it.
function dividerRow(paddingTop = "18px"): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td style="border-top:1px solid ${COLOR_DIVIDER};font-size:0;line-height:0;padding-top:${paddingTop};">&nbsp;</td>
  </tr></table>`;
}

// Inline SVG glyphs for the welcome email's feature list. Each is a
// small, gold-stroke icon matching one entry in the mockup. Rendered
// at fixed 18×18 px so Outlook honours the size — Outlook ignores CSS
// height/width on SVG, so we set them as attributes too.
//
// Outlook Desktop drops SVG entirely; the row falls back to just the
// label, which still reads as a clean list. Acceptable trade-off.
const ICON_BRIEFCASE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>`;
const ICON_FOLDER   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path></svg>`;
const ICON_SEARCH   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`;
const ICON_DOC      = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="14 3 14 9 20 9"></polyline></svg>`;
const ICON_GRID     = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>`;
const ICON_BELL     = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10 21a2 2 0 0 0 4 0"></path></svg>`;

// A single row in the "WITH DOCVEX, YOU CAN:" feature list. Icon left,
// label right, thin divider underneath. The `isLast` flag drops the
// divider on the last row so the list doesn't bottom out with a
// floating line above the closing copy.
function featureRow(icon: string, label: string, isLast = false): string {
  const border = isLast ? "" : `border-bottom:1px solid ${COLOR_DIVIDER};`;
  return `<tr><td style="padding:14px 4px;${border}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="28" style="padding-right:12px;">${icon}</td>
      <td valign="middle" style="color:${COLOR_TEXT};font-size:14px;line-height:1.4;">${esc(label)}</td>
    </tr></table>
  </td></tr>`;
}

// ── Welcome email ────────────────────────────────────────────────────────

export function welcomeEmail(): { subject: string; html: string; text: string } {
  const subject = "Welcome to DocVex.";

  const bodyHtml = `
    <p style="margin:0 0 18px;font-size:22px;line-height:1.35;color:#ffffff;font-weight:600;text-align:center;">
      Thank you for joining the future<br>of modern legal workflows.
    </p>
    <p style="margin:0 0 24px;color:${COLOR_MUTED};font-size:14px;line-height:1.6;text-align:center;">
      DocVex was built to help legal professionals simplify document-heavy work, organize legal documents securely, search files instantly, generate AI-powered summaries, manage workflows more efficiently, and stay updated with legal intelligence tools.
    </p>

    <!-- "Your workspace is now ready" row -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;">
      <tr>
        <td valign="middle" style="padding-right:12px;">${ICON_BRIEFCASE}</td>
        <td valign="middle" style="color:#ffffff;font-size:15px;font-weight:600;">Your workspace is now ready.</td>
      </tr>
    </table>

    <!-- Divider -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="border-top:1px solid ${COLOR_DIVIDER};font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>

    <!-- "WITH DOCVEX, YOU CAN:" label -->
    <p style="margin:24px 0 6px;color:${COLOR_GOLD};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">
      With DocVex, you can:
    </p>

    <!-- Feature rows -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${featureRow(ICON_FOLDER, "Organize legal documents securely")}
      ${featureRow(ICON_SEARCH, "Search files instantly")}
      ${featureRow(ICON_DOC,    "Generate AI-powered summaries")}
      ${featureRow(ICON_GRID,   "Manage workflows more efficiently")}
      ${featureRow(ICON_BELL,   "Stay updated with legal intelligence tools", true)}
    </table>

    <p style="margin:28px 0 8px;color:${COLOR_MUTED};font-size:13px;line-height:1.6;text-align:center;">
      We're excited to have you with us from the beginning. If you have any questions, feedback, or ideas, our team is always here to help.
    </p>
    <p style="margin:0 0 28px;color:${COLOR_GOLD};font-size:13px;text-align:center;">
      <a href="mailto:docvexteam@docvex.ro" style="color:${COLOR_GOLD};text-decoration:none;">docvexteam@docvex.ro</a>
      &nbsp;|&nbsp;
      <a href="${APP_URL}" style="color:${COLOR_GOLD};text-decoration:none;">docvex.ro</a>
    </p>

    ${ctaButton(APP_URL, "Access your workspace")}
  `;

  const html = wrapEmailShell({
    heroTitle: "Welcome to DocVex.",
    bodyHtml,
    previewText: "Your workspace is now ready.",
  });

  const text =
    "Welcome to DocVex.\n\n" +
    "Thank you for joining the future of modern legal workflows. " +
    "Your workspace is now ready.\n\n" +
    "With DocVex, you can:\n" +
    "  • Organize legal documents securely\n" +
    "  • Search files instantly\n" +
    "  • Generate AI-powered summaries\n" +
    "  • Manage workflows more efficiently\n" +
    "  • Stay updated with legal intelligence tools\n\n" +
    "Questions or feedback? docvexteam@docvex.ro\n\n" +
    `Access your workspace: ${APP_URL}\n`;

  return { subject, html, text };
}

// ── Invite email ────────────────────────────────────────────────────────

export function inviteEmail(args: {
  inviterName: string;
  inviterEmail: string;
  projectName: string;
  inviteRole: string;
  bouncerLink: string;
}): { subject: string; html: string; text: string } {
  const { inviterName, inviterEmail, projectName, inviteRole, bouncerLink } = args;

  const subject = `${inviterName} invited you to ${projectName}`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:22px;line-height:1.35;color:#ffffff;font-weight:600;text-align:center;">
      You've been invited to a project.
    </p>
    <p style="margin:0 0 24px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;text-align:center;">
      <strong style="color:#ffffff;">${esc(inviterName)}</strong>
      <span style="color:${COLOR_MUTED};">(${esc(inviterEmail)})</span>
      invited you to join
      <strong style="color:#ffffff;">${esc(projectName)}</strong>
      on DocVex as a <span style="color:${COLOR_GOLD};">${esc(inviteRole)}</span>.
    </p>

    ${ctaButton(bouncerLink, "Accept invitation")}

    <p style="margin:28px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      If the button above doesn't work, open
      <a href="${bouncerLink}" style="color:${COLOR_GOLD};text-decoration:none;word-break:break-all;">${esc(bouncerLink)}</a>
      in your browser — it opens the DocVex desktop app if you have it installed, or the web app otherwise.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="border-top:1px solid ${COLOR_DIVIDER};font-size:0;line-height:0;padding-top:18px;">&nbsp;</td>
    </tr></table>

    <p style="margin:18px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      Don't have DocVex yet? <a href="${APP_URL}" style="color:${COLOR_GOLD};text-decoration:none;">Download for Windows</a>.
      This invitation expires in 7 days.
    </p>
  `;

  const html = wrapEmailShell({
    heroTitle: "You've been invited.",
    bodyHtml,
    previewText: `${inviterName} invited you to join ${projectName} on DocVex.`,
  });

  const text =
    `${inviterName} (${inviterEmail}) invited you to join "${projectName}" on DocVex as a ${inviteRole}.\n\n` +
    `Accept the invitation:\n${bouncerLink}\n\n` +
    `The link opens the DocVex desktop app if you have it installed, or the web app otherwise.\n\n` +
    `Don't have DocVex installed yet? Get it from ${APP_URL}\n\n` +
    `This invitation expires in 7 days.`;

  return { subject, html, text };
}

// ── Legal Newsfeed weekly digest ─────────────────────────────────────────
//
// One update entry per `legal_updates` row picked for the week. When an
// update touches a project the recipient works on, pass `affectsProject`
// and the entry grows the gold "Affects your project" callout with its own
// review CTA — the mockup's action-needed treatment.

export type LegalDigestUpdate = {
  category: string;                  // pill copy, e.g. "GDPR"
  title: string;
  summary: string;
  link?: string;                     // "Read the full update →" target
  affectsProject?: {
    projectName: string;
    reviewLink: string;
  };
};

export function legalDigestEmail(args: {
  userFirstName: string;
  weekRange: string;                 // e.g. "Jul 7 – Jul 13"
  aiDigest: string;                  // legal-ai `digest` summary paragraph
  updates: LegalDigestUpdate[];
  unsubscribeLink?: string;
}): { subject: string; html: string; text: string } {
  const { userFirstName, weekRange, aiDigest, updates } = args;
  const unsubscribeLink = args.unsubscribeLink ?? APP_URL;

  const subject = `Your legal briefing — ${weekRange}`;
  const affectedCount = updates.filter((u) => u.affectsProject).length;
  const previewText =
    `${updates.length} legal update${updates.length === 1 ? "" : "s"} this week` +
    (affectedCount > 0
      ? ` — ${affectedCount === 1 ? "one affects" : `${affectedCount} affect`} a project you're working on.`
      : ".");

  const updateBlocks = updates.map((u, i) => {
    const isLast = i === updates.length - 1;
    // Entries with a callout end tight (6px) so the callout box reads as
    // part of the entry; plain entries keep the mockup's 14px close.
    const padBottom = u.affectsProject ? "6px" : "14px";
    const borders = `border-top:1px solid ${COLOR_DIVIDER};${isLast && !u.affectsProject ? `border-bottom:1px solid ${COLOR_DIVIDER};` : ""}`;
    const readLink = u.link && !u.affectsProject
      ? `<a href="${u.link}" style="color:${COLOR_GOLD};text-decoration:none;font-size:12.5px;font-weight:600;letter-spacing:0.02em;">Read the full update &rarr;</a>`
      : "";
    const entry = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="${borders}"><tr><td style="padding:18px 2px ${padBottom};">
      <span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${COLOR_INK_ON_GOLD};background:${COLOR_GOLD};padding:3px 9px;border-radius:999px;margin-bottom:10px;">${esc(u.category)}</span>
      <p style="margin:6px 0 6px;color:#ffffff;font-size:16px;font-weight:600;line-height:1.35;">${esc(u.title)}</p>
      <p style="margin:0${readLink ? " 0 10px" : ""};color:${COLOR_MUTED};font-size:13.5px;line-height:1.6;">${esc(u.summary)}</p>
      ${readLink}
    </td></tr></table>`;
    if (!u.affectsProject) return entry;
    const { projectName, reviewLink } = u.affectsProject;
    return entry + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 8px;"><tr><td style="background:rgba(220,201,163,0.10);border:1px solid ${COLOR_GOLD};border-radius:10px;padding:16px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="top" width="26" style="padding-right:10px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 21V4l1-1 14 6-6 3-3 8z"></path></svg></td>
        <td valign="top">
          <p style="margin:0 0 4px;color:${COLOR_GOLD};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;">Affects your project &middot; ${esc(projectName)}</p>
          <p style="margin:0 0 12px;color:${COLOR_TEXT};font-size:13.5px;line-height:1.6;">This update changes the requirements for documents in a project you're working on. Review the affected files and update them so they meet the new guidance.</p>
          ${ctaButtonSmall(reviewLink, `Review ${projectName}`)}
        </td>
      </tr></table>
    </td></tr></table>`;
  }).join("\n");

  const bodyHtml = `
    <p style="margin:0 0 20px;color:${COLOR_TEXT};font-size:15px;">Hi ${esc(userFirstName)}, here's what changed in the legal landscape over ${esc(weekRange)} — curated and summarized by Docvex AI.</p>

    <!-- AI weekly briefing -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR_PANEL};border:1px solid ${COLOR_DIVIDER};border-radius:10px;margin:0 0 26px;"><tr><td style="padding:18px 20px;">
      <div style="color:${COLOR_GOLD};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;margin-bottom:8px;">&#10022; AI Weekly Briefing</div>
      <p style="margin:0;color:${COLOR_PANEL_VALUE};font-size:13.5px;line-height:1.6;">${esc(aiDigest)}</p>
    </td></tr></table>

    <p style="margin:0 0 14px;color:${COLOR_GOLD};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">This week's updates</p>

    ${updateBlocks}

    <p style="margin:26px 0 8px;color:${COLOR_MUTED};font-size:13px;line-height:1.6;text-align:center;">See the full feed and filter by practice area inside Docvex.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 0;">
      <tr><td align="center" bgcolor="${COLOR_GOLD}" style="background:${COLOR_GOLD};border-radius:8px;">
        <a href="${APP_URL}" target="_blank" rel="noopener"
           style="display:inline-block;padding:14px 36px;color:${COLOR_INK_ON_GOLD};font-weight:600;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">Open the Newsfeed</a>
      </td></tr>
    </table>
  `;

  const html = wrapEmailShell({
    heroEyebrow: "Legal Newsfeed · Weekly",
    heroTitle: "This week in law.",
    bodyHtml,
    previewText,
    cardPadding: "34px 34px 30px",
    copyrightHtml: "&copy; 2026 DOCVEX SRL &middot; Str. Exemplu 12, Bucure&#537;ti, Rom&acirc;nia",
    footerExtraHtml: `<tr><td align="center" style="padding:2px 16px 0;color:${COLOR_MUTED};font-size:11px;">
      You receive this because you enabled the Legal Newsfeed digest. <a href="${unsubscribeLink}" style="color:${COLOR_GOLD};text-decoration:underline;">Unsubscribe</a>
    </td></tr>`,
  });

  const text =
    `This week in law — ${weekRange}\n\n` +
    `Hi ${userFirstName}, here's what changed in the legal landscape over ${weekRange} — curated and summarized by Docvex AI.\n\n` +
    `AI WEEKLY BRIEFING\n${aiDigest}\n\n` +
    `THIS WEEK'S UPDATES\n\n` +
    updates.map((u) => {
      let block = `[${u.category}] ${u.title}\n${u.summary}`;
      if (u.affectsProject) {
        block += `\n! Affects your project "${u.affectsProject.projectName}" — review it: ${u.affectsProject.reviewLink}`;
      } else if (u.link) {
        block += `\nRead the full update: ${u.link}`;
      }
      return block;
    }).join("\n\n") +
    `\n\nSee the full feed inside Docvex: ${APP_URL}\n\n` +
    `You receive this because you enabled the Legal Newsfeed digest. Unsubscribe: ${unsubscribeLink}\n`;

  return { subject, html, text };
}

// ── Password reset ───────────────────────────────────────────────────────
//
// Sent when the user requests a password reset. NOTE: Supabase Auth's
// built-in recovery mail is configured in the Dashboard (Auth → Email
// Templates) — this builder exists so a custom-SMTP / send-email-hook
// setup renders the reset mail with the same brand chrome as everything
// else. `resetLink` is the Supabase recovery URL (`{{ .ConfirmationURL }}`
// equivalent).

export function passwordResetEmail(args: {
  userEmail: string;
  resetLink: string;
}): { subject: string; html: string; text: string } {
  const { userEmail, resetLink } = args;

  const subject = "Reset your Docvex password";

  const bodyHtml = `
    <p style="margin:0 0 22px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;text-align:center;">
      We received a request to reset the password for <strong style="color:#ffffff;">${esc(userEmail)}</strong>. Choose a new password using the button below.
    </p>

    ${ctaButton(resetLink, "Reset password")}

    <p style="margin:24px 0 0;color:${COLOR_MUTED};font-size:12.5px;line-height:1.6;text-align:center;">
      For your security, this link expires in <strong style="color:${COLOR_TEXT};">60 minutes</strong> and can only be used once.
    </p>

    ${dividerRow()}

    <p style="margin:18px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      If the button doesn't work, paste this link into your browser:<br>
      <a href="${resetLink}" style="color:${COLOR_GOLD};text-decoration:none;word-break:break-all;">${esc(resetLink)}</a>
    </p>
    <p style="margin:16px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      Didn't request this? You can safely ignore this email — your password won't change.
    </p>
  `;

  const html = wrapEmailShell({
    heroTitle: "Reset your password.",
    bodyHtml,
    previewText: "Choose a new password — this link expires in 60 minutes.",
  });

  const text =
    `Reset your Docvex password\n\n` +
    `We received a request to reset the password for ${userEmail}.\n\n` +
    `Choose a new password:\n${resetLink}\n\n` +
    `For your security, this link expires in 60 minutes and can only be used once.\n\n` +
    `Didn't request this? You can safely ignore this email — your password won't change.\n`;

  return { subject, html, text };
}

// ── Project role changed ─────────────────────────────────────────────────

export function roleChangedEmail(args: {
  projectName: string;
  oldRole: string;
  newRole: string;
  changedBy: string;
  projectLink?: string;
}): { subject: string; html: string; text: string } {
  const { projectName, oldRole, newRole, changedBy } = args;
  const projectLink = args.projectLink ?? APP_URL;

  const subject = `Your role in ${projectName} changed`;

  const bodyHtml = `
    <p style="margin:0 0 24px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;text-align:center;">
      <strong style="color:#ffffff;">${esc(changedBy)}</strong> changed your role in <strong style="color:#ffffff;">${esc(projectName)}</strong>.
    </p>

    <!-- old role → new role -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 26px;"><tr>
      <td valign="middle" align="center" style="padding:10px 18px;background:${COLOR_PANEL};border:1px solid ${COLOR_DIVIDER};border-radius:9px;">
        <div style="color:${COLOR_PANEL_LABEL};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:3px;">Was</div>
        <div style="color:${COLOR_PANEL_VALUE};font-size:15px;font-weight:600;">${esc(oldRole)}</div>
      </td>
      <td valign="middle" style="padding:0 16px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${COLOR_GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></td>
      <td valign="middle" align="center" style="padding:10px 18px;background:rgba(220,201,163,0.12);border:1px solid ${COLOR_GOLD};border-radius:9px;">
        <div style="color:${COLOR_GOLD};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:3px;">Now</div>
        <div style="color:#ffffff;font-size:15px;font-weight:700;">${esc(newRole)}</div>
      </td>
    </tr></table>

    <p style="margin:0 0 24px;color:${COLOR_MUTED};font-size:13.5px;line-height:1.6;text-align:center;">
      Your permissions in this project have been adjusted to match your new role. Open the project to see what you can now do.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 0;">
      <tr><td align="center" bgcolor="${COLOR_GOLD}" style="background:${COLOR_GOLD};border-radius:8px;">
        <a href="${projectLink}" target="_blank" rel="noopener"
           style="display:inline-block;padding:14px 36px;color:${COLOR_INK_ON_GOLD};font-weight:600;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">Open ${esc(projectName)}</a>
      </td></tr>
    </table>

    <p style="margin:24px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      Think this is a mistake? Reply to this email or contact your project owner.
    </p>
  `;

  const html = wrapEmailShell({
    heroTitle: "Your access was updated.",
    bodyHtml,
    previewText: `${changedBy} updated your access in ${projectName}.`,
  });

  const text =
    `Your access was updated.\n\n` +
    `${changedBy} changed your role in "${projectName}".\n\n` +
    `Was: ${oldRole}\nNow: ${newRole}\n\n` +
    `Your permissions in this project have been adjusted to match your new role.\n` +
    `Open the project: ${projectLink}\n\n` +
    `Think this is a mistake? Reply to this email or contact your project owner.\n`;

  return { subject, html, text };
}

// ── Notification digest ("While you were away.") ─────────────────────────
//
// Row dots reuse the in-app notification category palette (light/Ink
// variants of --cat-* in tokens.css) so a category reads the same colour
// in the inbox as in the app's toast stack.

export type DigestNotification = {
  lead: string;                      // bolded lead, e.g. "3 files changed"
  rest?: string;                     // plain continuation, e.g. "in Mandate Alpha"
  timeAgo: string;                   // e.g. "2 hours ago"
  color?: string;                    // dot colour; defaults to brand gold
};

export function notificationDigestEmail(args: {
  unreadCount: number;
  notifications: DigestNotification[];
  settingsLink?: string;
}): { subject: string; html: string; text: string } {
  const { unreadCount, notifications } = args;
  const settingsLink = args.settingsLink ?? APP_URL;

  const subject = `You have ${unreadCount} new notifications`;

  const rows = notifications.map((n, i) => {
    const isLast = i === notifications.length - 1;
    const borders = `border-top:1px solid ${COLOR_DIVIDER};${isLast ? `border-bottom:1px solid ${COLOR_DIVIDER};` : ""}`;
    return `<tr><td style="padding:14px 4px;${borders}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td valign="top" width="16" style="padding:5px 12px 0 0;"><div style="width:9px;height:9px;border-radius:50%;background:${n.color ?? COLOR_GOLD};"></div></td>
      <td valign="top">
        <p style="margin:0 0 2px;color:${COLOR_TEXT};font-size:14px;line-height:1.45;"><strong style="color:#ffffff;">${esc(n.lead)}</strong>${n.rest ? ` ${esc(n.rest)}` : ""}</p>
        <p style="margin:0;color:${COLOR_PANEL_LABEL};font-size:12px;">${esc(n.timeAgo)}</p>
      </td>
    </tr></table></td></tr>`;
  }).join("\n");

  const bodyHtml = `
    <p style="margin:0 0 22px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;text-align:center;">
      You have <strong style="color:#ffffff;">${unreadCount} unread notifications</strong> across your projects.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${rows}
    </table>

    <p style="margin:24px 0 8px;color:${COLOR_MUTED};font-size:13px;line-height:1.6;text-align:center;">Open Docvex to catch up on everything and mark them as read.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 0;">
      <tr><td align="center" bgcolor="${COLOR_GOLD}" style="background:${COLOR_GOLD};border-radius:8px;">
        <a href="${APP_URL}" target="_blank" rel="noopener"
           style="display:inline-block;padding:14px 36px;color:${COLOR_INK_ON_GOLD};font-weight:600;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">View all notifications</a>
      </td></tr>
    </table>
  `;

  const html = wrapEmailShell({
    heroTitle: "While you were away.",
    bodyHtml,
    previewText: "Here's what happened across your projects while you were away.",
    cardPadding: "34px 34px 30px",
    footerExtraHtml: `<tr><td align="center" style="padding:2px 16px 0;color:${COLOR_MUTED};font-size:11px;">
      Manage email frequency in <a href="${settingsLink}" style="color:${COLOR_GOLD};text-decoration:underline;">notification settings</a>.
    </td></tr>`,
  });

  const text =
    `While you were away.\n\n` +
    `You have ${unreadCount} unread notifications across your projects.\n\n` +
    notifications.map((n) => `  • ${n.lead}${n.rest ? ` ${n.rest}` : ""} (${n.timeAgo})`).join("\n") +
    `\n\nOpen Docvex to catch up: ${APP_URL}\n\n` +
    `Manage email frequency in notification settings: ${settingsLink}\n`;

  return { subject, html, text };
}

// ── Support report receipt ───────────────────────────────────────────────
//
// The confirmation the REPORTER receives after send-support-report forwards
// their bug report to the support inbox (the report itself goes to
// customersupport@docvex.ro — this is the "we got it" back to the user).

export function supportReceiptEmail(args: {
  userEmail: string;
  reportId: string;
  reportSubject: string;
  submittedAt: string;               // pre-formatted, e.g. "Jul 13, 2026, 14:02"
}): { subject: string; html: string; text: string } {
  const { userEmail, reportId, reportSubject, submittedAt } = args;

  const subject = `We received your report — ${reportId}`;

  const bodyHtml = `
    <p style="margin:0 0 22px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;text-align:center;">
      We received your report and our support team is looking into it. We'll reply to <strong style="color:#ffffff;">${esc(userEmail)}</strong> as soon as we can.
    </p>

    <!-- Ticket summary -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR_PANEL};border:1px solid ${COLOR_DIVIDER};border-radius:10px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;border-bottom:1px solid ${COLOR_DIVIDER};">
        <div style="color:${COLOR_PANEL_LABEL};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:4px;">Reference</div>
        <div style="color:${COLOR_GOLD};font-size:15px;font-weight:700;font-family:'Courier New',monospace;">${esc(reportId)}</div>
      </td></tr>
      <tr><td style="padding:16px 20px;border-bottom:1px solid ${COLOR_DIVIDER};">
        <div style="color:${COLOR_PANEL_LABEL};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:4px;">Subject</div>
        <div style="color:${COLOR_TEXT};font-size:14.5px;">${esc(reportSubject)}</div>
      </td></tr>
      <tr><td style="padding:16px 20px;">
        <div style="color:${COLOR_PANEL_LABEL};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:4px;">Submitted</div>
        <div style="color:${COLOR_TEXT};font-size:14.5px;">${esc(submittedAt)}</div>
      </td></tr>
    </table>

    <p style="margin:0 0 6px;color:${COLOR_MUTED};font-size:13px;line-height:1.6;text-align:center;">
      Typical first response is within one business day. You can simply reply to this email to add more detail to your report.
    </p>

    ${dividerRow("20px")}

    <p style="margin:18px 0 0;color:${COLOR_MUTED};font-size:12px;line-height:1.6;text-align:center;">
      Need to reach us directly? <a href="mailto:customersupport@docvex.ro" style="color:${COLOR_GOLD};text-decoration:none;">customersupport@docvex.ro</a>
    </p>
  `;

  const html = wrapEmailShell({
    heroTitle: "Thanks — we're on it.",
    bodyHtml,
    previewText: "Thanks — we received your report and our team is on it.",
  });

  const text =
    `Thanks — we're on it.\n\n` +
    `We received your report and our support team is looking into it. We'll reply to ${userEmail} as soon as we can.\n\n` +
    `Reference: ${reportId}\n` +
    `Subject:   ${reportSubject}\n` +
    `Submitted: ${submittedAt}\n\n` +
    `Typical first response is within one business day. Reply to this email to add more detail to your report.\n\n` +
    `Need to reach us directly? customersupport@docvex.ro\n`;

  return { subject, html, text };
}
