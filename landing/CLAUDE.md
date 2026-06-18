# CLAUDE.md — Marketing website (`landing/`)

This file documents the **Docvex marketing website** (the public landing page at
**docvex.ro**). It is a **separate codebase** from the Docvex application — the
Electron desktop app + its `/app` web variant are documented in the repo-root
[`../CLAUDE.md`](../CLAUDE.md). Don't conflate them: this directory has its own
build, its own design tokens, and a different stack (Tailwind, `motion`,
TypeScript) from the app.

The site is a single static marketing page — no auth, no Supabase, no router.
Just sections that scroll, plus one "request a demo / join waitlist" modal that
submits via `mailto:`.

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
npm run landing:dev                  # Vite dev server → http://localhost:5175 (strictPort)
npm --prefix landing run build       # build static site into landing/dist/
node scripts/landing-deploy.mjs      # merge landing/dist/ → docs/ for GitHub Pages
```

Only `landing:dev` is wired as a root script today. `landing:build` /
`landing:deploy` appear in `landing/README.md` but are NOT root scripts — use the
`--prefix landing run build` + `node scripts/landing-deploy.mjs` forms above.
(There is also `npm run newhome:dev` → port 5176 for the `public/newhomescreen`
static prototype.) `vite build` does not run `tsc`, so verify changes with
`npm --prefix landing run build`.

**Port map** (all four can run at once): Electron `npm start` ~5173 · app
`web:dev` 5174 · `landing:dev` 5175 · `newhome:dev` 5176.

## Deploy — shared `docs/` folder

`docs/` is the **GitHub Pages root** that serves docvex.ro, and it is shared by
two independently-built things:

| Path | Built by | What |
| --- | --- | --- |
| `docs/` (root) | `scripts/landing-deploy.mjs` (this site) | the marketing page |
| `docs/app/` | `web:build` + `scripts/web-deploy.mjs` (the **app**) | the React web SPA |

`landing-deploy.mjs` wipes the landing-owned top-level entries of `docs/` and
re-copies `landing/dist/`, but **never touches** a PROTECTED set: `app/`,
`CNAME`, `.nojekyll`, `invite.html`, the SPA-fallback `404.html`, and
`favicon_old.ico`. It also `git add docs` at the end. `vite.config.ts` uses
`base: "/"` so assets resolve at `/assets/…` from the domain root.

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
