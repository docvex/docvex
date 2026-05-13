import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

// Holds the global state for the "Report a problem" feature:
//   - whether the modal is open
//   - whether we're currently capturing a screenshot (so the sidebar
//     trigger can show a spinner while html2canvas runs)
//   - the captured screenshot blob + data URL (for the modal to preview)
//
// Exposed actions:
//   - captureAndOpen()    — capture the current screen via html2canvas,
//                           then open the modal. The screenshot is the
//                           page BEFORE the modal mounts, which is the
//                           whole point: the user clicks "Report a
//                           problem" while looking at the broken state,
//                           and the capture preserves that state.
//   - close()             — close the modal and clear the screenshot
//                           so the form resets cleanly on next open.
//   - removeScreenshot()  — clear just the screenshot (user clicked X
//                           on the thumbnail) but leave the modal open.
//
// Mounted by AppShell so both the Sidebar (trigger) and the
// ReportProblemModal (consumer) can share state without prop-drilling.

const ReportProblemContext = createContext(null);

export function ReportProblemProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // { blob, dataUrl } | null. blob is the binary used for upload;
  // dataUrl is what the <img> thumbnail in the modal renders. Keeping
  // both avoids re-encoding when the modal preview mounts.
  const [screenshot, setScreenshot] = useState(null);

  const captureAndOpen = useCallback(async () => {
    setCapturing(true);
    try {
      // Dynamic import keeps html2canvas (~50KB gzipped) out of the
      // initial bundle. Only fetched the first time the user clicks
      // "Report a problem". Subsequent clicks reuse the cached module.
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(document.body, {
        // Page background — html2canvas defaults to white, which would
        // look jarring for a dark-themed app. Matching the global page
        // bg keeps the capture indistinguishable from a real screenshot
        // of the app.
        backgroundColor: '#0f0f0f',
        // Allow cross-origin images (avatars, etc) to render — without
        // this, any <img> from a different origin gets a CORS-tainted
        // canvas and the export fails.
        useCORS: true,
        logging: false,
        // Skip Google avatar <img> elements. They 429 reliably under
        // html2canvas's concurrent-fetch pattern (Google rate-limits the
        // avatar CDN), and html2canvas would render a blank square in
        // their place anyway. Skipping cleanly avoids the console noise
        // and keeps the capture deterministic. Bug reports almost never
        // need avatar fidelity — the page state is what the support team
        // cares about.
        ignoreElements: (el) =>
          el.tagName === 'IMG'
          && typeof el.src === 'string'
          && el.src.includes('googleusercontent.com'),
        // Fail fast on any other slow / unreachable image so a single
        // hanging asset can't stall the whole capture. Default is 15 s;
        // 3 s is plenty for any same-origin image and bounds the worst
        // case for an unreachable CORS image at ~3 s.
        imageTimeout: 3000,
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const dataUrl = canvas.toDataURL('image/png');
      setScreenshot({ blob, dataUrl });
    } catch {
      // Capture failed (rare — html2canvas is fault-tolerant, but a
      // page with unsupported CSS features or a tainted canvas can
      // throw). Open the modal anyway with no screenshot so the user
      // can still send a description + optional manual uploads.
      setScreenshot(null);
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Drop the screenshot too so the next open starts clean — otherwise
    // the user might confusingly see a thumbnail of a different page
    // they were on minutes ago. captureAndOpen() always refreshes it.
    setScreenshot(null);
  }, []);

  const removeScreenshot = useCallback(() => setScreenshot(null), []);

  const value = useMemo(
    () => ({ open, capturing, screenshot, captureAndOpen, close, removeScreenshot }),
    [open, capturing, screenshot, captureAndOpen, close, removeScreenshot],
  );

  return (
    <ReportProblemContext.Provider value={value}>
      {children}
    </ReportProblemContext.Provider>
  );
}

export function useReportProblem() {
  const ctx = useContext(ReportProblemContext);
  if (!ctx) throw new Error('useReportProblem must be used inside <ReportProblemProvider>');
  return ctx;
}
