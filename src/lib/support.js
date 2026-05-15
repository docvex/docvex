// Client wrapper for the `send-support-report` Edge Function. Same
// fire-and-forget `{ data, error }` shape as the project-mutation helpers
// in src/lib/projects.js (sendInvite / acceptInvite) so the modal can
// handle errors the same way the existing UIs do.
//
// Attachments are sent as base64-encoded blobs inside the JSON payload.
// Resend's API natively accepts base64 in its `attachments[].content`
// field, so the Edge Function can forward them through with minimal
// transformation. Total raw size is capped at 25 MB client-side; the
// Edge Function re-validates as defence in depth.

import { supabase } from './supabaseClient';
import { isElectron, isWebBuild, getAppVersion } from './platform';

// Decode a Blob into a JSON-safe base64 string (no `data:<mime>;base64,`
// prefix — just the raw payload Resend expects). Uses FileReader because
// it's available in both Electron renderer and web build; alternatives
// like `Buffer.from(await blob.arrayBuffer())` aren't available in the
// browser.
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:<mime>;base64,<b64>"
      const comma = String(result).indexOf(',');
      resolve(comma >= 0 ? String(result).slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// sendSupportReport({ subject?, description, attachments?, debug? })
//   subject:     optional. Edge Function falls back to "Bug report from
//                <user-email>" when null/empty.
//   description: required. The user's free-form description of the issue.
//   attachments: optional. Array of { filename, blob } — `blob` can be a
//                File (extra uploads) or a plain Blob (the html2canvas
//                screenshot). Each is base64-encoded before invoking.
//   debug:       optional. When true, the email goes to the signed-in
//                user's own inbox instead of the support address (used
//                by the DEBUG menu's "Send all email previews"). Auth is
//                still enforced server-side.
//
// Returns the supabase-js shape: { data, error }. On success, `data` is
// `{ ok: true, email_id }`. On failure, `error` is a FunctionsHttpError
// or a synthesized Error from the function's `{ error, detail }` body.
export async function sendSupportReport({ subject, description, attachments, debug }) {
  const appVersion = await getAppVersion();
  const platform = isElectron ? 'electron' : (isWebBuild ? 'web' : 'unknown');
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  const url = typeof window !== 'undefined' ? window.location.href : 'unknown';
  const submittedAt = new Date().toISOString();

  const encoded = await Promise.all(
    (attachments || []).map(async (a) => ({
      filename: a.filename,
      content_type: a.blob.type || 'application/octet-stream',
      // content_base64 — naming mirrors the function's payload type;
      // Resend itself uses just `content`, the function renames before
      // forwarding.
      content_base64: await blobToBase64(a.blob),
    })),
  );

  const { data, error } = await supabase.functions.invoke('send-support-report', {
    body: {
      subject: subject?.trim() || null,
      description: description?.trim() || '',
      attachments: encoded,
      metadata: {
        app_version: appVersion,
        platform,
        user_agent: userAgent,
        url,
        submitted_at: submittedAt,
      },
      ...(debug ? { debug: true } : {}),
    },
  });

  // If the Edge Function returned a non-2xx with a structured error body,
  // synthesize a clearer Error so the modal's inline error reads usefully
  // ("attachments_too_large: total 28 MB exceeds 25 MB") instead of
  // supabase-js's generic "Edge Function returned a non-2xx status code".
  if (error) {
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body && (body.error || body.detail)) {
          const msg = body.detail
            ? `${body.error || 'function_error'}: ${body.detail}`
            : body.error;
          return { data: null, error: new Error(msg) };
        }
      }
    } catch { /* fall through */ }
    return { data: null, error };
  }
  if (data && data.error) return { data: null, error: new Error(data.error) };
  return { data, error: null };
}
