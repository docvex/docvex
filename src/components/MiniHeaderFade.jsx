import { createPortal } from 'react-dom';

// The mini-header gap-strip fade (`.mini-fade` in styles/miniHeader.css),
// PORTALLED to document.body. Rendering it in place broke on surfaces whose
// ancestors carry a transform / filter — those turn position:fixed into
// "fixed relative to the ancestor", so the strip only spanned that container
// instead of the window. From <body> its left/right: 0 always reach the app
// window's horizontal edges.
export default function MiniHeaderFade({ visible }) {
  return createPortal(
    <div className={`mini-fade${visible ? ' is-visible' : ''}`} aria-hidden="true" />,
    document.body,
  );
}
