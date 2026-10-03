import React, { useEffect, useState } from 'react';
import { BarPicker } from './LegalBar';
import Tooltip from './Tooltip';
import Toggle from './Toggle';
import ConfirmModal from './ConfirmModal';
import {
  AI_MODELS, aiModel, loadAiModel, saveAiModel, loadAiProjectFiles, saveAiProjectFiles, AI_SETTING_KEYS,
} from '../lib/aiEngine';
import './LegalBar.css';
import './AiControls.css';

// THE AI's COMPOSER CONTROLS — the model picker (Auto + every model) and the
// Project files switch, the same pair in Research and in the Doc Viewer's
// advisor. ONE setting for both (lib/aiEngine): changing it in one place
// changes it everywhere, other windows included (the `storage` event).
export function useAiSettings() {
  const [model, setModelState] = useState(loadAiModel);
  const [projectFiles, setFilesState] = useState(loadAiProjectFiles);
  useEffect(() => {
    const sync = () => { setModelState(loadAiModel()); setFilesState(loadAiProjectFiles()); };
    const onStorage = (e) => { if (!e.key || Object.values(AI_SETTING_KEYS).includes(e.key)) sync(); };
    window.addEventListener('docvex:ai-settings', sync);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('docvex:ai-settings', sync); window.removeEventListener('storage', onStorage); };
  }, []);
  return {
    model,
    setModel: (id) => { setModelState(id); saveAiModel(id); },
    projectFiles,
    setProjectFiles: (on) => { setFilesState(on); saveAiProjectFiles(on); },
    // One answer style, Direct (lib/aiEngine AI_STYLES) — no picker.
    style: 'direct',
  };
}

// WHERE THE AI's DATA GOES — said before it goes (GDPR Art. 13, security audit
// 2026-10-01). Until it has been read on this device the composer shows a
// highlighted "Your data" pill; afterwards a quiet "i" that opens the same
// note. A device preference (no personal data), so plain localStorage.
const NOTICE_KEY = 'docvex.aiNoticeSeen.v1';
const noticeSeen = () => { try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch { return false; } };
const AI_NOTICE = "What you ask, the file open in the viewer and — with Project files on — what DocVex knows about the project's files are sent through DocVex's servers to Claude, the AI made by Anthropic. Names, CNPs, ID numbers, IBANs and addresses are replaced with codes on this computer first, unless pseudonymisation is switched off for the project (Settings → Privacy); pictures and recordings stay here unless you allow them. Anthropic does not train its models on this data. It is processed through Google Cloud in the EU where that is set up, otherwise through Anthropic's own service in the United States. See the privacy policy at docvex.ro for details.";
export function AiNotice() {
  const [seen, setSeen] = useState(noticeSeen);
  const [open, setOpen] = useState(false);
  const ack = () => { try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* shown again next time */ } setSeen(true); setOpen(false); };
  return (
    <>
      <Tooltip content="How your data reaches the AI">
        <button type="button" className={`ai-ctrls-notice${seen ? '' : ' is-new'}`} onClick={() => setOpen(true)} aria-label="How your data reaches the AI">
          {seen ? 'i' : 'Your data'}
        </button>
      </Tooltip>
      <ConfirmModal open={open} title="How your data reaches the AI" message={AI_NOTICE} confirmLabel="Got it" cancelLabel="Close" onConfirm={ack} onCancel={() => setOpen(false)} />
    </>
  );
}

export default function AiControls({ settings, projectName = '', className = '' }) {
  const { model, setModel, projectFiles, setProjectFiles } = settings;
  const current = aiModel(model);
  return (
    <span className={`ai-ctrls${className ? ` ${className}` : ''}`}>
      <AiNotice />
      <Tooltip content={current.tip || `Answers with ${current.label}`}>
        <span className="ai-ctrls-model">
          <BarPicker solo label="Model" options={AI_MODELS} value={model} onChange={setModel} filter={false} />
        </span>
      </Tooltip>
      {projectName ? (
        <Toggle
          on={projectFiles}
          onChange={setProjectFiles}
          label="Project files"
          tip={projectFiles ? `The AI sees ${projectName}’s files` : `${projectName}’s files are left out`}
          className="ai-ctrls-files"
        />
      ) : null}
    </span>
  );
}
