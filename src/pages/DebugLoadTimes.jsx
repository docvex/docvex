// Debug → Load times (moved from Settings → Optimization): how quickly the
// app opens and switches tabs — what is always applied, and what the owner of
// the machine / the release process can still do.
import './DebugLoadTimes.css';

const LOAD_APPLIED = [
  'With a sign-in saved on this computer, the window opens at once instead of waiting for the sign-in to be refreshed over the internet.',
  'Fonts ship inside the app, so starting it never waits on a download from Google.',
  'The Files page starts loading at the same moment as the sign-in, not after it.',
  'A folder with nothing on screen yet is listed immediately, without the 300 ms pause.',
  'Less code to read at start-up: search-only code (about 70 KB) now loads the first time it is used.',
  'Warming the other tabs and the Legislation data waits until the app has settled, and runs only when the computer is idle.',
  'The update check, the “Open with DocVex” registration and the release-notes download are moved out of the first seconds.',
  'The “Open with DocVex” menu entry is written once per install instead of on every launch.',
  'The document viewer is prepared in the background later, so it does not compete with the first screen.',
  'Developer tools no longer load in the installed app.',
  'The app is built for its own browser engine, with the start-up code compressed.',
  'Auto-detecting the graphics preset reuses the last result, so it adds nothing to start-up.',
  'The installed app keeps its compiled code between launches (it is served from its own app protocol with a V8 code cache), so every start after the first spends less time compiling scripts. Sign-ins and preferences were moved over once.',
  'The window and tray icons are drawn at the size they are shown (80 KB and 2 KB instead of a 657 KB picture).',
  'Opening a project no longer loads the account-sync code just to check its version — it loads only when that check runs.',
];
const LOAD_SUGGESTIONS = [
  'Install the app on an SSD. Start-up reads hundreds of files, and a hard disk is the slowest part of an older office PC.',
  'Ask IT to exclude the DocVex install folder and the project folders from real-time antivirus scanning. On Windows, Defender scanning often costs more at start-up than the app itself.',
  'Sign the Windows installer with a code-signing certificate, so SmartScreen and antivirus trust it sooner and scan it less.',
  'Keep the Graphics quality preset on Auto, or pick Performance on computers without a dedicated graphics card.',
  'Keep project folders on the local disk rather than a network share. Every listing and preview then reads from disk, not the network.',
  'Keep the FPS counter hidden when you are not measuring: while it shows, the app redraws every frame.',
];
export default function DebugLoadTimes() {
  return (
    <section className="debug-load">
      <h2 className="debug-card-title">Load times</h2>
      <p className="debug-load-desc">How quickly the app opens and switches tabs. These optimizations are always on, whatever the graphics preset.</p>
      <div className="debug-load-cols">
        <div>
          <h4 className="debug-load-h">Always applied</h4>
          <ul className="debug-load-list is-done">{LOAD_APPLIED.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
        <div>
          <h4 className="debug-load-h">To make it faster still</h4>
          <ul className="debug-load-list">{LOAD_SUGGESTIONS.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}
