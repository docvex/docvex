<div align="center">

# Docvex

**A desktop workspace for documents, files, and team projects.**
Built with Electron + React + Supabase, distributed via auto-updating installers for Windows and macOS.

[![Latest release](https://img.shields.io/github/v/release/petreluca1105-dotcom/docvex?include_prereleases&sort=semver&label=latest%20release&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)
[![Release date](https://img.shields.io/github/release-date/petreluca1105-dotcom/docvex?label=released&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/petreluca1105-dotcom/docvex/total?label=downloads&color=6366f1)](https://github.com/petreluca1105-dotcom/docvex/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#install)

### ⬇️ Download Docvex (v7.2.1)

- **Windows:** [docvex-7.2.1.Setup.exe](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-7.2.1.Setup.exe)
- **macOS (Apple Silicon):** [docvex-darwin-arm64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-arm64-7.2.1.zip)
- **macOS (Intel):** [docvex-darwin-x64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-x64-7.2.1.zip)

[Browse all releases](https://github.com/petreluca1105-dotcom/docvex/releases) · [Latest (auto-redirect)](https://github.com/petreluca1105-dotcom/docvex/releases/latest)

</div>

---

## 📥 Latest release

The newest installer is always at **[github.com/petreluca1105-dotcom/docvex/releases/latest](https://github.com/petreluca1105-dotcom/docvex/releases/latest)** — that URL is a GitHub-managed redirect that follows whichever tag was published most recently.

> **Direct links for the current version:**
> - Windows installer: [docvex-7.2.1.Setup.exe](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-7.2.1.Setup.exe)
> - macOS Apple Silicon (M-series): [docvex-darwin-arm64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-arm64-7.2.1.zip)
> - macOS Intel: [docvex-darwin-x64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-x64-7.2.1.zip)

Once installed, Docvex auto-updates in the background on Windows (polls `update.electronjs.org` every 10 minutes) and applies the new version on next launch. On macOS the app currently ships as a portable `.zip`; new versions can be downloaded from the in-app **Updates** tab or the [Releases page](https://github.com/petreluca1105-dotcom/docvex/releases).

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
1. Click **[Download docvex-7.2.1.Setup.exe](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-7.2.1.Setup.exe)** (or [grab the latest](https://github.com/petreluca1105-dotcom/docvex/releases/latest)).
2. Run `Setup.exe`. Docvex installs to `%LocalAppData%\docvex` and adds itself to the Start menu.
3. Sign in with email + password or Google OAuth on first launch.

### macOS

Pick the build that matches your chip:

| Mac | Download |
| --- | --- |
| **Apple Silicon** (M1 / M2 / M3 / M4) — most Macs since late 2020 | [docvex-darwin-arm64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-arm64-7.2.1.zip) |
| **Intel** — Macs from 2020 and earlier | [docvex-darwin-x64-7.2.1.zip](https://github.com/petreluca1105-dotcom/docvex/releases/download/v7.2.1/docvex-darwin-x64-7.2.1.zip) |

> Not sure which chip you have? Apple menu → **About This Mac**. If it says "Apple M1/M2/M3/M4", grab the arm64 build.

1. Download the `.zip` for your chip.
2. Double-click the zip to unpack it. Finder produces `docvex.app` in the same folder.
3. Drag `docvex.app` into your **Applications** folder.
4. First launch — macOS Gatekeeper will refuse to open an unsigned app from the internet. Right-click (or Control-click) `docvex.app` → **Open**, then click **Open** again in the dialog. macOS remembers this choice for future launches.
5. Sign in with email + password or Google OAuth.

> Gatekeeper alternative: if right-click → Open still fails, run this in Terminal to strip the quarantine attribute:
> ```bash
> xattr -dr com.apple.quarantine /Applications/docvex.app
> ```

### Linux
Not packaged yet — `npm run make` from source produces `.deb` and `.rpm` artifacts via the configured makers.
