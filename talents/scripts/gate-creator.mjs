// Creator Experience gate (P4) — reproducible local evidence:
// seeds the local D1 (migrations incl. 0005), boots the Worker
// twice under wrangler dev —
//   boot A: with the DEV-ONLY auth stub (TALENTS_AUTH_MOCK — honored
//           only when Clerk is unconfigured; never present in the
//           deploy config) + a fixture STRIPE_WEBHOOK_SECRET, and
//           drives the whole creator surface over HTTP: claim →
//           listing edit → priced page (honest disabled buy) →
//           unlist propagation (page/search/aggregate) → relist →
//           signed Stripe webhook → idempotent fulfilment → one-time
//           token pickup → gateway payment gating → paid install
//           through the unchanged hash ceremony (via the source
//           relay, the sandbox's dev-only GitHub egress);
//   boot B: no stub — the unauthenticated behaviour (redirect,
//           401, honest /sign-in setup state).
// Live-deployment smoke is recorded separately in the gate JSON.
// Evidence → data/gate-creator.json + data/gate-creator.txt.

import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHmac } from "node:crypto";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CF = resolve(ROOT, "cf");
const PORT_A = 4421;
const PORT_B = 4423;
const RELAY_PORT = 4429;
const WEBHOOK_SECRET = "whsec_gate_local_fixture";
const MOCK = JSON.stringify({ clerkUserId: "user_gate_mock", githubLogin: "anthropics" });

const lines = [];
const results = { local: {}, pass: true };
function check(label, ok, detail = "") {
  results.pass = results.pass && ok;
  results.local[label] = { pass: ok, detail };
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(lines[lines.length - 1]);
}
const log = (s) => { lines.push(s); console.log(s) };

function boot(port, extraVars) {
  const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), ...extraVars], {
    cwd: CF, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let devLog = "";
  dev.stdout.on("data", (d) => { devLog += d; });
  dev.stderr.on("data", (d) => { devLog += d; });
  return { dev, log: () => devLog };
}

async function waitUp(base) {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${base}/api/search?q=pdf`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killTree(proc) {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ }
}

async function mcp(base, name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  return JSON.parse(body.result.content[0].text);
}

const form = (obj) => new URLSearchParams(obj);

// --- seed -------------------------------------------------------------------
log("== seed local D1 (migrations incl. 0005 + seed records) ==");
execSync("npm run seed", { cwd: CF, stdio: "inherit" });
execSync("npm run build", { cwd: CF, stdio: "inherit" });

// Reset the P4 fixture state so the gate is reproducible against the
// persistent local D1 (claims/purchases/tokens from a prior run must
// not leak into this one). Local dev DB only — never run remotely.
log("== reset creator fixture state (local D1 only) ==");
writeFileSync(resolve(CF, "gate-creator-reset.sql"), [
  "DELETE FROM claims;",
  "DELETE FROM listing_overrides;",
  "DELETE FROM unlisted_skills;",
  "DELETE FROM purchases;",
  "DELETE FROM entitlements;",
  "DELETE FROM install_tokens;",
  "DELETE FROM pending_token_pickups;",
  "DELETE FROM creator_accounts;",
  "DELETE FROM users;",
  "DELETE FROM namespaces WHERE owner = 'anthropics';",
  "DELETE FROM installs WHERE skill_id IN ('anthropics/pdf', 'anthropics/docx');",
  "",
].join("\n"));
execSync("npx wrangler d1 execute talents-dev --local --file=gate-creator-reset.sql", { cwd: CF, stdio: "inherit" });

// --- source relay -------------------------------------------------------------
const relay = spawn("node", [resolve(ROOT, "scripts/source-relay.mjs")], {
  env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
  detached: true, stdio: ["ignore", "pipe", "pipe"],
});

// === boot A: authenticated creator surface ====================================
const A = `http://127.0.0.1:${PORT_A}`;
log("== boot A (auth stub + fixture webhook secret) ==");
const bootA = boot(PORT_A, [
  "--var", `TALENTS_AUTH_MOCK:${MOCK}`,
  "--var", `STRIPE_WEBHOOK_SECRET:${WEBHOOK_SECRET}`,
  "--var", `TALENTS_SOURCE_RELAY:http://127.0.0.1:${RELAY_PORT}`,
]);
try {
  const up = await waitUp(A);
  check("boot A answers", up, up ? "" : bootA.log().slice(-600));
  if (!up) throw new Error("boot A failed");

  // --- claim flow ---
  const dash1 = await (await fetch(`${A}/dashboard`)).text();
  check("dashboard offers the one-click claim for the matching namespace",
    dash1.includes("Claim") && dash1.includes("anthropics"));
  const claim = await fetch(`${A}/api/claims`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "anthropics" }),
  });
  const claimJson = await claim.json();
  check("POST /api/claims (login match) → claimed", claim.status === 200 && claimJson.claimed === "anthropics",
    JSON.stringify(claimJson));
  const claimBad = await fetch(`${A}/api/claims`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: "garrytan" }),
  });
  check("POST /api/claims (login mismatch) → 403", claimBad.status === 403, `status ${claimBad.status}`);
  const dash2 = await (await fetch(`${A}/dashboard`)).text();
  check("dashboard shows Verified publisher + honest payouts state",
    dash2.includes("Verified publisher") && dash2.includes("not enabled"));
  const profile = await (await fetch(`${A}/anthropics`)).text();
  check("public profile shows the Verified publisher badge", profile.includes("Verified publisher"));

  // --- listing edit: publisher description + price ---
  const aggBefore = await (await fetch(`${A}/.claude-plugin/marketplace.json`)).json();
  const edit = await fetch(`${A}/dashboard/listings/anthropics/pdf`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ action: "save", description: "Gate publisher description for PDF.", tags: "pdf, gate", price: "12.50", exclusive: "on" }),
    redirect: "manual",
  });
  check("listing edit saves (303 to saved view)", edit.status === 303, `status ${edit.status}`);
  const skillPage = await (await fetch(`${A}/skills/anthropics/pdf`)).text();
  check("skill page labels the Publisher description",
    skillPage.includes("Publisher description") && skillPage.includes("Gate publisher description for PDF."));
  check("priced page (owner view) shows price + split note",
    skillPage.includes("$12.50") && skillPage.includes("This is your listing") && skillPage.includes("88% to you"),
    "the anonymous disabled-Buy state is asserted in boot B");
  const searchPdf = await (await fetch(`${A}/api/search?q=pdf`)).json();
  check("/api/search merges the publisher description + price",
    searchPdf.results[0]?.description === "Gate publisher description for PDF."
      && searchPdf.results[0]?.publisherDescription === true
      && searchPdf.results[0]?.priceCents === 1250,
    JSON.stringify(searchPdf.results[0] ?? {}));

  // --- unlist propagation ---
  const unlist = await fetch(`${A}/dashboard/listings/anthropics/xlsx`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ action: "unlist" }), redirect: "manual",
  });
  check("unlist action saves", unlist.status === 303, `status ${unlist.status}`);
  const gonePage = await fetch(`${A}/skills/anthropics/xlsx`);
  check("unlisted skill page → 404", gonePage.status === 404, `status ${gonePage.status}`);
  const searchXlsx = await (await fetch(`${A}/api/search?q=xlsx`)).json();
  check("unlisted skill absent from /api/search",
    !searchXlsx.results.some((r) => r.id === "anthropics/xlsx"));
  const aggAfter = await (await fetch(`${A}/.claude-plugin/marketplace.json`)).json();
  check("unlisted skill excluded from the aggregate (count drops by 1)",
    aggAfter.plugins.length === aggBefore.plugins.length - 1
      && !aggAfter.plugins.some((p) => p.name === "xlsx"),
    `${aggBefore.plugins.length} → ${aggAfter.plugins.length}`);
  await fetch(`${A}/dashboard/listings/anthropics/xlsx`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ action: "relist" }), redirect: "manual",
  });
  const backPage = await fetch(`${A}/skills/anthropics/xlsx`);
  const aggBack = await (await fetch(`${A}/.claude-plugin/marketplace.json`)).json();
  check("relist restores page + aggregate",
    backPage.status === 200 && aggBack.plugins.length === aggBefore.plugins.length);

  // --- dashboard listings + analytics ---
  const listings = await (await fetch(`${A}/dashboard/listings`)).text();
  check("listing manager lists the namespace with price state",
    listings.includes("pdf") && listings.includes("$12.50"));
  const analytics = await (await fetch(`${A}/dashboard/analytics`)).text();
  check("analytics page renders (zeros are honest)", analytics.includes("Analytics") && analytics.includes("gateway calls"));

  // --- Stripe webhook → fulfilment → token pickup ---
  const session = {
    id: "cs_gate_1", payment_intent: "pi_gate", amount_total: 1250, currency: "usd",
    payment_status: "paid", customer_details: { email: "buyer@example.com" },
    metadata: { skill_id: "anthropics/pdf", buyer_clerk_id: "user_gate_mock", exclusive: "1" },
  };
  const eventBody = JSON.stringify({ id: "evt_gate", type: "checkout.session.completed", data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${eventBody}`).digest("hex");
  const wh1 = await fetch(`${A}/webhooks/stripe`, {
    method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: eventBody,
  });
  const wh1Json = await wh1.json();
  check("signed checkout webhook → fulfilled", wh1.status === 200 && wh1Json.fulfilled === "fulfilled", JSON.stringify(wh1Json));
  const wh2 = await fetch(`${A}/webhooks/stripe`, {
    method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: eventBody,
  });
  const wh2Json = await wh2.json();
  check("same webhook redelivered → idempotent (already)", wh2Json.fulfilled === "already", JSON.stringify(wh2Json));
  const whBad = await fetch(`${A}/webhooks/stripe`, {
    method: "POST", headers: { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, body: eventBody,
  });
  check("bad signature → 401", whBad.status === 401, `status ${whBad.status}`);

  const success1 = await (await fetch(`${A}/checkout/success?session_id=cs_gate_1`)).text();
  const tokenMatch = success1.match(/tix_[A-Za-z0-9_-]{20,}/);
  check("success page shows the one-time install token", Boolean(tokenMatch));
  const token = tokenMatch?.[0] ?? "";
  const success2 = await (await fetch(`${A}/checkout/success?session_id=cs_gate_1`)).text();
  check("token pickup is one-time (second visit: already shown)",
    !success2.includes(token) && success2.includes("already displayed"));

  // --- gateway payment gating, ending in the unchanged hash ceremony ---
  const prepNoToken = await mcp(A, "install_skill", { skill: "anthropics/pdf" });
  check("gateway prepare (priced, no token) → payment_required, no hash leaked",
    prepNoToken.status === "payment_required" && prepNoToken.attestationHash === undefined,
    JSON.stringify(prepNoToken).slice(0, 200));
  const prep = await mcp(A, "install_skill", { skill: "anthropics/pdf", purchaseToken: token });
  check("gateway prepare (priced, valid token) → prepared",
    prep.status === "prepared" && typeof prep.attestationHash === "string");
  const installed = await mcp(A, "install_skill", {
    skill: "anthropics/pdf", confirm: true, attestationHash: prep.attestationHash, purchaseToken: token,
  });
  check("gateway confirm (token + hash ceremony) → installed",
    installed.status === "installed", JSON.stringify(installed).slice(0, 200));
  const prepSpent = await mcp(A, "install_skill", { skill: "anthropics/pdf", purchaseToken: token });
  check("spent token no longer unlocks prepare", prepSpent.status === "payment_required");

  // --- free-skill regression: ceremony untouched ---
  const freePrep = await mcp(A, "install_skill", { skill: "anthropics/docx" });
  check("free skill prepare unchanged", freePrep.status === "prepared");
  const freeInstall = await mcp(A, "install_skill", {
    skill: "anthropics/docx", confirm: true, attestationHash: freePrep.attestationHash,
  });
  check("free skill confirm unchanged → installed", freeInstall.status === "installed",
    JSON.stringify(freeInstall).slice(0, 160));
} finally {
  killTree(bootA.dev);
}

// === boot B: unauthenticated behaviour ========================================
const B = `http://127.0.0.1:${PORT_B}`;
log("== boot B (no auth stub, no Clerk keys) ==");
const bootB = boot(PORT_B, ["--var", `TALENTS_SOURCE_RELAY:http://127.0.0.1:${RELAY_PORT}`]);
try {
  const up = await waitUp(B);
  check("boot B answers", up, up ? "" : bootB.log().slice(-600));
  if (!up) throw new Error("boot B failed");
  const dashAnon = await fetch(`${B}/dashboard`, { redirect: "manual" });
  check("unauthenticated /dashboard → redirect to /sign-in",
    dashAnon.status === 303 && dashAnon.headers.get("location") === "/sign-in",
    `status ${dashAnon.status} location ${dashAnon.headers.get("location")}`);
  const claimsAnon = await fetch(`${B}/api/claims`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: "anthropics" }),
  });
  check("unauthenticated POST /api/claims → 401", claimsAnon.status === 401, `status ${claimsAnon.status}`);
  const signIn = await (await fetch(`${B}/sign-in`)).text();
  check("/sign-in renders the honest awaiting-Clerk-keys state",
    signIn.includes("Setup remaining") && signIn.includes("Clerk application"));
  const pub = await fetch(`${B}/skills/anthropics/pdf`);
  const pubText = await pub.text();
  check("public skill page unaffected by auth state", pub.status === 200, `status ${pub.status}`);
  check("priced page (anonymous, no Stripe keys) shows price + honest disabled Buy",
    pubText.includes("$12.50") && pubText.includes("not yet enabled") && pubText.includes("disabled")
      && !pubText.includes("This is your listing"));
  const whOff = await fetch(`${B}/webhooks/stripe`, { method: "POST", body: "{}" });
  check("stripe webhook unconfigured → 503 (never unverified-accept)", whOff.status === 503, `status ${whOff.status}`);
} finally {
  killTree(bootB.dev);
  killTree(relay);
}

// --- teardown: restore the local D1's creator tables to their
// pre-gate (empty) state so OTHER gates sharing this dev DB (the P2
// ceremony installs anthropics/pdf as a FREE skill) are unaffected
// by this gate's fixtures.
log("== teardown: reset creator fixture state again (local D1 only) ==");
execSync("npx wrangler d1 execute talents-dev --local --file=gate-creator-reset.sql", { cwd: CF, stdio: "inherit" });

log("");
log(results.pass ? "GATE CREATOR (local): PASS" : "GATE CREATOR (local): FAIL");
writeFileSync(resolve(ROOT, "data/gate-creator.json"), JSON.stringify(results, null, 2));
writeFileSync(resolve(ROOT, "data/gate-creator.txt"), lines.join("\n") + "\n");
process.exit(results.pass ? 0 : 1);
