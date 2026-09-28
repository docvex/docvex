// CLOUD READING OF IMAGES — per project, OFF by default.
//
// Pictures and scanned pages are read ON THIS COMPUTER unless the project
// allows otherwise: PaddleOCR / Tesseract for text in images and scans
// (lib/paddleOcr, lib/ocr `recognizeCanvas`). With it on, images and page
// scans go to Anthropic (the `doc-ai` OCR action, Extract text's AI mode,
// Picture → Word, AI search's picture descriptions, the MRZ fallback).
// Recordings are never sent anywhere: DocVex does not transcribe.
//
// This switch governs IMAGES only. Extracted TEXT still reaches the
// AI through the features that exist to send it (the AI scan, the advisor,
// Research) — pseudonymising that is lib/pseudonymize's job.
//
// Kept per project and per device (localStorage, shared by every window of the
// app). The project a call belongs to is passed when the caller knows it;
// otherwise the one selected in this window is used (`setCloudMediaProject`,
// called by AppShell and the Doc Viewer).

const KEY = 'docvex:cloud-media:v1:';
const EVENT = 'docvex:cloud-media-changed';
let currentProject = null;

export const CLOUD_MEDIA_OFF = 'cloud_media_off';
export const CLOUD_MEDIA_MESSAGE = 'Cloud reading of images is switched off for this project, so this runs on this computer only. Turn it on in the Files tab’s AI scan card to use the AI for it.';

export function setCloudMediaProject(projectId) { currentProject = projectId || null; }

export function isCloudMediaAllowed(projectId = currentProject) {
  if (!projectId) return false;
  try { return localStorage.getItem(KEY + projectId) === '1'; } catch { return false; }
}

export function setCloudMediaAllowed(projectId, on) {
  if (!projectId) return;
  try {
    if (on) localStorage.setItem(KEY + projectId, '1');
    else localStorage.removeItem(KEY + projectId);
  } catch { /* storage unavailable: stays off */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } })); } catch { /* no window */ }
}

export function subscribeCloudMedia(fn) {
  const onLocal = () => fn();
  const onStorage = (e) => { if (e.key && e.key.startsWith(KEY)) fn(); };
  window.addEventListener(EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(EVENT, onLocal); window.removeEventListener('storage', onStorage); };
}
