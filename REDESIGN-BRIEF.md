# Talents Redesign Brief — unified creator + consumer experience

**Status:** draft for user review (2026-11-15). **Source of direction:** user voice call,
main chat, 2026-11-13. **Current state verified live:** 2026-11-15 (home 200, search 200,
dashboard 303 → sign-in, catalog 106,114 listed / 17,749 candidates remaining, D1 ~992 MB).

## 1. The decision this brief asks for

Approve the redesign direction and scope below — one unified experience for finding
and publishing skills — and answer the open decisions in §8, so design work can start
on the creator path first.

## 2. Direction (user decisions, 2026-11-13 — these are constraints, not options)

1. **The UX is not good, especially for creators.** Both experiences need work;
   the creator experience in particular.
2. **Unified and integrated, NOT disparate.** Creator and consumer are not two
   worlds, two navs, or two products. One site, one flow, one account.
3. **GitHub-familiar, Gia-simple.** Structure and concepts people who know GitHub
   recognize (`owner/name`, profiles, claims, versions) — expressed in Gia OS plain
   language for people who have never used GitHub.
4. **Creators are just normal users.** Any user of talents.sh — which is another
   name for the Gia App Store — must be able to become a creator. No separate
   creator class, no application, no gate.
5. **Ownership stays `owner/name`.** The owner can be a person **or** an
   organization. Same structure, same publishing path for both.

## 3. What's broken today (current-state audit)

The platform underneath is real and working — meta-registry, attestation, hybrid
search, enrichment, the Workflow drain feeding the catalog (106,114 listed as of
today, up from 22,444 at cutover). The experience on top of it is not:

- **Becoming a creator is a separate world.** The creator path lives behind
  `/dashboard`, reached only via `/sign-in`. Nothing in the browsing flow ever
  invites a user to publish. A visitor can browse 106k skills and never learn
  they could add one.
- **Today you must be a GitHub user to become a creator.** Claims match a GitHub
  login to a namespace. That directly contradicts decision 4: a non-GitHub user
  has no path in. (GitHub proof still matters for *claiming an existing
  namespace* — it can't be the only way to *become* a creator.)
- **Sign-in is test-mode.** Clerk runs on test keys (`pk_test_`/`sk_test_`);
  production sign-ins need live keys. No real creator can sign in today.
- **The dashboard is honest but thin.** Analytics render from real data, but
  gateway calls and installs are near zero, so a new creator sees empty rooms.
  Earnings and payouts are fixture-only: Stripe is dormant, the platform account
  (AdvancedAI vs Saije Ventures) is undecided, no live purchase has occurred.
- **Publishing is a form, not a flow.** Creator Studio exists as a screen, but
  there is no guided path from "I made a skill" to "it's listed" — no
  publish-from-a-repo walkthrough, no status while the registry verifies and
  attests, no plain-language explanation of what happens next.
- **Discovery is consumer-shaped only.** Search is goal-driven and works, but
  there is no creator-shaped discovery: no "your skills", no "people who
  installed yours", no loop back from using to publishing.
- **Trust elements exist but don't travel.** The card contract (kind chip,
  canonical id, permission summary, trust badge) is specified in DESIGN.md, but
  the live catalog is dominated by unclaimed mined entries — the "Unclaimed —
  discovery only" state is the default view, not the exception.

## 4. Principles (derived from §2)

- **One account, two hats.** Signing in gives you a library *and* a studio.
  "Become a creator" is a step inside the product, not a different product.
- **Show, don't explain GitHub.** `owner/name`, versions, and claims are shown
  the way GitHub shows them; the words around them are plain ("Your page",
  "Your skills", "Who can see this") — no jargon is required to act.
- **Publish in minutes, from where the skill already lives.** A skill is a repo
  (or a `SKILL.md`, or a marketplace.json). Publishing points at it; it never
  asks the author to re-upload, re-type, or learn a new format.
- **Status is always visible.** Every publish shows where it is: pointed →
  verified → attested → listed. No silent queues, no "check back later".
- **Trust at a glance, everywhere.** The permission summary and trust badge
  travel with the entry — home, search, detail, library, studio. Nothing
  installs without the declaration ceremony (prepare → read → confirm).
- **Every user can see themselves as a creator.** The empty states, the
  call-to-action, and the first publish are designed for someone who has never
  published anything — not for someone who already knows the flow.

## 5. Target experience

### Journeys

**A. Find and use (consumer, already the product's strength — keep, tighten).**
Arrive with a goal → goal-first search → a card that says what the skill can
touch in plain words → try in the Playground → read the declaration → install
pinned. Unchanged in shape; the redesign makes the cards and the ceremony
consistent everywhere instead of only on detail pages.

**B. Any user → creator (the core new journey — the redesign's center).**
1. You're signed in, browsing. A skill you use has a visible "Make your own"
   path; your profile has a "Publish" action; empty states say so too.
2. "Publish a skill" asks one question first: *where does it live?* — a GitHub
   repo URL, a `SKILL.md` link, or a marketplace.json. Paste it; the registry
   reads it, it doesn't ask you to re-describe it.
3. The registry verifies and attests in front of you, with live status
   (pointed → verified → attested → listed) and plain-language results.
4. If the namespace is yours on GitHub, you prove it once (GitHub sign-in
   match) and it's claimed. If it's new, it's yours. If someone else owns it,
   you get a clear answer, not a dead end.
5. You land on your skill's page — already live — with the next steps visible:
   description, pricing (optional), and what happens when someone installs it.
   No separate "studio" to go find; the studio is your profile, with a
   "Your skills" section.

**C. Manage what you published (creator, returning).**
Your profile shows your skills, installs, and status at a glance. Edit the
publisher description (labelled as yours, separate from the attested record).
Unlist in one step (listed → 404, out of search). Versions are a ledger:
publish a new version, pin, revoke — each with its hash and status.

**D. Publish as an organization.**
Same path as B, with one extra step: pick (or create) the organization the
skill belongs to. The org has the same profile shape as a person — same
`owner/name` URLs, same publishing path, same trust badges.

### Information architecture (one nav, no second world)

- **Discover** — home / search, goal-first. (Today's home.)
- **Library** — what you've installed: pinned versions, updates, revoked flags.
- **Your page** (`talents.sh/{owner}`) — your profile *and* your studio: your
  skills, your installs, "Publish a skill" — one place, not two.
- **Skill page** (`talents.sh/skills/{owner}/{name}`) — detail, declaration,
  versions, Playground. The creator sees their management actions here, inline;
  a visitor sees the same page minus those actions.

The standalone `/dashboard` goes away as a destination. Its functions move into
"Your page" and the skill page. Sign-in stays (`/sign-in`), and after sign-in
you land where you were — not in a separate admin area.

## 6. What stays

- **Grove visual language** (CC-B, chosen 2026-11-10): warm editorial tokens,
  Newsreader serif names, JetBrains Mono ids, amber accent. The redesign is
  structure and flow, not a new look.
- **The meta-registry model.** Metadata, pointers, attestations only; installs
  resolve source-direct; zero-change publishing (push a tag). Nothing in this
  redesign asks a creator to change how they publish.
- **Trust elements on every card** (DESIGN.md §3) and the **declaration
  ceremony** (prepare → read → confirm). These are the differentiator; the
  redesign spreads them everywhere instead of weakening them.
- **Canonical identity and URLs.** `talents.sh/skills/{owner}/{name}`,
  `talents.sh/{owner}`, `talents.sh/s/{owner}/{name}`, `mcp.talents.sh`.
- **Enrichment labelling.** Source / derived / generated stay separate and
  labelled; nothing generated is ever presented as the publisher's words.

## 7. What changes

| Today | After |
|---|---|
| Creator path hidden behind `/dashboard` | "Publish a skill" in the main flow; studio lives on your profile |
| GitHub login is the only way to become a creator | Sign in (Clerk) makes you a user; publishing from a repo URL is the creator path; GitHub proof is only for claiming an existing namespace |
| Publish = a form | Publish = paste a location, watch verification + attestation live |
| No status during verification/attestation | Live status at every step, in plain words |
| Dashboard analytics, mostly empty | Your page shows your skills + real install/run counts as they accrue |
| Unclaimed mined entries are the default view | Unclaimed state stays honest, but claimed creators and "make your own" are visible throughout |
| Consumer and creator are separate experiences | One account, one nav, one profile — the creator tools appear in context |

## 8. Phased plan

- **Phase 1 — the creator path (first).** Sign-in → your page → publish from a
  repo URL → live verify/attest status → listed skill page. Retire `/dashboard`
  as a destination. This is the piece the user called out; it ships first and
  is the redesign's proof.
- **Phase 2 — unify browse.** Library + your page + skill page under one nav;
  trust elements consistent on every card; "make your own" entry points in
  empty states and on skills you use.
- **Phase 3 — organizations + money.** Org creation/selection in the publish
  path; Stripe Connect when the platform-account decision lands (see §9);
  earnings and payouts in your page. Nothing in Phase 1 or 2 depends on it.

## 9. Open decisions (need the user)

1. **Live Clerk keys** — swap test keys for `pk_live_`/`sk_live_` so real users
   can sign in? (User-only step; test keys are deployed today.)
2. **Stripe platform account** — AdvancedAI or Saije Ventures? (Still
   undecided; Phase 3 waits on it, Phases 1–2 don't.)
3. **Becoming a creator without GitHub** — is sign-in + a repo URL enough to
   publish, with GitHub proof required only to *claim* an existing namespace?
   (This brief assumes yes; it is the direct reading of decision 4.)
4. **Organizations** — self-serve creation in the publish path, or
   invite/approval to start?
5. **Publish entry point** — web-first (paste a URL), or CLI-first alongside
   it? (Architecture already supports both; the brief leads web.)
6. **Playground scope in Phase 1** — keep try-before-install as-is, or make
   the Playground part of the publish flow (creators test their own skill
   before it lists)?

## 10. Success criteria

- A signed-in user who has never published can go from "Publish a skill" to a
  listed skill page in under 10 minutes, without leaving talents.sh and
  without reading documentation.
- A non-GitHub user can complete that path (GitHub proof only when claiming).
- Every publish shows live status; no publish ever sits in a silent queue.
- The creator path is reachable from browsing in one click, from at least
  three places (your page, a skill you use, an empty state).
- Trust elements (kind, id, permission summary, badge) appear on every card,
  and the declaration ceremony is unchanged.
- No regression to the consumer journey: search, Playground, install, and
  Library work exactly as before.

## 11. Non-goals

- No new visual language (Grove tokens stand).
- No change to the meta-registry model, attestation, or install resolution.
- No Stripe build until the platform-account decision (§9.2) lands.
- No McpAgent port, no personalization engine — those are separate roadmap
  items, not this redesign.
- No re-derivation of the catalog: the 106k listed records and the enrichment
  pipeline are untouched.

## 12. Risks

- **Claiming vs creating confusion.** If the GitHub-proof step is in the wrong
  place, non-GitHub users bounce. Mitigation: proof appears only when the
  namespace already exists and is claimed by someone else.
- **Empty analytics.** A new creator's page will still show near-zero installs
  at first. Mitigation: design the empty state as a next step ("share your
  skill", "try it in the Playground"), not a zero.
- **Scope creep into the consumer journey.** The consumer flow works; the
  redesign must not rebuild it. Mitigation: Phase 1 touches only the creator
  path and your page; browse changes wait for Phase 2.
