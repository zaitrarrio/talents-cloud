#!/usr/bin/env node
// Live gate for the Talents creator-auth swap (Clerk TEST keys).
//
// Reads the Clerk secret key from stdin. Never prints the key, the
// session JWT, or any password. Prints PASS/FAIL lines; exits 0 only
// when every check passes. (Node fetch is the HTTP client: Python
// urllib's connections to talents.sh / api.clerk.com die with
// IncompleteRead / RemoteDisconnected through this sandbox's egress
// proxy, and both hosts 403 the stock urllib UA with Cloudflare
// error 1010 — node fetch + curl are unaffected.)
//
// Flow: /sign-in renders the real Clerk widget → instance is in test
// mode (environment endpoint) → create a throwaway test user via the
// Clerk Backend API → mint a sign-in token (ticket) → exchange it on
// the Frontend API for a real session JWT → present the JWT to the
// live Worker as the __session cookie → /dashboard renders,
// /api/claims runs the claim logic (403, no GitHub login — the test
// user has none), and unauthenticated requests stay gated. The test
// user is deleted at the end when this run created it.

import { randomBytes } from "node:crypto";

const BAPI = "https://api.clerk.com";
const FAPI = "https://kind-aphid-7842.clerk.accounts.dev";
const WORKER = "https://talents.sh";
const EMAIL = "talents-gate-test@example.com";

const results = [];
function check(name, ok, detail = "") {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sandbox egress proxy intermittently closes connections
// mid-request (the same flakiness that kills the backfill drain);
// retry transient socket failures a few times. HTTP error statuses
// are real answers and are never retried.
async function req(method, url, { key, body, headers = {} } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML error pages */ }
      return { status: res.status, text, json, location: res.headers.get("location") };
    } catch (e) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

async function main() {
  const key = await readStdin();
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) {
    console.log("FAIL: no Clerk secret key on stdin");
    return 1;
  }

  // 1. /sign-in renders the real Clerk widget, no setup steps.
  {
    const r = await req("GET", `${WORKER}/sign-in`);
    check("live: /sign-in renders Clerk sign-in (no Setup remaining)",
      r.status === 200 && r.text.includes("clerk.browser.js")
        && r.text.includes("mountSignIn") && !r.text.includes("Setup remaining"),
      `status ${r.status}`);
  }

  // 2. Instance is in test mode; record which social providers exist.
  let socialEnabled = [];
  {
    const r = await req("GET", `${FAPI}/v1/environment`);
    const ac = r.json?.auth_config ?? {};
    const social = r.json?.user_settings?.social ?? {};
    socialEnabled = Object.entries(social)
      .filter(([, v]) => v && v.enabled).map(([k]) => k).sort();
    check("live: Clerk instance is in test mode",
      r.status === 200 && ac.test_mode === true, `test_mode=${ac.test_mode}`);
    check("live: GitHub social connection state recorded",
      r.status === 200, `enabled social providers: ${socialEnabled.join(", ") || "(none)"}`);
  }

  // 3. Test user via the Backend API (create only if absent).
  let userId = null;
  let created = false;
  {
    const r = await req("GET", `${BAPI}/v1/users?email_address=${encodeURIComponent(EMAIL)}`, { key });
    const found = Array.isArray(r.json) ? r.json : (r.json?.data ?? []);
    if (r.status === 200 && found.length) {
      userId = found[0].id;
    } else {
      const pw = randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, 24) + "9!";
      // NOTE: the BAPI wants `email_address` as an ARRAY (singular
      // key, array value) — a bare string 400s, `email_addresses`
      // 422s. (Shape confirmed against @clerk/backend's
      // CreateUserParams: emailAddress?: string[].)
      let u = await req("POST", `${BAPI}/v1/users`, {
        key,
        body: { email_address: [EMAIL], password: pw, first_name: "Talents", last_name: "Gate" },
      });
      if (![200, 201].includes(u.status) || !u.json?.id) {
        // Password policy may refuse it; retry passwordless.
        u = await req("POST", `${BAPI}/v1/users`, {
          key,
          body: { email_address: [EMAIL], first_name: "Talents", last_name: "Gate" },
        });
      }
      if ([200, 201].includes(u.status) && u.json?.id) {
        userId = u.json.id;
        created = true;
      }
    }
  }
  check("live: test user exists in the Clerk app", Boolean(userId), `created=${created}`);

  let jwt = null;
  if (userId) {
    // 4. Sign-in token (ticket) for the user.
    const t = await req("POST", `${BAPI}/v1/sign_in_tokens`, {
      key, body: { user_id: userId, expires_in_seconds: 600 },
    });
    const ticket = [200, 201].includes(t.status) ? t.json?.token : null;
    check("live: sign-in token minted for the test user", Boolean(ticket), `status ${t.status}`);
    if (ticket) {
      // 5. Exchange the ticket on the Frontend API for a session.
      // The FAPI only parses form-encoded bodies (a JSON body is
      // silently ignored — the attempt stays `needs_identifier`) and
      // `identifier` is disallowed with strategy ticket, so the call
      // is exactly { strategy: "ticket", ticket }.
      const form = new URLSearchParams({ strategy: "ticket", ticket });
      const siRes = await fetch(`${FAPI}/v1/client/sign_ins`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const siJson = await siRes.json().catch(() => null);
      const attempt = siJson?.response ?? siJson;
      const sessionId = [200, 201].includes(siRes.status) ? attempt?.created_session_id : null;
      check("live: ticket exchange completes a sign-in",
        [200, 201].includes(siRes.status) && attempt?.status === "complete" && Boolean(sessionId),
        `status ${siRes.status} sign_in_status=${attempt?.status}`);
      if (sessionId) {
        // 6. Session JWT for the session — via the Backend API
        // (POST /v1/sessions/:id/tokens). The Frontend API's
        // tokens endpoint needs the __client cookie, which no
        // headless client receives here; the BAPI route is the
        // supported server-side equivalent.
        const tj = await req("POST", `${BAPI}/v1/sessions/${sessionId}/tokens`, {
          key, body: { expires_in_seconds: 300 },
        });
        jwt = [200, 201].includes(tj.status) ? tj.json?.jwt : null;
        check("live: session JWT obtained", Boolean(jwt), `status ${tj.status}`);
      }
    }
  }

  // 7. The Worker accepts the real session JWT.
  if (jwt) {
    const d = await req("GET", `${WORKER}/dashboard`, {
      headers: { Cookie: `__session=${jwt}` },
    });
    check("live: /dashboard renders for the signed-in test user",
      d.status === 200 && d.text.includes("Signed in"), `status ${d.status}`);
    const c = await req("POST", `${WORKER}/api/claims`, {
      headers: { Cookie: `__session=${jwt}` },
      body: { owner: "talents-gate" },
    });
    // No GitHub login on the test user: the claim logic must run and
    // refuse (403), not reject the session (401).
    check("live: /api/claims runs for the session, refuses without a GitHub login",
      c.status === 403, `status ${c.status} body=${c.text.slice(0, 160)}`);
  }

  // 8. Unauthenticated requests stay gated.
  {
    const d = await req("GET", `${WORKER}/dashboard`);
    check("live: unauthenticated /dashboard → /sign-in",
      [301, 302, 303].includes(d.status) && (d.location ?? "").includes("/sign-in"),
      `status ${d.status}`);
    const c = await req("POST", `${WORKER}/api/claims`, { body: { owner: "talents-gate" } });
    check("live: unauthenticated POST /api/claims → 401", c.status === 401, `status ${c.status}`);
    const e = await req("POST", `${WORKER}/dashboard/listings/anthropics/pdf`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: undefined,
    });
    check("live: unauthenticated listing edit stays auth-gated",
      [301, 302, 303, 401].includes(e.status), `status ${e.status}`);
  }

  // 9. Clean up the test user when this run created it.
  if (userId && created) {
    const del = await req("DELETE", `${BAPI}/v1/users/${userId}`, { key });
    check("live: test user deleted after the gate",
      [200, 204].includes(del.status), `status ${del.status}`);
  }

  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`\nGATE CREATOR-AUTH (live): ${failed.length ? "FAIL" : "PASS"} `
    + `(${results.length - failed.length}/${results.length} checks)`);
  return failed.length ? 1 : 0;
}

process.exit(await main());
