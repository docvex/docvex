import './AiChoices.css';

// The clickable answers under an AI reply (lib/aiChoices): one pill per
// option; pressing it sends it as the reply. Only the latest reply shows them.
export default function AiChoices({ choices, onPick, disabled = false, className = '', label = 'Suggested answers' }) {
  if (!choices?.length) return null;
  return (
    <div className={`ai-choices${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {choices.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <button key={i} type="button" className="ai-choice" disabled={disabled} onClick={() => onPick?.(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}
