import React, { useEffect, useState } from 'react';
import { BarPicker } from './LegalBar';
import Tooltip from './Tooltip';
import Toggle from './Toggle';
import {
  AI_MODELS, aiModel, loadAiModel, saveAiModel, loadAiProjectFiles, saveAiProjectFiles, AI_SETTING_KEYS,
  AI_STYLES, aiStyle, loadAiStyle, saveAiStyle,
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
  const [style, setStyleState] = useState(loadAiStyle);
  useEffect(() => {
    const sync = () => { setModelState(loadAiModel()); setFilesState(loadAiProjectFiles()); setStyleState(loadAiStyle()); };
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
    style,
    setStyle: (id) => { setStyleState(id); saveAiStyle(id); },
  };
}

// HOW THE AI ANSWERS — the style presets (lib/aiEngine AI_STYLES): Claude
// (its own default), DocVex (formal, no emojis, a colleague at a law firm),
// Direct (just the information). One setting for Research and the file viewer.
export function AiStylePicker({ settings, className = '' }) {
  const cur = aiStyle(settings.style);
  return (
    <Tooltip content={`Answers: ${cur.tip}`}>
      <span className={`ai-ctrls-style${className ? ` ${className}` : ''}`}>
        <BarPicker solo label="Answer style" options={AI_STYLES} value={settings.style} onChange={settings.setStyle} filter={false} />
      </span>
    </Tooltip>
  );
}

export default function AiControls({ settings, projectName = '', withStyle = false, className = '' }) {
  const { model, setModel, projectFiles, setProjectFiles } = settings;
  const current = aiModel(model);
  return (
    <span className={`ai-ctrls${className ? ` ${className}` : ''}`}>
      <Tooltip content={current.tip || `Answers with ${current.label}`}>
        <span className="ai-ctrls-model">
          <BarPicker solo label="Model" options={AI_MODELS} value={model} onChange={setModel} filter={false} />
        </span>
      </Tooltip>
      {/* The answer style, right of the model picker. */}
      {withStyle ? <AiStylePicker settings={settings} /> : null}
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
