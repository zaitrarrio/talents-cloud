# Claude Code — Session Prompts for Options CC-A and CC-B
Status note (honest): Claude Code CLI is not installed in this sandbox and its
login cannot be pulled from the sealed Anthropic connector (same constraint as
the Rose League build, 2026-11-08). So these are (1) the exact ready-to-paste
Claude Code sessions, and (2) the prototypes those sessions produce — built here
in code to the same spec, in `ui-claude-code/`, so you can select a direction now
and re-run the session later for the production build without changing the design.

Shared context block (paste into BOTH sessions first):
"Read DESIGN.md and CONSOLIDATED-DESIGN.md in this folder first — they are the
contract; if your output conflicts, the contract wins. Build a static,
self-contained HTML/CSS/JS prototype (no build step, no backend) of the Skills
Marketplace described there. Use the sample catalog in the prompts verbatim
(names, ids, prices, permissions). Every EntryCard must carry the §3 trust
elements. No emoji icons — inline SVG stroke icons only. Screens must be
navigable: Home, Search results, Entry detail, Install (DeclarationSheet modal),
Playground panel, Library, Creator Studio, Publisher profile."

Sample catalog (all options use it, so they are comparable):
- research-tabs — skill.research-tabs · Workflow · FREE · @zay · Verified ·
  "Turns open tabs into a sourced brief filed in Canvas" · Browser: fetch · Files: write · v1.1.0 · 12,408 installs
- invoice-reconciler — skill.invoice-reconciler · Playbook · $19 + ≤$0.40/run ·
  @ledgerline · Verified · "Reconciles Stripe invoices against your books" ·
  Stripe: read · Files: read/write · v2.0.1 · 3,912 installs
- inbox-triage-mcp — mcp.inbox-triage · MCP · Subscription $8/mo · @kaplit-labs ·
  Listed · "Triage server: labels, drafts, and files email by your rules" ·
  Email: read/send · v0.9.4 · 8,155 installs
- meeting-prep — skill.meeting-prep · Playbook · FREE · @zay · Verified ·
  Calendar: read · Email: read · v1.0.1 · 5,170 installs
- site-watcher-agent — agent.site-watcher · Agent (portable, offline) · $29 ·
  @northloop · Listed · "Watches pages you name, reports only real changes" ·
  Network: fetch · v0.7.2 · 4,330 installs
- legacy-crm-sync — skill.legacy-crm-sync · Workflow · per-run · @unknown ·
  UNCLAIMED (mined) · discovery only, no install · v? · source: github.com/…

---

## Session CC-A — "Atlas" (developer-first registry)
"You are building Option CC-A 'Atlas'. Posture: a developer-first registry in
the Gia design system (DESIGN.md §2 tokens exactly — warm paper background
#EDEAE4, amber accent #B4762A, Newsreader serif names, JetBrains Mono ids).
Layout: left sidebar (Discover, Library, Studio, Publishers, Enterprise),
main column search-first: a large search bar with kind facets as pills is the
hero — no marketing hero. Results as dense EntryCards in a 2-column grid with
the full §3 trust line visible without hovering. Entry detail is a document:
manifest table, declaration preview, VersionLedger. Install opens the
DeclarationSheet modal. Include a Playground panel on the detail page with
sample steps and a running cost. Density is a feature; whitespace separates,
chrome does not. Build all 8 screens from DESIGN.md §5 as switchable views."

## Session CC-B — "Grove" (consumer goal-driven marketplace)
"You are building Option CC-B 'Grove'. Posture: a consumer marketplace for
people who arrive with a goal, not a tool name — same Gia tokens, warmer and
more editorial: serif display headlines, generous cards, cover-gradient
EntryCards. Home opens with one question — 'What do you want done?' — a goal
input, goal chips (Close my books, Run my inbox, Prep my meetings, Watch my
competitors), then GoalStacks: 'Close my books' stack = invoice-reconciler +
inbox-triage-mcp with ONE combined declaration and one total ($27 + run cap).
Below: 'Popular this week' EntryCard row and a Creator spotlight. Detail pages
lead with the outcome and a PlaygroundPanel ('Try it on sample data'), the
manifest and VersionLedger live one section down — but the permission summary
stays on the card and the DeclarationSheet still gates every install.
Build all 8 screens from DESIGN.md §5 as switchable views."
