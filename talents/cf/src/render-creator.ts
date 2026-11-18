// Creator Experience pages (P4) — sign-in, dashboard, listing
// manager, analytics, checkout success. Rendered with the SHARED
// page shell from ../../src/render.ts (same Grove chrome, tokens and
// header as the public pages — no design fork). All user-derived
// strings go through esc().

import { esc, layerMark, renderPageShell } from "../../src/render.js";
import { formatPrice } from "../../src/creator/fees.js";
import type { Claim } from "../../src/creator/claims.js";
import type { OwnerAnalytics } from "../../src/creator/analytics.js";
import type { SessionUser } from "./auth.js";
import type { CreatorAccount, DashboardListing } from "./creator.js";
import { frontendApiFromPublishableKey } from "../../src/creator/jwt.js";

const dashNav = (active: string) => `
  <div class="facetrow" style="margin-top:4px">
    <a class="gchip" href="/dashboard"${active === "home" ? ` style="border-color:var(--acc);background:var(--asoft)"` : ""}>Overview</a>
    <a class="gchip" href="/dashboard/listings"${active === "listings" ? ` style="border-color:var(--acc);background:var(--asoft)"` : ""}>Listings</a>
    <a class="gchip" href="/dashboard/analytics"${active === "analytics" ? ` style="border-color:var(--acc);background:var(--asoft)"` : ""}>Analytics</a>
    <a class="gchip" href="/sign-out">Sign out</a>
  </div>`;

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export interface SignInState {
  /** Clerk publishable key when configured (public by design). */
  publishableKey: string | null;
}

export function renderSignIn(state: SignInState): string {
  if (!state.publishableKey) {
    const body = `<section class="hero">
  <h1>Creator sign-in</h1>
  <p>Publisher accounts are not switched on yet. Talents needs its own Clerk application before anyone can sign in — creating it is a one-time dashboard step for the site owner:</p>
</section>
<div class="panel" style="max-width:680px;margin:18px auto">
  <h3>Setup remaining</h3>
  <ol style="margin-left:20px;color:var(--soft);font-size:14.5px;line-height:1.7">
    <li>Create a Clerk application for <span class="mono">talents.sh</span> at clerk.com.</li>
    <li>Enable the <strong>GitHub</strong> social connection (creators claim namespaces by proving GitHub ownership).</li>
    <li>Provide the publishable key (a site var) and the secret key (a Worker secret) through secure entry.</li>
  </ol>
  <p class="note" style="margin-top:10px">Everything else in the creator experience — claims, listing management, payouts, analytics — is built and waiting on these keys. Public catalog pages are unaffected.</p>
</div>`;
    return renderPageShell("Creator sign-in", body);
  }
  const host = frontendApiFromPublishableKey(state.publishableKey);
  const headExtra = host
    ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${esc(state.publishableKey)}" src="https://${esc(host)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
    : "";
  const body = `<section class="hero">
  <h1>Creator sign-in</h1>
  <p>Sign in with GitHub to claim your namespace, manage listings and get paid.<br>Your GitHub login is the ownership proof — no passwords stored here.</p>
</section>
<div id="clerk-sign-in" style="display:flex;justify-content:center;margin:26px auto"></div>
<script>
  window.addEventListener('load', async () => {
    if (!window.Clerk) return;
    await window.Clerk.load();
    if (window.Clerk.user) { window.location.href = '/dashboard'; return; }
    window.Clerk.mountSignIn(document.getElementById('clerk-sign-in'), {
      signUpUrl: '/sign-in',
      afterSignInUrl: '/dashboard',
      afterSignUpUrl: '/dashboard'
    });
  });
</script>
<noscript><div class="panel" style="max-width:560px;margin:0 auto"><p>Sign-in needs JavaScript (it runs Clerk's hosted component). The catalog itself works without it.</p></div></noscript>`;
  return renderPageShell("Creator sign-in", body, headExtra);
}

export function renderSignOut(publishableKey: string | null): string {
  const host = publishableKey ? frontendApiFromPublishableKey(publishableKey) : null;
  const headExtra = host && publishableKey
    ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${esc(publishableKey)}" src="https://${esc(host)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`
    : "";
  const body = `<section class="hero"><h1>Signed out</h1><p>You are signed out of the creator dashboard.</p>
<p style="margin-top:14px"><a class="btn" href="/">Back to the catalog</a></p></section>
<script>
  window.addEventListener('load', async () => {
    if (window.Clerk) { await window.Clerk.load(); await window.Clerk.signOut(); }
  });
</script>`;
  return renderPageShell("Signed out", body, headExtra);
}

// ---------------------------------------------------------------------------
// Dashboard home: identity, claim state, payouts panel
// ---------------------------------------------------------------------------

export interface DashboardHomeData {
  user: SessionUser;
  claims: Claim[];
  /** Owner the user could claim with one click (their GitHub login,
   *  present in the catalog, unclaimed) — null when none. */
  claimableOwner: string | null;
  /** True when their login exists in the catalog but is a registry
   *  label (not GitHub-backed): claim unavailable, say so honestly. */
  loginOwnerNotGithubBacked: boolean;
  accounts: Map<string, CreatorAccount>;
  paymentsConfigured: boolean;
}

export function renderDashboardHome(data: DashboardHomeData): string {
  const { user } = data;
  const claimRows = data.claims.map((c) => `
    <div class="kv"><span><a href="/${esc(c.owner)}">${esc(c.owner)}</a> <span class="badge" style="color:var(--deep)">✓ Verified publisher</span></span><span class="note">claimed ${esc(c.claimedAt.slice(0, 10))} via ${esc(c.method)}</span></div>`).join("");
  const claimPanel = data.claims.length
    ? `<div class="panel"><h3>Your namespaces</h3>${claimRows}</div>`
    : data.claimableOwner
      ? `<div class="panel"><h3>Claim your namespace</h3>
         <p style="color:var(--soft)">Your GitHub login <span class="mono">${esc(user.githubLogin ?? "")}</span> matches the catalog namespace <strong>${esc(data.claimableOwner)}</strong>. Claiming makes you its verified publisher: you can edit listing pages, set prices, unlist, and connect payouts.</p>
         <form method="post" action="/api/claims" onsubmit="event.preventDefault();fetch('/api/claims',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner:'${esc(data.claimableOwner)}'})}).then(r=>r.json()).then(j=>{if(j.claimed){location.reload()}else{alert(j.error||'claim failed')}})">
           <button class="btn" type="submit" style="margin-top:12px">Claim ${esc(data.claimableOwner)}</button>
         </form></div>`
      : data.loginOwnerNotGithubBacked
        ? `<div class="panel"><h3>Namespaces</h3><p style="color:var(--soft)">A catalog namespace matches your login, but it comes from the MCP Registry rather than a GitHub account — <strong>claim is not available via GitHub sign-in</strong> for registry-label namespaces.</p></div>`
        : `<div class="panel"><h3>Namespaces</h3><p style="color:var(--soft)">${user.githubLogin
            ? `No catalog namespace matches your GitHub login <span class="mono">${esc(user.githubLogin)}</span> yet. Namespaces appear when skills under your GitHub account are indexed — that happens automatically, with zero changes from you.`
            : `Your account has no GitHub login linked, so namespaces can't be claimed yet. Sign in with GitHub (not email) so ownership can be proven.`}</p></div>`;

  const payoutRows = data.claims.map((c) => {
    const account = data.accounts.get(c.owner);
    const state = !data.paymentsConfigured
      ? `<span class="note">Payments are not enabled on talents.sh yet (platform Stripe account pending) — onboarding opens when it is connected.</span>`
      : !account
        ? `<form method="post" action="/api/payouts/connect" style="display:inline"><button class="btn" type="submit">Connect Stripe for payouts</button></form>`
        : account.chargesEnabled
          ? `<span class="ok">✓ Payouts active</span> <span class="note">Stripe Connect charges + payouts enabled.</span>`
          : `<span style="color:var(--acc);font-weight:600">Onboarding pending</span> <span class="note">Stripe needs more information before charges/payouts enable.</span> <form method="post" action="/api/payouts/connect" style="display:inline"><button class="btn" type="submit">Resume onboarding</button></form>`;
    return `<div class="kv"><span>${esc(c.owner)}</span><span>${state}</span></div>`;
  }).join("");
  const payoutPanel = data.claims.length
    ? `<div class="panel"><h3>Payouts</h3>${payoutRows}<p class="note" style="margin-top:8px">Standard listings pay out 85% to you (15% platform fee); Talents-exclusive listings pay 88% (12% fee). Fees are computed on the amount charged, floored to the cent in your favour.</p></div>`
    : "";

  const body = `<h2 style="margin-top:6px">Creator dashboard</h2>
  <p class="sub">Signed in${user.githubLogin ? ` as GitHub <span class="mono">${esc(user.githubLogin)}</span>` : ""} · <span class="mono">${esc(user.clerkUserId)}</span></p>
  ${dashNav("home")}
  ${claimPanel}
  ${payoutPanel}`;
  return renderPageShell("Creator dashboard", body);
}

// ---------------------------------------------------------------------------
// Listing manager
// ---------------------------------------------------------------------------

export function renderDashboardListings(owner: string, listings: DashboardListing[]): string {
  const rows = listings.map(({ record: r, override: o, unlisted, stats, enrichment }) => {
    const price = o?.priceCents ? formatPrice(o.priceCents, o.currency) + (o.exclusive ? " · exclusive" : "") : "free";
    const status = unlisted ? `<span style="color:var(--bad);font-weight:600">unlisted</span>` : `<span class="ok">listed</span>`;
    const enrNote = enrichment
      ? ` · enrichment ${enrichment.completeness}% (A ${layerMark(enrichment.layers.a)} · B ${layerMark(enrichment.layers.b)} · C ${layerMark(enrichment.layers.c)} · D ${layerMark(enrichment.layers.d)} · E ${layerMark(enrichment.layers.e)})${enrichment.trust?.flags.length ? ` · ${enrichment.trust.flags.length} trust flag${enrichment.trust.flags.length === 1 ? "" : "s"}` : ""}`
      : "";
    return `<div class="kv" style="align-items:center">
      <span><a href="/dashboard/listings/${esc(r.owner)}/${esc(r.name)}"><strong>${esc(r.name)}</strong></a> <span class="chip">${esc(r.kind)}</span><br>
      <span class="note">${o?.descriptionOverride ? "publisher description · " : ""}${stats ? `${stats.calls30d} calls / 30d · ${stats.installsTotal} installs` : "no traffic yet"}${enrNote}</span></span>
      <span>${status} · ${esc(price)}</span>
    </div>`;
  }).join("");
  const body = `<h2 style="margin-top:6px">Listings — ${esc(owner)}</h2>
  <p class="sub">${listings.length} listing${listings.length === 1 ? "" : "s"} under your claimed namespace. Edits are web-layer only: your repos and the attested records are never modified.</p>
  ${dashNav("listings")}
  <div class="panel">${rows || `<p style="color:var(--soft)">No listings yet.</p>`}</div>`;
  return renderPageShell("Your listings", body);
}

export function renderListingEdit(owner: string, listing: DashboardListing, opts: { saved?: boolean; error?: string } = {}): string {
  const { record: r, override: o, unlisted } = listing;
  const priceDollars = o?.priceCents ? (o.priceCents / 100).toFixed(2) : "";
  const displayDescription = o?.descriptionOverride ?? r.description;
  const body = `<h2 style="margin-top:6px">Edit listing</h2>
  <p class="sub"><a href="/dashboard/listings">← all listings</a> · <a href="/skills/${esc(r.owner)}/${esc(r.name)}">public page</a></p>
  ${dashNav("listings")}
  ${opts.saved ? `<div class="panel" style="border-color:var(--good)"><p class="ok">✓ Saved. The public page now shows your web-layer listing.</p></div>` : ""}
  ${opts.error ? `<div class="panel" style="border-color:var(--bad)"><p style="color:var(--bad)">${esc(opts.error)}</p></div>` : ""}
  <div class="cols">
    <div>
      <div class="panel"><h3>Listing details</h3>
      <form method="post" action="/dashboard/listings/${esc(r.owner)}/${esc(r.name)}">
        <input type="hidden" name="action" value="save">
        <h4>Description (publisher)</h4>
        <textarea name="description" rows="5" style="width:100%;padding:10px;border:1px solid var(--bd);border-radius:9px;background:var(--warm);font:inherit" placeholder="${esc(r.description)}">${esc(o?.descriptionOverride ?? "")}</textarea>
        <p class="note">Leave empty to show the source description. A publisher description is labelled as yours on the public page — the attestation covers the source text.</p>
        <h4 style="margin-top:14px">Tags (comma-separated, up to 8)</h4>
        <input type="text" name="tags" value="${esc((o?.tags ?? []).join(", "))}" style="width:100%;padding:10px;border:1px solid var(--bd);border-radius:9px;background:var(--warm);font:inherit">
        <h4 style="margin-top:14px">Price (USD — empty = free)</h4>
        <input type="text" name="price" value="${esc(priceDollars)}" placeholder="e.g. 12.50" style="width:180px;padding:10px;border:1px solid var(--bd);border-radius:9px;background:var(--warm);font:inherit">
        <label style="display:block;margin-top:12px;font-size:14px"><input type="checkbox" name="exclusive" ${o?.exclusive ? "checked" : ""}> Talents-exclusive listing (88% payout instead of 85%)</label>
        <button class="btn" type="submit" style="margin-top:16px">Save listing</button>
      </form>
      </div>
      <div class="panel"><h3>${unlisted ? "Relist" : "Unlist"}</h3>
      ${unlisted
        ? `<p style="color:var(--soft)">This listing is currently unlisted: hidden from search, pages, the aggregated marketplace and the gateway. The verified record stays stored for audit.</p>
           <form method="post" action="/dashboard/listings/${esc(r.owner)}/${esc(r.name)}"><input type="hidden" name="action" value="relist"><button class="btn" type="submit" style="margin-top:10px">Relist this skill</button></form>`
        : `<p style="color:var(--soft)">Unlisting removes this skill from search, its public page, the aggregated marketplace.json and the MCP gateway, immediately and everywhere Talents operates. The verified record remains in the registry for audit; relisting restores it.</p>
           <form method="post" action="/dashboard/listings/${esc(r.owner)}/${esc(r.name)}"><input type="hidden" name="action" value="unlist"><button class="btn" type="submit" style="margin-top:10px;background:var(--bad)">Unlist this skill</button></form>`}
      </div>
    </div>
    <div>
      <div class="panel"><h4>Public page preview</h4>
        <div class="name" style="font-size:18px">${esc(r.owner)} <span>/ ${esc(r.name)}</span> <span class="chip">${esc(r.kind)}</span></div>
        <p class="desc">${esc(displayDescription)}</p>
        ${o?.descriptionOverride ? `<p class="note" style="margin-top:6px"><span class="chip">Publisher description</span></p>` : ``}
        <div class="meta"><span>${o?.priceCents ? esc(formatPrice(o.priceCents, o.currency)) : "free"}</span><span>${unlisted ? "unlisted" : "listed"}</span></div>
      </div>
      <div class="panel"><h4>Source record (attested — not editable)</h4>
        <div class="kv"><span>Attestation</span><span>${r.attestation ? "✓ signed" : "pointer-only"}</span></div>
        <div class="kv"><span>Source</span><span class="mono">${esc(r.sourceRepo ?? r.sourceType)}</span></div>
        <div class="kv"><span>Pinned ref</span><span class="mono">${esc(r.ref)}</span></div>
      </div>
    </div>
  </div>`;
  return renderPageShell(`Edit ${owner}/${r.name}`, body);
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

function bar(value: number, max: number): string {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<span style="display:inline-block;vertical-align:middle;width:110px;height:9px;background:var(--asoft);border-radius:99px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:var(--acc)"></span></span>`;
}

export function renderAnalytics(owner: string, analytics: OwnerAnalytics): string {
  const t = analytics.totals;
  const maxCalls = Math.max(1, ...analytics.listings.map((l) => l.calls30d));
  const trendArrow = (trend: string, delta: number) =>
    trend === "up" ? `<span class="ok">▲ +${delta}</span>` : trend === "down" ? `<span style="color:var(--bad)">▼ ${delta}</span>` : `<span class="note">— flat</span>`;
  const rows = analytics.listings.map((l) => `
    <div class="kv" style="align-items:center">
      <span style="flex:1"><a href="/skills/${esc(l.skillId)}"><strong>${esc(l.skillId.split("/")[1] ?? l.skillId)}</strong></a><br>
      <span class="note">behavior score ${l.behaviorScore.toFixed(2)}${l.externalInstalls ? ` · ${l.externalInstalls} installs on skills.sh — external` : ""}</span></span>
      <span style="flex:1">${bar(l.calls30d, maxCalls)} <span class="note">${l.calls30d} calls / 30d</span></span>
      <span>${l.calls7d} calls / 7d ${trendArrow(l.trend, l.trendDelta)}<br><span class="note">${l.installsTotal} installs (${l.installs30d} / 30d)</span></span>
    </div>`).join("");
  const body = `<h2 style="margin-top:6px">Analytics — ${esc(owner)}</h2>
  <p class="sub">Gateway calls and installs recorded by Talents. A quiet namespace shows zeros — that's data, not an error.</p>
  ${dashNav("analytics")}
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
    <div class="card"><div class="name">${t.calls30d}</div><p class="desc">gateway calls, 30 days</p></div>
    <div class="card"><div class="name">${t.calls7d} ${trendArrow(t.trend, t.trendDelta)}</div><p class="desc">calls this week vs last</p></div>
    <div class="card"><div class="name">${t.installsTotal}</div><p class="desc">installs, all time (${t.installs30d} in 30d)</p></div>
    <div class="card"><div class="name">${t.externalInstalls}</div><p class="desc">installs on skills.sh — external signal, not counted above</p></div>
  </div>
  <div class="panel" style="margin-top:18px"><h3>Per listing</h3>${rows || `<p style="color:var(--soft)">No listings under this namespace yet.</p>`}</div>`;
  return renderPageShell("Analytics", body);
}

// ---------------------------------------------------------------------------
// Checkout success: one-time install token delivery
// ---------------------------------------------------------------------------

export function renderCheckoutSuccess(state:
  | { kind: "token"; token: string; skillId: string }
  | { kind: "already-picked-up"; skillId: string | null }
  | { kind: "processing" }
  | { kind: "unknown" }): string {
  let inner = "";
  if (state.kind === "token") {
    inner = `<div class="panel" style="max-width:680px;margin:18px auto;border-color:var(--good)">
      <h3>✓ Payment complete — ${esc(state.skillId)}</h3>
      <p style="color:var(--soft)">Your one-time install token is below. It is shown <strong>once</strong> — copy it now. Pass it to the MCP gateway to install:</p>
      <div class="code" style="white-space:normal;word-break:break-all">${esc(state.token)}</div>
      <p class="note" style="margin-top:10px">Gateway call: <span class="mono">install_skill { skill: "${esc(state.skillId)}", purchaseToken: "&lt;token&gt;" }</span> — then confirm with the attestation hash from the prepare payload, exactly like a free install. The token works for one install of this skill and expires in 30 days.</p>
      <p style="margin-top:12px"><a class="btn" href="/skills/${esc(state.skillId)}">Go to the skill page</a></p>
    </div>`;
  } else if (state.kind === "already-picked-up") {
    inner = `<div class="panel" style="max-width:680px;margin:18px auto">
      <h3>Token already shown</h3>
      <p style="color:var(--soft)">This purchase's install token was already displayed once, so it can't be shown again. ${state.skillId ? `If you lost it, the publisher's listing is <a href="/skills/${esc(state.skillId)}">${esc(state.skillId)}</a>; signed-in buyers with an entitlement see the install panel unlocked there.` : ""}</p>
    </div>`;
  } else if (state.kind === "processing") {
    inner = `<div class="panel" style="max-width:680px;margin:18px auto">
      <h3>Payment is processing</h3>
      <p style="color:var(--soft)">Stripe has your payment; the confirmation webhook hasn't landed yet. Refresh this page in a few seconds — your install token will appear here, once.</p>
    </div>`;
  } else {
    inner = `<div class="panel" style="max-width:680px;margin:18px auto">
      <h3>We can't find that checkout</h3>
      <p style="color:var(--soft)">This success link doesn't match a recorded purchase. If you were charged, the receipt email from Stripe has the details; the entitlement is recorded against the email used at checkout.</p>
    </div>`;
  }
  const body = `<section class="hero"><h1>Checkout</h1></section>${inner}`;
  return renderPageShell("Checkout", body);
}
