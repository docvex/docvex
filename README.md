<div align="center">

# Docvex

**A desktop workspace for documents, files, and team projects.**
Built with Electron + React + Supabase, distributed via auto-updating Windows installers.

[![Latest release](https://img.shields.io/github/v/release/petreluca1105-dotcom/docvex?include_prereleases&sort=semver&label=latest%20release&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)
[![Release date](https://img.shields.io/github/release-date/petreluca1105-dotcom/docvex?label=released&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/petreluca1105-dotcom/docvex/total?label=downloads&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](#install)

### ⬇️ [Download Docvex for Windows (v7.1.0)](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.1.0/docvex-7.1.0.Setup.exe)

[Browse all releases](https://github.com/petreluca1105-dotcom/docvex/releases) · [Latest (auto-redirect)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)

</div>

---

## 📥 Latest release

The newest installer is always at **[github.com/petreluca1105-dotcom/docvex/releases/latest](https://github.com/petreluca1105-dotcom/docvex/releases/latest)** — that URL is a GitHub-managed redirect that follows whichever tag was published most recently.

> **Direct link for the current version:** [docvex-7.1.0.Setup.exe](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.1.0/docvex-7.1.0.Setup.exe)

Once installed, Docvex auto-updates in the background (polls `update.electronjs.org` every 10 minutes) and applies the new version on next launch. See the in-app **Updates** tab for release notes and version history.

---

## ✨ What it does

- **Projects + Members** — shared workspaces with role-based access (owner / admin / member / viewer), invite collaborators by email, switch between projects from the sidebar.
- **Files** — per-project file storage backed by Supabase Storage with RLS-scoped access.
- **To-dos** — per-project task list with realtime sync across members.
- **Notifications** — persistent notification center grouped by day, synced across devices via Supabase Realtime; in-app toasts for transient events.
- **Auto-update** — `update.electronjs.org` polls GitHub Releases, downloads in the background, installs on next launch. AI-generated release notes are PATCHed onto each draft release.

---

## 💾 Install

### Windows
1. Click **[Download docvex-7.1.0.Setup.exe](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.1.0/docvex-7.1.0.Setup.exe)** (or [grab the latest](https://github.com/petreluca1105-dotcom/docvex/releases/latest)).
2. Run `Setup.exe`. Docvex installs to `%LocalAppData%\docvex` and adds itself to the Start menu.
3. Sign in with email + password or Google OAuth on first launch.

### macOS / Linux
Not packaged yet — see the **Build from source** section if you want to run on those platforms. macOS support is on the roadmap (signing + notarisation pending).
