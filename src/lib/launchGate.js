// Tracks whether the user has passed through the launch hub this app launch.
//
// On a cold start the Electron renderer mounts fresh and the MemoryRouter
// begins at '/'. App.jsx redirects an authenticated user from '/' to the
// launch hub (/launch) UNLESS this flag is already set — that's how the
// Unity-Hub-style "pick a project first" screen appears exactly once per
// launch and not on every later visit to the home route.
//
// Backed by sessionStorage rather than localStorage on purpose:
//   - sessionStorage is cleared when the renderer/window closes, so a real
//     app restart starts unconsumed → the hub shows again.
//   - it survives an in-session reload / Vite HMR (which resets the router to
//     '/'), so picking a project then hot-reloading doesn't bounce the user
//     back to the hub.
//
// The flag is SET when the user leaves the hub (opens a project, creates one,
// or chooses "continue without a project") — set-on-leave, so a reload while
// the user is still sitting on the hub re-shows the hub rather than skipping it.

const KEY = 'docvex:launch-consumed';

export function isLaunchConsumed() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    // Private mode / storage disabled — fail "consumed" so we never trap the
    // user in a redirect loop they can't escape.
    return true;
  }
}

export function markLaunchConsumed() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* non-fatal — see isLaunchConsumed */
  }
}

export function resetLaunchGate() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
