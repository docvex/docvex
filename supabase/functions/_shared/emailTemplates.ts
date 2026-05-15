// Shared HTML/text email builders for every transactional email the
// Docvex backend produces (welcome, invite). Lives outside any single
// function so welcome + invite render with the same chrome and only
// the inner body changes — same visual brand for every email the user
// sees from us.
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
}): string {
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
        <tr><td align="center" style="padding:0 16px 28px;">
          <h1 style="margin:0;font-size:32px;line-height:1.2;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">
            ${esc(args.heroTitle)}
          </h1>
        </td></tr>

        <!-- Content card -->
        <tr><td style="padding:0 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR_SLATE};border-radius:12px;">
            <tr><td style="padding:36px 36px 32px;color:${COLOR_TEXT};font-size:15px;line-height:1.6;">
              ${args.bodyHtml}
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding:32px 16px 8px;color:${COLOR_GOLD};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">
          ${TAGLINE}
        </td></tr>
        <tr><td align="center" style="padding:6px 16px 0;color:${COLOR_MUTED};font-size:11px;">
          &copy; 2026 DOCVEX. All rights reserved.
        </td></tr>

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
