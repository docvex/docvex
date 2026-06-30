import React from 'react';
import Tooltip from './Tooltip';
import './TokenUsagePill.css';

// Small session-total token-usage indicator shown near a chat composer when the
// "Show token usage" setting is on (AppPrefs.showTokenUsage). `tokens` is the
// running input+output total for the current chat session.
export default function TokenUsagePill({ tokens = 0, title = 'Tokens used this chat' }) {
  return (
    <Tooltip content={title}>
      <span className="token-pill" aria-label={`${tokens} tokens used this chat`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v10M9 10h4.5a1.5 1.5 0 0 1 0 3H9h4.8a1.6 1.6 0 0 1 0 3.2H9" />
        </svg>
        <span className="token-pill-num">{Number(tokens || 0).toLocaleString()}</span>
        <span className="token-pill-unit">tokens</span>
      </span>
    </Tooltip>
  );
}
