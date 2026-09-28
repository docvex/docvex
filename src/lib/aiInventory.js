// THE AI INVENTORY — every AI the app reaches, as DATA, shown in the Debug tab
// (pages/Debug `AiInventory`). Kept as data rather than prose because the next
// step is to MERGE them: the same kind of work (answer a question about a file,
// read a picture, draft a paragraph…) is done today by different calls on
// different surfaces — the Doc Viewer's quick tools, the Advisor, Research,
// the Files scan — and each use carries the `surface` it lives on and the
// `task` it performs, so the Debug tab can group them either way and show
// where two surfaces already do the same job.
//
// Source of truth: supabase/functions/*, the `usageAction` labels passed to
// lib/projectAi, and CLAUDE.md. Update this file when an AI use is added,
// moved or removed.

export const AI_PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    role: 'The main AI',
    key: 'ANTHROPIC_API_KEY',
    tone: 'var(--accent)',
    privacy: 'Commercial API: not used for training; kept about 30 days for abuse monitoring.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    role: 'Transcription',
    key: 'OPENAI_API_KEY',
    tone: 'var(--success)',
    privacy: 'API: not used for training by default; kept about 30 days.',
    warning: 'CLAUDE.md says OPENAI_API_KEY is not configured yet, so transcription will not work until it is added.',
  },
];

// Where an AI use is reached from — the surfaces to unify later.
export const AI_SURFACES = {
  research: { name: 'Research tab', route: '/research' },
  'doc-viewer': { name: 'Doc Viewer (advisor + quick tools)', route: '/doc-viewer' },
  files: { name: 'Files tab (AI scan, search)', route: '/files' },
  insights: { name: 'Insights', route: '/files' },
  pictures: { name: 'Pictures & scans', route: '/doc-viewer' },
  legislation: { name: 'Legislation tab', route: '/legislation' },
  newsletter: { name: 'Newsletter', route: '/newsletter' },
  playbook: { name: 'Playbook', route: '/playbook' },
  design: { name: 'Design system tab', route: '/design' },
  'word-addin': { name: 'Word add-in', route: null },
};

// What an AI use DOES — the axis the merge will run along.
export const AI_TASKS = {
  chat: 'Answer questions / chat',
  draft: 'Draft or rewrite documents',
  extract: 'Read data out of files',
  ocr: 'Read text in pictures',
  transcribe: 'Transcribe audio',
  analyse: 'Compare / check / analyse',
  route: 'Pick a model',
  summarise: 'Summarise / brief',
  suggest: 'Suggest search terms / styles',
};

// The Edge Functions (every AI call goes through one of them) and their uses.
// A use: { id (usageAction or action), surface, task, what, model? }.
export const AI_FUNCTIONS = [
  {
    id: 'project-ai',
    provider: 'anthropic',
    title: 'The general AI backend',
    note: 'Carries most of the app\'s AI. Default model claude-opus-4-7; generating Office files uses claude-sonnet-4-6. The model picker allows claude-opus-5-5, claude-sonnet-5, claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6 and claude-haiku-4-5. Usage is logged to project_ai_usage.',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    uses: [
      { id: 'viewer', surface: 'doc-viewer', task: 'chat', isNew: true, what: 'The file viewer\'s advisor, on the UNIFIED AI (lib/aiEngine, surface viewer): Auto, the portal records a question names, the project\'s files (switch), the open file, legislation marked in the answer — plus creating files (write_document / ask_user, the Playbook rules and writing style on a draft) and editing them (paragraphs in place, edit blocks with Undo). Every version it writes is checked against the portals (the card only; no automatic correction turn).' },
      { id: 'paragraph-edit', surface: 'doc-viewer', task: 'draft', what: 'Rewrites a picked paragraph (unified AI: paragraphFrame in lib/aiEngine), with the turn\'s data.' },
      { id: 'constructor-rewrite', surface: 'doc-viewer', task: 'draft', what: 'Rewrites a paragraph through the Constructor.' },
      { id: 'complete-data', surface: 'doc-viewer', task: 'extract', what: 'Fills in missing data.' },
      { id: 'files-scan', surface: 'files', task: 'extract', model: 'claude-sonnet-5', what: 'Writes a short profile ("passport") of each file, cross-references the files, and builds the Data collections and the file graph.' },
      { id: 'insights-signatures', surface: 'insights', task: 'analyse', what: 'Compares signatures and stamps across documents.' },
      { id: 'insights-ask', surface: 'insights', task: 'analyse', what: 'The Contradictions section\'s "Suggest" asks which version is right.' },
      { id: 'brief-suggest', surface: 'doc-viewer', task: 'suggest', what: 'The "What do you want to make?" screen reads what the neural network understood of the files and suggests the documents the case needs next.' },
      { id: 'brief-prefill', surface: 'doc-viewer', task: 'suggest', what: 'Answers the drafting brief (parties, collections, questions) from what the neural network understood of the files.' },
      { id: 'text-regions', surface: 'pictures', task: 'ocr', what: 'Reads the text strips that local OCR has already located in a photo.' },
      { id: 'image-to-word', surface: 'pictures', task: 'extract', what: 'Rebuilds a photographed document as a Word file.' },
      { id: 'identity-autofill', surface: 'pictures', task: 'extract', what: 'Reads ID cards, passports and company documents into records.' },
      { id: 'mrz', surface: 'pictures', task: 'extract', what: 'Reads the machine-readable strip of an ID or passport when the local reader fails.' },
      { id: 'writing-style', surface: 'playbook', task: 'suggest', what: 'Learns your writing voice for the Playbook.' },
      { id: 'restyle', surface: 'doc-viewer', task: 'draft', what: 'Restyles documents.' },
      { id: 'design-system', surface: 'design', task: 'suggest', what: 'Powers the Design system tab\'s AI composer.' },
      { id: 'legislation-search', surface: 'legislation', task: 'suggest', what: 'When a plain-words search finds nothing, suggests what the Romanian act would be called.' },
      { id: 'ai-file-index', surface: 'files', task: 'summarise', model: 'claude-haiku-4-5', what: 'The Files AI search uses one-time file descriptions (aiFileIndex).' },
      { id: 'research', surface: 'research', task: 'chat', isNew: true, what: "Research's AI, on the UNIFIED AI (lib/aiEngine, surface research): Auto, the portal records a question names (acts, court files, companies, CAEN codes), the project's files (switch) and legislation marked in the answer. It may not create or edit files. No standing rules; every step has a time limit. A line that is only an identifier is answered by the portal instead." },
      { id: 'research-summary', surface: 'research', task: 'summarise', isNew: true, what: 'The AI summary of an exact match (an act, a court file, a company, a CAEN code) — the whole record, summarised once on request by the model the composer names, kept in the chat.' },
      { id: 'ai-route', surface: 'research', task: 'route', model: 'claude-haiku-4-5', isNew: true, what: 'Auto (lib/aiEngine): picks the model for each question in Research and the file viewer — a quick local check first, the routing prompt only when it cannot tell.' },
      { id: 'ai-warm', surface: 'research', task: 'route', isNew: true, what: 'Cache warm-up (lib/aiEngine warmTurn): while a question is typed, its prefix (the open file, the project’s files) is written to the prompt cache with max_tokens 0 — nothing generated. Research and the file viewer.' },
    ],
  },
  {
    id: 'doc-ai',
    provider: 'anthropic',
    title: 'Doc Viewer tools',
    note: 'Ask, summary, risks, Romanian, draft and review on claude-opus-4-7; paid OCR on claude-haiku-4-5. Also carries the OpenAI Whisper call below.',
    models: ['claude-opus-4-7', 'claude-haiku-4-5'],
    uses: [
      { id: 'ask / summary / risks / romanian / draft / review', surface: 'doc-viewer', task: 'chat', model: 'claude-opus-4-7', what: 'The Doc Viewer\'s quick AI tools on the open document.' },
      { id: 'ocr', surface: 'pictures', task: 'ocr', model: 'claude-haiku-4-5', what: 'Paid OCR of scans and photos.' },
    ],
  },
  {
    id: 'legal-ai',
    provider: 'anthropic',
    title: 'Newsletter',
    models: ['claude-opus-4-7'],
    uses: [
      { id: 'digest', surface: 'newsletter', task: 'summarise', model: 'claude-opus-4-7', what: 'The weekly AI briefing.' },
      { id: 'ingest', surface: 'newsletter', task: 'summarise', what: 'Classifies and summarises legal texts.' },
    ],
  },
  {
    id: 'legal-feed-sync',
    provider: 'anthropic',
    title: 'Filling the Newsletter',
    models: ['claude-sonnet-5', 'claude-opus-5'],
    uses: [
      { id: 'screen', surface: 'newsletter', task: 'analyse', model: 'claude-sonnet-5', what: 'Acts from Monitorul Oficial are screened.' },
      { id: 'write', surface: 'newsletter', task: 'summarise', model: 'claude-opus-5', what: 'The feed entries are written.' },
    ],
  },
  {
    id: 'legal-assist',
    provider: 'anthropic',
    title: 'Word add-in',
    note: 'The backend for the DocVex Legal AI add-in for Microsoft Word. Deployed, but its source isn\'t in this repo.',
    models: ['claude-opus-4-7'],
    uses: [
      { id: 'summary / risks / romanian / ask', surface: 'word-addin', task: 'chat', model: 'claude-opus-4-7', what: 'The Word add-in\'s tasks.' },
    ],
  },
  {
    id: 'doc-ai · transcribe',
    provider: 'openai',
    title: 'Whisper',
    models: ['whisper-1'],
    uses: [
      { id: 'transcribe', surface: 'doc-viewer', task: 'transcribe', model: 'whisper-1', what: 'Transcribes audio and video for captions.' },
    ],
  },
];

// Features that use NO AI service — they run on the computer.
export const AI_LOCAL = [
  { name: 'PaddleOCR (Tesseract as fallback)', what: 'Finds text positions in pictures.' },
  { name: 'face-api', what: 'Face matching. Face data never leaves the machine.' },
  { name: 'ZXing', what: 'Reads barcodes and QR codes.' },
  { name: 'The app\'s own code', what: 'Legal citations, CNP and CUI checks, and old land-measure conversions.' },
];

export const AI_PRIVACY = 'Both services are called through their paid APIs, never through consumer apps like claude.ai or chatgpt.com. Anthropic and OpenAI don\'t train on API data but keep it about 30 days. (Deepgram, whose standard terms allow training, was removed.)';

export const AI_INTRO = 'DocVex uses two AI companies: Anthropic\'s Claude and OpenAI. The app never calls any of them directly. Every call goes through one of the Supabase Edge Functions, which hold the API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY).';

/** Every use, flattened, each carrying its function and provider. */
export function allAiUses() {
  return AI_FUNCTIONS.flatMap((f) => f.uses.map((u) => ({ ...u, fn: f.id, provider: f.provider, model: u.model || (f.models?.length === 1 ? f.models[0] : '') })));
}
