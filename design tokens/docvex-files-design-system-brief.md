# DocVex Files — Design System Brief (for Claude Design)

Use this as the design brief for any screen built in the style of the DocVex **Files** tab: the project's file explorer inside the DocVex desktop app. Everything below was read out of the app's own stylesheets on 25 Sep 2026 (`tokens.css`, `FilesWorkspace.css`, `miniHeader.css`, the file-glyph and folder-colour code). A `docvex-files-tokens.json` with the same values accompanies this file.

**Suggested prompt to paste alongside it:**
> Build a file-explorer screen in the DocVex Files style. Follow the attached design system exactly. Use a flat, transparent canvas on a faint dot grid. The page header is an uppercase accent eyebrow over a 44.8px Plus Jakarta Sans title and a one-line summary. A 40px frosted path bar sticks to the top once scrolled, holding the breadcrumbs, a size slider and a search field. Items are borderless tiles that only gain a 5% fill, a hairline and a soft shadow on hover. Selection is a 1px accent border with a 2.4px accent-tint ring. A frosted action bar floats 6.4px above the bottom edge. Cream theme by default, Ink as the dark variant. Icons are always sand (#DCC9A3), even in Cream. Everything is small and dense: 10.4px item names, 24px controls, 8px item radius.

---

## 1. Identity in one paragraph

A quiet, dense desktop explorer for a law practice's case files. **The files are the content and the chrome gets out of their way.** There is no card around the page and no panel behind the grid, just a faint dot grid. The header scrolls away and a slim frosted bar pins in its place. Items have no box until you touch them. There is one warm accent: cognac as text in Cream, sand in Ink and on every icon. Colour is otherwise kept for what a file *is*: Office blue, green and orange, a folder colour the user chose, red only for the trash.

---

## 2. Colour

Two themes, one identity. **Cream** is the default: a warm cream page with white surfaces and slate-ink text. **Ink** is the dark variant: a near-black page with blue-slate surfaces and cream text. The accent swaps from **cognac** (#8B5E3C, text and buttons in Cream) to **sand** (#DCC9A3) in Ink.

### Surfaces and ink

| Token | Cream | Ink | Use |
|---|---|---|---|
| `bg-page` | `#F5F2EA` | `#16181A` | Page behind the canvas. The canvas itself is transparent. |
| `bg-backdrop` | `#F9F9FA` | `#16181A` | Window backdrop; the seams around the floating bars |
| `dot-grid` | `rgba(15,23,42,.09)` | `rgba(245,242,234,.09)` | 0.96px dots on a 19.2px grid behind the page |
| `bg-card` | `#FFFFFF` | `#1E293B` | Menus, dialogs, the drop card |
| `bg-elevated` | `#FAF7F0` | `#2A3548` | Menu-item hover, preview box (Cream only), secondary buttons |
| `chrome-glass` | `rgba(255,255,255,.90)` | `rgba(22,24,26,.66)` | Pinned path bar and action bar, with a 6.4px blur |
| `item-fill` | `rgba(15,23,42,.05)` | `rgba(245,242,234,.05)` | The only fill a hovered or selected item takes |
| `control-fill` / `-hover` | 4% / 8% of `text-primary` | same | Search field at rest; hover on path-bar controls |
| `border` | `rgba(15,23,42,.10)` | `rgba(245,242,234,.10)` | 1px hairlines on menus, dialogs, the search field |
| `border-strong` | `rgba(15,23,42,.18)` | `rgba(245,242,234,.20)` | Item edge on hover, slider track, context-menu edge |
| `border-flat` | `#DEDCD7` | `#2C2E2F` | 1.5px edge of the frosted bars (opaque on purpose) |
| `text-primary` | `#0F172A` | `#F5F2EA` | Names, the title, the current breadcrumb |
| `text-secondary` | `#1E293B` | `#C9CEDC` | Other breadcrumbs, column headers, button labels, summary line |
| `text-muted` | `#6B7280` | `#8A93A8` | Date/Type/Size columns, category headings, status, placeholders |

### Accent

| Token | Cream | Ink | Use |
|---|---|---|---|
| `accent` | `#8B5E3C` | `#DCC9A3` | Selection border, focused search, drop targets, the eyebrow, active toggles, primary button |
| `accent-hover` | `#74502F` | `#C8B58E` | Hover on an accent-filled button |
| `accent-tint` | `rgba(139,94,60,.10)` | `rgba(220,201,163,.12)` | Selection ring, drop-target wash, focused search, active Select toggle |
| `icon-accent` | `#DCC9A3` | `#DCC9A3` | **Every icon and glyph, in both themes** |
| `hit-highlight` | accent at 30% | accent at 30% | Matched words in a content-search snippet |

**Icons wear the Ink palette everywhere.** In Cream, every SVG icon and file glyph uses Ink's colours: folders, crumb icons and file-type glyphs are sand, not cognac. The view, size and category controls in the path bar follow the same rule. Text and buttons stay cognac. The result is that a folder looks identical in both themes.

### Signals

| Token | Cream | Ink | Use |
|---|---|---|---|
| `danger` | `#B91C1C` | `#EF4444` | Trash count badge, drag-onto-trash edge, last 3 days before an item is removed for good |
| `danger-soft` | `#DC2626` | `#F87171` | Destructive menu items (Delete, Empty trash) |
| `warning` | `#B45309` | `#F59E0B` | Days-left ring and chip on items in the trash (30-day retention) |
| `overlay-scrim` | `rgba(15,23,42,.45)` | `rgba(0,0,0,.65)` | Behind dialogs |

### What a file is

These colours are the same in both themes. They describe the file, not the interface.

| Token | Value | Use |
|---|---|---|
| `office-word` | `#185ABD` | "W" badge, 6px left stripe on a rendered Word preview |
| `office-excel` | `#107C41` | "X" badge, stripe |
| `office-powerpoint` | `#C43E1C` | "P" badge, stripe |
| `office-pdf` | `#B5473F` | "PDF" badge, stripe |
| `office-page` | `#FFFFFF` + 0.8px `rgba(0,0,0,.16)` | The white paper behind an Office or text glyph |
| `ext-pill` | `#0F172A` on `#F5F2EA` text | "MD", "TXT" pill on text and unknown-format tiles |
| `whatsapp` | `#25D366` → `#128C7E` | WhatsApp chat exports only |
| Folder colours | red `#EF4444` · orange `#F97316` · amber `#F59E0B` · green `#22C55E` · teal `#14B8A6` · blue `#3B82F6` · violet `#8B5CF6` · pink `#EC4899` | Chosen per folder by right-click; the default is `icon-accent` |

---

## 3. Typography

**Families**
- Body: `'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Display (titles, headings, glyph letters): `'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`
- Mono: `'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace`. Used only for a file's path in Properties.

**Scale** (px / line-height / weight / tracking)

| Style | Size | LH | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `page-title` (display) | 44.8 | 1 | 700 | −0.04em | "Files", the folder name, or "Trash". One per page. |
| `section-title` (display) | 18.4 | — | 700 | −0.01em | AI-search invitation heading |
| `dialog-title` (display) | 14.4 | 1.3 | 700 | — | Consent / confirm dialogs (Properties 12, archive 12.8) |
| `empty-title` (display) | 13.6 | — | 700 | — | "Nothing here yet", "Trash is empty", "No matches" |
| `eyebrow` | 8.8 | — | 700 | 0.22em, UPPERCASE | "PROJECT FILES" in accent; its tail is 500 in `text-muted` |
| `kicker` | 12 | 1.55 | 400 | — | "6 files · 5.2 KB · Updated 25 Sept 2026" |
| `crumb` | 10 | — | 500 (root 600, current 700) | — | Breadcrumbs |
| `item-name` | 10.4 | 1.25 | 600 (list: 500) | — | Name under a tile, two lines max, centred |
| `column-header` | 9.2 | — | 700 | 0.06em, UPPERCASE | NAME · DATE · TYPE · SIZE |
| `meta` | 9.6 | — | 400 | — | List Date/Type/Size, search snippets |
| `category-head` | 9.6 | — | 700 | 0.1em, UPPERCASE | "OFFICE DOCUMENTS" + count pill + hairline |
| `control` | 10.4 | — | 500 (active 600) | — | Action-bar buttons, search text, Create menu |
| `menu-item` | 10.88 | — | 500 | — | Right-click menu |
| `tooltip` | 9.6 | 1.2 | 500 | — | Cursor-following hint pill, never wraps |
| `status` | 9.2 | — | 400 | — | "3 selected" |
| `label` | 8.8 | — | 700 | 0.05em, UPPERCASE | Properties field labels |
| `body` | 10.4 | 1.5 | 400 | — | Empty-state text (max 304 wide), dialog copy at 10.8 |
| `kbd` | 9.6 | 1 | 600 | 0.02em | "Ctrl F" in the search field |
| `ext-pill` | 7.2 | 1.5 | 800 | 0.06em, UPPERCASE | "MD" |
| `glyph-letter` (display) | 8.8 | — | 700 (Office 800) | 0.06em | Letters on file glyphs |
| `path` (mono) | 9.2 | — | 400 | — | Location in Properties |

These sizes are small on purpose. The app runs at a compact density and users enlarge it with the Settings display scale. To mock up a screen at a comfortable reading size, scale everything by the same factor (×1.25 is typical) and keep the ratios.

---

## 4. Spacing, shape, density

**Layout rhythm:**
- `chrome-inset` 6.4 is the gap every floating bar keeps from the window and the sidebar.
- `content-left-gap` 17.6 is where content starts.
- `grid-gap` 6.4 separates tiles.
- The masthead is padded 25.6 / 17.6 / 8, with 14.4 between its lines.

**Item size is the user's choice.**
- One slider sets it, from 70 to 320px: 2px steps on the slider, 14px per Ctrl + wheel.
- Below 100px the grid becomes a **list**. List rows grow from 28 to 64.8px across the same range, with the thumbnail going from 19 to 40.8px.
- Default: 100px tiles.
- On a tile, the thumbnail is 58% of the width, a file glyph is 65% square and a folder glyph is 112% of the thumbnail.
- List columns: Name (1.6fr) · Date 112 · Type 72 · Size 80.

**Chrome sizes:**
- Path bar: at least 40px tall.
- Every control in it: 24px tall. Back/forward are 22.4 × 24.
- Search field: 224px wide, 288 when focused.
- Action bar: padding 8 × 17.6. Its buttons are about 26px tall (padding 5.6 × 8.8), with 12.8px icons.

**Radius:**

| Radius | Where it goes |
|---|---|
| 0 | Frame, canvas, list |
| 4.8 | Controls, search, action buttons, list thumbnails, menu items |
| 5.6 | Breadcrumbs, tile thumbnails |
| 7.2 | Glyph tiles, dialog buttons |
| 8 | Tiles, row highlights, menus |
| 9.6 | The two bars, drop card |
| 11.2 | Dialogs, drop overlay |
| 12.8 | The red delete confirmation |
| 999 | Tooltip, badges, extension pill, swatches, slider track |

Pill shapes are never used for a button with a text label.

**Elevation:**
- An item at rest has none.
- On hover: `shadow-card` (Cream `0 1px 2.4px rgba(15,23,42,.06), 0 1px 1.6px rgba(15,23,42,.04)`).
- Menus and dialogs: `shadow-elev` (Cream `0 6.4px 19.2px rgba(15,23,42,.10)`; much darker in Ink).
- Right-click menu: `0 9.6px 25.6px rgba(0,0,0,.5)` in both themes.
- The frosted bars cast no shadow. They have a solid 6.4px seam in `bg-backdrop`, so they read as cut out of the window.

**Icons:** outline, `currentColor`, in `icon-accent`: 12.8px in the action bar, 14px in the path bar, 16px for the root crumb.

---

## 5. Rules that decide a screen

1. **No box until touched.** A tile or row at rest is transparent with a transparent border. Hover adds `item-fill`, a `border-strong` hairline and `shadow-card`. It never lifts or scales.
2. **Selection is a ring, not a fill.** Selected = `item-fill` + 1px `accent` border + 2.4px `accent-tint` ring. A drop target uses the same ring with an `accent-tint` fill.
3. **One accent, two roles.** Cognac for text and buttons in Cream, sand in Ink, and sand for every icon in both themes.
4. **Colour means what the file is.** Office colours, folder colours and the WhatsApp green appear only on the glyph or preview they describe, never on interface chrome.
5. **Red is only for loss.** It marks the trash count, a drag onto the trash, and the last three days before a file is gone for good. Destructive menu items use `danger-soft` text, and deletion is always confirmed in a red pill.
6. **Chrome floats, content doesn't.** Only the path bar (once pinned) and the action bar are frosted (`chrome-glass`, 6.4px blur, 1.5px `border-flat`). Everything else sits flat on the dot grid.
7. **The header gives way.** The masthead scrolls off and the path bar pins in its place. There is never a second sticky header.
8. **One hint pill, everywhere.** Hover hints follow the cursor as a 9.6px pill, and right-click grows that same pill into the menu in 220ms. The OS menu is never used, and neither are native `title` tooltips.

---

## 6. Voice and content

The interface is in **English**; file names are whatever the user's files are called (often Romanian). Labels are short and plain: *Create, Import, Open, Rename, Delete, Copy, Cut, Paste, Select*. Menu items say what happens: *Open file location*, *Delete folder*, *Empty trash*. The summary line counts things: *6 files · 5.2 KB · Updated 25 Sept 2026*. Empty states say what to do next: *No files in your folder yet. Add or import files and they’ll show up here.* Anything that leaves the machine says so before it happens: *AI search sends this folder’s contents to Anthropic.*

---

## 7. Recurring patterns (reuse as sections and components)

- **Masthead:** accent eyebrow "PROJECT FILES · Stored in your local folder", 44.8px title, one summary line; it scrolls away.
- **Path bar:** back/forward · breadcrumbs (root 16px icon, chevron separators, max 160px each) · spacer · size slider (76.8px track, 11.2px thumb) · grid/list toggle · group-by-category toggle · search with "Ctrl F". Transparent until pinned, then frosted.
- **Tile:** thumbnail box (a preview, a file glyph, or a folder glyph), name below in two lines. Office previews get a 6px left stripe in their app colour; text files get an "MD"/"TXT" pill.
- **List row:** thumbnail + name · date · type · size, with the row highlight inset 1.6px top and bottom and 8px radius.
- **Trash tile:** always first. A filled can with a red count badge when full, an outline when empty. Items inside carry a days-left ring (`warning`, `danger` in the last 3 days).
- **Category groups:** uppercase heading, count pill, hairline, then its own grid. The order is Trash, Folders, Identities, Media, Office documents, Other files.
- **Drop overlay:** 1.6px dashed accent edge inset 6.4px, 10% accent wash, a centred card reading "Drop to copy here".
- **Right-click menu:** grows out of the hint pill. It is at least 160px wide with 10.88px items. Folders get a row of colour swatches (16px circles) on top.
- **Properties:** 272px dialog, 67.2px thumbnail, uppercase labels on a 73.6px column, the path in mono.
- **Action bar:** frosted, 6.4px above the bottom edge. It holds Undo/Redo | Create ▴ · Import | Open · Rename · Delete | Copy · Cut · Paste | Select, with "N selected" on the right. Button hover is a soft accent glow that follows the cursor.
- **Empty state:** 44.8px icon at 50% opacity, 13.6px display heading, one line of guidance, an accent button when there is something to do.
