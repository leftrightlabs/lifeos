# LRL OS Color System

## 3 Brand Colors

| Role | Token | Hex | Used for |
|---|---|---|---|
| **Anchor** | `--accent` | `#6366F1` (indigo) | Brand logo, TODAY active state, ALL mode, Messages/Execute zones, FAB default |
| **Work** | `--work` | `#2563EB` (cobalt blue) | Work mode button, work zone badges/eyebrows, FAB in work mode |
| **Personal** | `--personal` | `#06B6D4` (cyan) | Personal mode button, life zone badges/eyebrows, FAB in personal mode |

Each has a soft tint for backgrounds:
- `--accent-soft`: `rgba(99,102,241,.13)`
- `--work-soft`: `rgba(37,99,235,.13)`
- `--personal-soft`: `rgba(6,182,212,.13)`

**The rule:** Indigo = the app itself (brand, chrome, TODAY). Cobalt = work context. Cyan = personal/life context. They never swap roles.

---

## Semantic Colors

| Token | Hex | Used for |
|---|---|---|
| `--red` | `#F26D6D` | Overdue, errors, alerts |
| `--amber` | `#EBB454` | Warnings, "at risk" states |
| `--green` | `#4FD6A0` | On track, complete, healthy |

Soft backgrounds: `--red-soft: rgba(242,109,109,.12)` · `--amber-soft: rgba(235,180,84,.12)` · `--green-soft: rgba(79,214,160,.12)`

---

## Zone Color Assignment

| Zone | Color |
|---|---|
| Attract, Convert, Deliver, Scale | `--work` (cobalt) |
| Health, Wealth, LEGO, Relationships | `--personal` (cyan) |
| Messages, Execute | `--accent` (indigo) |

Each zone page sets `--zone` locally so zone-specific elements (badge, eyebrow, FAB) auto-color correctly:
```css
/* Work zones */
:root { --zone: var(--work); --zone-soft: var(--work-soft); }

/* Life zones */
:root { --zone: var(--personal); --zone-soft: var(--personal-soft); }

/* Shared zones */
:root { --zone: var(--accent); --zone-soft: var(--accent-soft); }
```

---

## Surface + Text Tokens (dark mode default)

The dark theme is **navy blue** — not neutral dark, not purple. All backgrounds have a blue undertone.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0A0D16` | `#F0F2F8` |
| `--surface` | `#111826` | `#FFFFFF` |
| `--surface-2` | `#0D131F` | `#F5F6FC` |
| `--border` | `#1C2536` | `#D8DCE9` |
| `--border-soft` | `#161E2C` | `#E4E8F2` |
| `--text` | `#DCE3EC` | `#1A2233` |
| `--text-2` | `#8A9BB0` | `#4A5568` |
| `--text-3` | `#54667E` | `#718096` |
| `--text-4` | `#364457` | `#A0AABB` |

---

## Prompt Snippet (for other Claude sessions)

> Use the LRL OS color system. Dark mode is navy blue — not neutral dark. Backgrounds: `--bg #0A0D16`, `--surface #111826`, `--surface-2 #0D131F`. Borders: `#1C2536` / `#161E2C`. Text: primary `#DCE3EC`, secondary `#8A9BB0`, muted `#54667E`. Brand colors: indigo `#6366F1` (anchor/chrome), cobalt `#2563EB` (work), cyan `#06B6D4` (personal/life). Semantic: red `#F26D6D`, amber `#EBB454`, green `#4FD6A0`. Light mode: bg `#F0F2F8`, surface `#FFFFFF`, text `#1A2233`.
