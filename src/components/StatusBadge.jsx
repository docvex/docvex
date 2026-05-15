import React from 'react';
import { getStatusOption } from '../lib/userStatus';
import Tooltip from './Tooltip';
import './StatusBadge.css';

// Small colored dot rendered absolutely-positioned over the bottom-right
// corner of an avatar. Caller is responsible for making the avatar's
// container `position: relative` (every consumer adds an *-avatar-wrap
// wrapper). When `onClick` is provided the badge renders as a <button>
// (focusable, keyboard-activatable); otherwise it's a decorative <span>.
//
// `ringColor` should match whatever surface the avatar sits on, so the
// 2px ring "cuts a hole" into the background instead of looking like a
// flat colored disc. Defaults to the page background.
//
// `offline` is rendered as a hollow ring to read as "absent" at a glance —
// the same convention Discord and Slack use.
export default function StatusBadge({
  status,
  size = 'sm',
  onClick,
  ringColor,
  ariaLabel,
}) {
  const option = getStatusOption(status);
  const isOffline = option.key === 'offline';
  const className = `status-badge status-badge-${size}${isOffline ? ' status-badge-offline' : ''}${onClick ? ' status-badge-interactive' : ''}`;
  const style = {
    '--status-color': option.color,
    '--status-ring': ringColor || 'var(--bg-page)',
  };

  if (onClick) {
    return (
      <Tooltip content={option.label}>
        <button
          type="button"
          className={className}
          style={style}
          onClick={onClick}
          aria-label={ariaLabel || `Status: ${option.label}. Click to change.`}
        />
      </Tooltip>
    );
  }
  return (
    <Tooltip content={option.label}>
      <span
        className={className}
        style={style}
        aria-label={ariaLabel || `Status: ${option.label}`}
      />
    </Tooltip>
  );
}
