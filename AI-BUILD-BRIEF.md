# LRL OS — AI Build Brief
## Project context for the AI building this application

**What you are building:** LRL OS is a private business operating system for a small creative agency called Left Right Labs (LRL). It is a single web application that aggregates data from Notion, Xero, YNAB, Google Calendar, Gmail, Slack, and YouTube/Google Analytics into one decision-making interface. It is currently live at os.leftrightlabs.com and is being redesigned. You are building the redesigned TODAY view first, then the rest of the zones.

**Your reference files:** All design decisions are documented in `/design-reference/`. The file `BUILD-SPEC.md` is your primary implementation guide. `lrl-today-reference.html` is the visual and interaction source of truth — when you are uncertain about how something should look or behave, open it in a browser. The spec wins on data and behavior rules; the reference file wins on visual and interaction details.

---

## The User This App Is Designed For

This is the single most important thing to understand before you write a single line of code. Every design decision flows from it.

The primary user is **Gretchen Cawthon**, CEO and integrator of Left Right Labs. She is talented, driven, and highly capable. She also has ADHD.

This is not a footnote. It is the design requirement.

An ADHD brain responds differently to information density than a neurotypical brain. Too much information on screen simultaneously — too many red indicators, too many competing priorities, too many numbers at once — triggers a cortisol spike that makes it *harder* to act, not easier. The instinctive response is avoidance: close the dashboard, open something else, do the comfortable thing instead of the important thing.

The app you are building must counteract this pattern at every level. It is not a status dashboard that shows everything. It is a **decision engine** that shows the right thing at the right moment and makes the next action obvious. Every section exists to reduce the distance between opening the app and doing the highest-value work.

Secondary users are Trina Fisher (co-founder) and Natasha Wright (team support). They use Work mode only and never see personal data. The mode toggle is only rendered for Gretchen's account.

---

## Design Principles — Non-Negotiable Rules

These are not preferences. They are constraints. If a design decision violates any of these, reverse it.

**1. One obvious action per view.**
Every section must have a single primary call-to-action that is visually dominant. Supporting elements exist to contextualize that action, not compete with it. If a user can look at a section and not immediately know what to do, the section has failed.

**2. Color carries meaning, never decoration.**
The app uses a small, fixed palette with defined meanings (full spec in `COLOR_SYSTEM.md`, which is the canonical source — mirror it, never approximate):
- Indigo (`#6366F1`) — the app anchor: brand, chrome/navigation, TODAY, ALL mode, shared zones (Messages/Execute)
- Cobalt (`#2563EB`) — work context: Work mode and the Attract/Convert/Deliver/Scale zones
- Cyan (`#06B6D4`) — personal/life context: Personal mode and the Health/Wealth/LEGO/Relationships zones
- Red (`#F26D6D`) — act now, something needs immediate attention
- Amber (`#EBB454`) — watch this, approaching, pending decision
- Green (`#4FD6A0`) — healthy, complete, on track

Indigo/cobalt/cyan never swap roles. Nothing else gets a color — all other content is neutral gray. If you find yourself adding a new color for aesthetic reasons, stop. Every color must earn its place by communicating status or context.

**3. The dashboard must get quieter when things are going well.**
This is the end-game design goal. When all metrics are healthy — revenue on track, rocks moving, pipeline fresh, no overdue items — the dashboard should show almost nothing. Red disappears. The morning brief changes tone from urgent to strategic. The numbers panel relabels to "Looking good." The visual reward for doing good work is a calm, spacious screen. If your implementation makes a fully-healthy state look busy or alarming, something is wrong.

**4. Stale data must never appear as fresh data.**
The app is only trustworthy if the user trusts the data it shows. Every data-driven element must carry a freshness signal. Items that haven't been updated past a staleness threshold must be visually flagged — not hidden, not blocked from surfacing, but clearly marked as potentially stale with a one-tap path to confirm or update. A stale item shown confidently as fresh is a trust-breaking bug, not a display preference.

**5. The system must be resilient to human inconsistency.**
Team members will forget to add due dates. Deals will go untouched. Tasks will lose their project links. Design around this reality. Never build a feature that silently fails when data is incomplete — surface the gap, provide a one-tap fix, and degrade gracefully. The self-serve "Needs a quick check" strip (BUILD-SPEC §9.3) exists for this reason.

**6. Nudge toward important work, not just urgent work.**
This is the distinction that separates a decision engine from a to-do list. The "One Thing" card (see below) must surface the highest-leverage action, not the most overdue one. The ranking engine (BUILD-SPEC §7.1) weights rock-impact and value more heavily than raw urgency. The "why" line on the card explicitly explains the leverage — this is not decorative copy, it is the core nudge mechanism.

**7. Gamification must be honest to be effective.**
The Work Streak and Life Streak only work if they mean something real. The Work Streak counts only when high-value work is done (completing the One Thing or a rock-linked task). It cannot be kept alive by clearing inboxes or doing routine tasks. Weekends never break it. One freeze per week is available for travel/sick/holiday days. If the streak becomes easy to keep without doing meaningful work, it will be ignored within two weeks.

---

## Feature Behavioral Specifications

These describe how each feature must behave, and why it exists. Read these before implementing each component.

### The Greeting Zone
Opens the page. Shows the user's name (accent-colored), time-of-day word (Morning/Afternoon/Evening based on local time), and three plain-language brief lines. Each line has a colored dot: red = most urgent, amber = watch this, green = opportunity. The lines are AI-generated from the day's data (see BUILD-SPEC §7.2). This section must never show raw numbers or metrics — it is human-readable orientation, not a data display. The user reads their situation in plain language before they see any numbers.

### The One Thing
The most important component in the application. A large, prominent card showing the single highest-value action available today. It must:
- Show which quarterly rock it advances (this is the line-of-sight mechanism)
- Show a "why" line explaining the leverage (this nudges toward important vs. urgent)
- Have three states: active, snoozing, and done
- Never silently disappear when dismissed — "Not now" opens a snooze flow with four honest choices (do #2 instead, mark blocked, snooze 2 hours, bring it back)
- Celebrate completion visibly — completion triggers a payoff animation, streak update, and a message tying the win to its impact (e.g. "Work streak → 4 days · Rock 1 moved forward")
- Surface stale items with an amber confirm-it's-real flag if the underlying data is past the freshness threshold

The One Thing is selected by a ranking engine (BUILD-SPEC §7.1) that scores candidates by value, rock-impact, urgency, and freshness. It is never simply "the most overdue task."

### Dual Streaks (Work + Life)
Two separate streak counters displayed side by side in All mode, individually in Work or Personal mode.

Work Streak: counts consecutive weekdays where the user completed the One Thing or any rock-linked task. Weekends are immune (they show as neutral hatched pips, never misses). One freeze per week, shown as a ❄️ icon on the day pip. Status shows as amber "⏳ Move a rock today to keep it alive" when the day is not yet satisfied, and green "✓ Locked in for today" once it is. The streak evaluates at end of day — never shows as broken during the day while time remains.

Life Streak: counts consecutive days (including weekends) where the user advanced a personal goal. Separate counter, separate rules.

### Morning and Evening Rituals
Two fixed, lightweight chip-bar checklists. Morning Startup sits above the Today's Plan and must be completed before deep work begins — it is the cognitive on-ramp. Evening Wind-Down sits below the plan. These are not plan tasks. They are repeating habits with a different visual treatment (chips, not numbered rows). Completing the morning ritual fully should lock in streak credit and surface a reward line. Items reset daily.

### Q2 Rocks
The bridge between the quarterly VTO commitment and today's actions. Each rock shows: left-border status color (red = at risk, green = on track, gray = done), owner, milestone progress (X/total + mini bar), and the next action. Rocks are collapsible. With 9 days left in the quarter and 3 of 4 rocks at risk, the section should feel urgent — the at-risk warning banner should be present and clearly visible, not subtle.

### Today's Plan
Numbered priority list (1 through N). Each row shows: checkbox, task name, project name on a second line, source indicator (◆ Sales from Convert board, ▪ Task from Tasks DB), and tags (ROCK N, $ value, Overdue, area). The "Hide done" toggle collapses completed rows. Tasks are sorted by the same value/rock-impact/urgency ranking as the One Thing.

### The Weekend Screen
Full-screen takeover on Saturdays and Sundays in Work mode. Rotating message (5 options, random per visit). Two buttons: "👀 Just a peek" (reveals dashboard, re-arms screen for next visit, shows floating "back to weekend" banner) and "Unfortunately, I'm working today →" (clears screen for the day, day counts toward streak). The peek button must feel temporary — the banner that follows it must be visible and easy to use to return to rest mode. This screen is protective friction. It must feel friendly, not punishing.

### Mode System (Gretchen only)
Three modes: Work (cobalt `--work`), All (indigo `--accent`), Personal (cyan `--personal`). The mode toggle renders only for Gretchen's account. Team members see Work mode with no toggle and zero personal data in the DOM.

Work: business tabs, work tasks only, work streak only, business rings.
Personal: life tabs, personal tasks only, life streak only, single large life ring.
All: all tabs with separator, all tasks with domain dots, both streaks, both rings, 4 most off-track metrics in pulse strip regardless of domain.

Mode switch should animate content change (~250ms transition). Layout skeleton never changes between modes — only content and accent color change. The user learns the layout once.

---

## Technical Constraints

**Stack (do not change):**
- Backend: Node.js + Express (server.js handles all routes and API calls)
- Frontend: vanilla HTML/CSS/JavaScript — do NOT introduce React, Vue, or any JS framework
- Templating: EJS (or the existing pattern in server.js)
- Database: Railway PostgreSQL — extend with new tables, do not replace
- Integrations already connected: Notion, Xero, YNAB, Google Analytics 4, YouTube Data API, Claude API, Google OAuth

**New database tables needed** (see BUILD-SPEC §10 for full SQL):
- `streak_state` — work/life streak per user, freeze availability
- `ritual_log` — daily ritual completion per user per day
- `one_thing_state` — snooze/blocked/done state per item per user per day

**Design tokens (copy exactly, never approximate — defined in `public/styles/tokens.css`, documented in `COLOR_SYSTEM.md`):**
```
--bg: #0A0D16          --surface: #111826       --surface-2: #0D131F
--border: #1C2536      --border-soft: #161E2C
--accent: #6366F1      --accent-soft: rgba(99,102,241,.13)    /* indigo  — anchor / chrome / shared */
--work: #2563EB        --work-soft: rgba(37,99,235,.13)       /* cobalt  — work mode + work zones   */
--personal: #06B6D4    --personal-soft: rgba(6,182,212,.13)   /* cyan    — personal mode + life zones */
--text: #DCE3EC        --text-2: #8A9BB0
--text-3: #54667E      --text-4: #364457
--red: #F26D6D         --red-soft: rgba(242,109,109,.12)
--amber: #EBB454       --amber-soft: rgba(235,180,84,.12)
--green: #4FD6A0       --green-soft: rgba(79,214,160,.12)
```
Each zone page sets `--zone` / `--zone-soft` locally to its context color (work→cobalt, life→cyan, shared→indigo). Light mode overrides live in `tokens.css` (`html.light`). Type sizes use the `--fs-*` token scale (`--fs-caption` 12 … `--fs-hero` 40), not raw px.

**Type scale:**
- Greeting: 23px / 700
- Hero (One Thing title): 21px / 700
- Body / plan items: 14–15px
- Section labels: 11px / 700 / uppercase / 0.09em letter-spacing
- Micro labels: 9–10px

**Notion key IDs:**
- LRLOS workspace root: `2a1458f08cd98161bccee4349dc48e2f`
- TASKS DB collection: `collection://28c458f0-8cd9-8185-99e7-000bc2115872`
- PLAYBOOK [DB] collection: `collection://0b89df5d-fd80-468f-b295-b27f35128f90`
- SALES ACTIVITY [DB] collection: `collection://b5d8dd3c-303b-49c2-96cf-23b2cfa476ae`
- PRODUCTION area page: `28d458f08cd980f5a97ed61fc5e9d079`

**Notion write-back rule:** Always use the create-then-update two-pass pattern when setting the Assigned field. A workspace automation overwrites it on creation. Create first, then update in a second call.

**Caching rule:** All integration reads (brief, finance, schedule, rocks) must cache for the day with a `last_updated` timestamp per block. This timestamp is required to power the staleness trust signals. Cache on the server, never in browser localStorage.

---

## Staleness Thresholds

| Data type | Flag as stale after |
|---|---|
| Convert deal (last touch) | 14 days |
| Rock with no milestone movement | 14 days |
| Task with no due date | Immediately (surfaces in data-health strip) |
| Task with no project link | Immediately |
| Finance snapshot (Xero) | 2 days |

When a stale item surfaces as the One Thing, the card must show: `⚠ No movement in N days — still live?` with one-tap `Yes, still on` / `Close it out` inline. Acting on this confirm simultaneously refreshes the data.

---

## What Success Looks Like

The app has succeeded when:
1. A user opens TODAY, reads three sentences, sees one prominent card, knows exactly what to do, and does it — in under 60 seconds from opening.
2. The dashboard looks visibly different when things are going well versus when they are not. Healthy state = quiet, spacious, green. Stressed state = red signals in specific places, prominent One Thing card, rocks showing at-risk status.
3. The Work Streak has been running for 10+ days and the user has not gamed it — every counted day represents genuine rock-advancing work.
4. A team member opens the app and sees their own data gap (missing due date, unlinked task) without needing Gretchen to tell them.
5. The app has not been replaced by a spreadsheet, a different tool, or a mental model of "I'll check this later." It is opened every morning because it is genuinely useful.

---

## What NOT to Do

- Do not show all available data by default. Show the minimum needed to take action. Let detail reveal on demand.
- Do not make red the default color of informational content. Red must be earned by genuine urgency.
- Do not make completing routine tasks (inbox clearing, ritual items alone) keep the Work Streak. Only needle-moving work counts.
- Do not let the "Not now" interaction silently dismiss the One Thing. It must defer, not delete.
- Do not break the layout or structure when switching modes. The skeleton is identical across all three modes.
- Do not use browser localStorage for any persistent state. Use the PostgreSQL database.
- Do not introduce a JavaScript framework. The app is vanilla HTML/CSS/JS served by Express.
- Do not show personal data (LEGO projects, health goals, personal finance) in any team member's view.
- Do not show the weekend screen in Personal mode. Life does not clock out on weekends.
- Do not present stale data as fresh. Always show the "as of" timestamp on data blocks.

---

## Reference Files (in /design-reference/)

| File | Purpose |
|---|---|
| `BUILD-SPEC.md` | Full implementation spec — tokens, components, mode logic, streak rules, data wiring, build phases |
| `lrl-today-reference.html` | Visual and interaction source of truth — open in browser, match exactly |
| `lrlos-three-modes-concept.html` | Work / All / Personal mode switching reference |
| `lrlos-states-concept.html` | Urgent vs. Healthy end-state visual reference |
| `KICKOFF-PROMPT.md` | The exact prompt to use when starting a new Claude Code session on this project |

---

*This document is maintained in the LRL Notion PLAYBOOK [DB]. Update it as the app evolves.*
