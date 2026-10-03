// A drag that PANS a picture / a PDF page lays a transparent shield over the
// whole window for its length (2026-10-03). Two reasons, both about speed:
//   · the grabbing cursor comes from ONE element — the old rule
//     `body.dv-media-panning *` matched every element on the page, so starting
//     and ending a pan restyled all of them (a picture's extracted text is a
//     cell per LETTER: thousands);
//   · nothing under the pointer is HOVERED while the picture slides beneath
//     it — letter cells, highlight marks, code outlines, tooltips and the
//     app-wide legislation hit test all stay still.
// The drag's own window listeners still hear every move and the release.
export function beginPanShield() {
  if (typeof document === 'undefined') return () => {};
  const shield = document.createElement('div');
  shield.className = 'dv-pan-shield';
  shield.setAttribute('aria-hidden', 'true');
  shield.setAttribute('data-no-lawdetect', '');
  Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483000', cursor: 'grabbing', background: 'transparent' });
  document.body.appendChild(shield);
  document.body.classList.add('dv-media-panning');
  return () => { shield.remove(); document.body.classList.remove('dv-media-panning'); };
}
