import React, { useEffect } from 'react';
import Tooltip from './Tooltip';
import { registerHoverSpot } from '../lib/pointer';
import './Toggle.css';

// An ON / OFF switch with its label — the Playbook's Preview switch, made a
// component of its own so the Design system tab can stand it in its gallery.
// The same pill on and off (a faint tint, the app sidebar's border, frosted
// like the sidebar); the ACCENT only on the knob and a tint of it on its
// track while it is on; the track faded while off; the sidebar items'
// spotlight following the pointer on hover.
export default function Toggle({ on, onChange, label, tip = null, className = '', disabled = false, ariaLabel }) {
  // The spotlight: the pointer's place over the switch, as --item-spot-x/y,
  // written by the app's one pointer (lib/pointer).
  useEffect(() => registerHoverSpot('.tgl'), []);
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`tgl${on ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => onChange?.(!on)}
    >
      <span className="tgl-track"><span className="tgl-knob" /></span>
      <span className="tgl-label">{label}</span>
    </button>
  );
  return tip ? <Tooltip content={tip}>{button}</Tooltip> : button;
}
