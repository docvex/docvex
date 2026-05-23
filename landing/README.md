# docvex-landing

Marketing landing page for docvex.ro. Built with **Vite + React + Tailwind 4**
— the same build solution as the rest of the repo (the Electron renderer and
the web app under `/app` are also Vite).

It is a workspace member of the root `docvex` package, so its dependencies live
in the repo-root `node_modules` (run `npm install` at the repo root, not here).

## Commands (run from the repo root)

```
npm run landing:dev      # Vite dev server (http://localhost:5175)
npm run landing:build    # build static site into landing/dist/
npm run landing:deploy   # build + merge into docs/ for GitHub Pages
```

`scripts/landing-deploy.mjs` merges `dist/` into `docs/` at the site root,
leaving the `/app` SPA, `CNAME`, `invite.html`, and the SPA-fallback `404.html`
untouched.
