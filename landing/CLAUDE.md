# CLAUDE.md — Marketing website (`landing/`)

This file documents the **Docvex marketing website** (the public site at
**docvex.ro**). It is a **separate codebase** from the Docvex application — the
Electron desktop app + its `/app` web variant are documented in the repo-root
[`../CLAUDE.md`](../CLAUDE.md). Don't conflate them.

> **Two marketing surfaces live in `landing/` (read this first).**
> | Surface | Source | Served at | Stack |
> | --- | --- | --- | --- |
> | **Current homepage** | `landing/home/` | docvex.ro **root** | Plain static HTML/CSS/JS — **no build step**, multi-page, **has Supabase auth** |
> | **Previous site** | `landing/src/` (+ `index.html`) | docvex.ro **`/old/`** | Vite + React 19 + TypeScript + Tailwind 4 + `motion` |
>
> The static `home/` site **replaced** the React site as the public homepage
> (commit "new homepage at root, old site → /old"). The React site still builds
> and deploys, just under `/old/` now (`vite.config.ts` `base: "/old/"`). Most
> of this doc below describes the **React `/old/` site**; the new static
> homepage is documented in its own section first.

## The static homepage (`landing/home/`) — current public site

Plain hand-written HTML/CSS/JS, **no build step** — files are deployed verbatim
to the `docs/` root. Multi-page (each `.html` is a real page, no router):

- `index.html` — homepage. `company.html`, `legal.html`, `installers.html`
  (Download), `enroll.html` (waitlist / demo form), `auth.html` (sign in / up),
  `account.html` (signed-in profile).
- `chrome.js` — shared site chrome injected into the **sub-pages** (the homepage
  has its own inline navbar). Builds the navbar + footer, wires the theme toggle,
  marks the active nav link, and renders the **account chip** from the Supabase
  session (avatar / name / status dot, morph-pill account menu, sign out). A page
  opts out of the injected navbar with `<html data-dvx-no-navbar>` (the login
  tab does) — footer + theme still apply. All classes are `dvx-`-prefixed.
- `chrome.css` — styles for that chrome.
- `supabase.js` — **standalone Supabase client** (`@supabase/supabase-js` from
  `esm.sh`, no bundler). **Same project as the app** (`pntxlvhkqfryyyxlqytr`),
  PKCE, `detectSessionInUrl: true`, default `sb-<ref>-auth-token` storage key —
  so an account created on the site is the **same account** used in the app, and
  the session is shared when both are served from the same origin. The anon
  (publishable) key is committed on purpose: it only grants what RLS allows.
- **Theme:** Cream / Ink, mirrored with the app via the `docvex.site.theme`
  localStorage key + `data-theme` on `<html>`. An inline `<script>` in each
  page's `<head>` applies the saved theme before paint to avoid a flash.
- `enroll.html` inserts waitlist / demo submissions into the **`enrollments`**
  Supabase table (`{ type, name, email, firm, message }`) — a real write, NOT
  the React site's old `mailto:` modal.

Everything below this section is the **React `/old/` site**.

## Stack

- **Vite 5** + **React 19** + **TypeScript** (`.tsx`).
- **Tailwind CSS 4** via the official `@tailwindcss/vite` plugin (NOT PostCSS).
  `@import "tailwindcss";` at the top of `src/globals.css`; theme tokens live in
  an `@theme inline { … }` block.
- **`motion` 12** (the Framer Motion successor) for animation — import from
  `motion/react` (`motion`, `AnimatePresence`, `useInView`, `useReducedMotion`).
- **lucide-react** for icons.
- **`cn()`** = `clsx` + `tailwind-merge` (`src/lib/utils.ts`) for conditional /
  conflict-free class strings.

> Migrated from Next.js: `App.tsx` replaces the old `layout.tsx`
> (DemoModalProvider wrapper) + `page.tsx` (the section list). Fonts that used
> `next/font` now load via a Google Fonts `<link>` in `index.html` (Inter, Plus
> Jakarta Sans, Cinzel).

## Workspace layout

`landing/` is an **npm workspace member** of the repo-root `docvex` package
(`workspaces: ["landing"]`). Its dependencies install into the **repo-root
`node_modules`** — run `npm install` at the repo root, never inside `landing/`.

## Commands (run from the repo ROOT)

```
npm run landing:dev                  # React /old/ site — Vite dev server → http://localhost:5175 (strictPort)
npm --prefix landing run build       # build the React /old/ site into landing/dist/ (base "/old/")
node scripts/landing-deploy.mjs      # assemble docs/: home/ → root, dist/ → docs/old/
```

The static **homepage** (`landing/home/`) has **no build step** — open the
`.html` files directly, or serve the folder with any static server; the deploy
just copies them. Only the React `/old/` site needs a build.

Only `landing:dev` is wired as a root script today. `landing:build` /
`landing:deploy` appear in `landing/README.md` but are NOT root scripts — use the
`--prefix landing run build` + `node scripts/landing-deploy.mjs` forms above.
(There is also `npm run newhome:dev` → port 5176 for the `public/newhomescreen`
static prototype.) `vite build` does not run `tsc`, so verify React-site changes
with `npm --prefix landing run build`.

**Port map** (all four can run at once): Electron `npm start` ~5173 · app
`web:dev` 5174 · `landing:dev` 5175 · `newhome:dev` 5176.

## Deploy — shared `docs/` folder

`docs/` is the **GitHub Pages root** that serves docvex.ro, and it is shared by
three independently-authored surfaces:

| Path | Built by | What |
| --- | --- | --- |
| `docs/` (root) | `scripts/landing-deploy.mjs`, from `landing/home/` | current static homepage |
| `docs/old/` | `scripts/landing-deploy.mjs`, from `landing/dist/` | previous React marketing site |
| `docs/app/` | `web:build` + `scripts/web-deploy.mjs` (the **app**) | the React web SPA |

`landing-deploy.mjs` runs two steps: **(1)** wipe + repopulate `docs/old/` from
`landing/dist/` (the React build), then **(2)** wipe the non-protected top-level
entries of `docs/` and re-copy `landing/home/` into the root. It **never
touches** a PROTECTED set: `app/`, `old/`, `CNAME`, `.nojekyll`, `invite.html`,
the SPA-fallback `404.html`, `favicon.ico`, and `favicon_old.ico`. It also
`git add docs` at the end. The React build's `vite.config.ts` uses
`base: "/old/"` so its assets resolve at `/old/assets/…`; the static homepage
uses relative paths so it works from the root.

## Source structure (`src/`)

- `main.tsx` — mounts `<App />`.
- `App.tsx` — wraps everything in `<DemoModalProvider>` and renders the section
  components in order: `Nav` · `Hero` · `Features` · `Security` · `LegalUpdates`
  · `ClientPortal` · `Pricing` · `FAQ` · `FinalCTA` · `Footer`.
- `components/site/` — one file per section, plus helpers:
  - **`DemoModalProvider`** — context (`useDemoModal()` → `{ open(intent?), close() }`)
    for a single shared dialog. Four `intent`s (`demo` / `waitlist` /
    `early-access` / `contact`) swap the copy; the form submits by building a
    `mailto:docvexteam@docvex.ro` URL (no backend). ESC-to-close + scroll lock.
    `DemoButton` is the trigger.
  - **`Reveal`** — fade-and-lift-on-scroll wrapper (`motion` + `useInView`,
    `once: true`); honors `prefers-reduced-motion`. The standard way to animate
    a section in. `CountUp` animates numbers similarly.
  - `Wordmark`, `Nav`, `Footer`, `FAQ` — presentational.
- `lib/utils.ts` — `cn()`.
- `globals.css` — Tailwind import + brand tokens + base styles.
- `@/*` path alias → `src/*` (set in both `tsconfig.json` and `vite.config.ts`).

## Design tokens & conventions

- **Brand tokens are the site's OWN system — different from the app's
  `tokens.css`.** Defined as `:root` CSS vars in `globals.css` and surfaced as
  Tailwind utilities via `@theme inline`:
  - Colors: `--color-navy-900/800/700` (primary navy), `--color-beige-300/200/100`,
    `--color-cream` (page bg), `--color-wood` / `-light` / `-dark` (accent).
  - Fonts: `--font-inter` → `font-sans`, `--font-jakarta` → `font-display`,
    `--font-cinzel` → `font-roman` (the serif display face).
  - `--shadow-luxury` / `--shadow-luxury-lg` for the soft elevated-card look.
- Single light "luxury" brand theme — **no dark mode / theme switching** (unlike
  the app). Don't add `data-theme` logic here.
- Style with **Tailwind utility classes**; reach for CSS vars via
  `bg-[var(--color-navy-900)]` etc. when a token isn't a first-class utility.
  Merge conditional classes with `cn(...)`.
- Animate with `motion` and prefer the existing `Reveal` wrapper over ad-hoc
  `motion.div`s so reduced-motion stays handled in one place.
- Icons: inline `lucide-react` components (or hand-written inline SVG, as the
  modal's close button does) — no icon font.
