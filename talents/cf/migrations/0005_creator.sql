-- Creator Experience (P4, ARCHITECTURE-v2 §9) — identity, claims,
-- web-layer listing management, Stripe Connect money, entitlements.
--
-- Trust boundary, stated once here and enforced in code:
--   * `records.record_json` is the ATTESTED source-derived record.
--     Nothing in this migration ever mutates it. Creator edits live
--     in `listing_overrides` and are merged at render time only.
--   * Owner unlisting is ABSOLUTE for display (search, pages,
--     aggregate, gateway) while the verified record row stays in D1
--     for audit. Re-listing removes the unlist row.

-- Signed-in users, mirrored from Clerk on first authenticated request.
-- github_login comes from the Clerk user's GitHub external account
-- (Clerk GitHub social connection); NULL until Clerk reports one.
CREATE TABLE users (
  clerk_user_id TEXT PRIMARY KEY,
  github_login TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_users_github_login ON users (github_login);

-- Namespace claims (web path). The engine's P0 claim model
-- (src/namespace.ts) is git-style first-come-first-served with GitHub
-- ownership proof; the web path's proof is: the signed-in Clerk user's
-- verified GitHub login IS the namespace (method 'github-login-match'),
-- or an org-admin token proof via the engine (method 'org-admin-token').
-- One row per owner: the owner is the trust anchor, claimed once.
CREATE TABLE claims (
  owner TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  method TEXT NOT NULL,          -- github-login-match | org-admin-token
  claimed_at TEXT NOT NULL
);
CREATE INDEX idx_claims_user ON claims (clerk_user_id);

-- Web-layer listing overrides. NEVER written back into record_json.
-- price_cents NULL = free / not for sale. exclusive = the publisher
-- sells this listing only on Talents (88% share tier, see fees).
CREATE TABLE listing_overrides (
  skill_id TEXT PRIMARY KEY,
  description_override TEXT,
  tags TEXT,                     -- JSON array of strings, or NULL
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  exclusive INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL       -- clerk_user_id of the claiming user
);

-- Owner opt-out. Presence of a row = unlisted everywhere we operate.
CREATE TABLE unlisted_skills (
  skill_id TEXT PRIMARY KEY,
  unlisted_by TEXT NOT NULL,     -- clerk_user_id
  unlisted_at TEXT NOT NULL
);

-- Stripe Connect Express accounts, one per claimed owner.
CREATE TABLE creator_accounts (
  owner TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  onboarded_at TEXT
);

-- Purchases of priced listings (destination charges on the creator's
-- Connect account). stripe_checkout_session is the idempotency key:
-- the Stripe webhook may deliver checkout.session.completed more
-- than once; the row is written once.
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  buyer_clerk_id TEXT,
  buyer_email TEXT,
  stripe_checkout_session TEXT NOT NULL UNIQUE,
  payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  creator_cents INTEGER NOT NULL,
  status TEXT NOT NULL,          -- completed | refunded
  created_at TEXT NOT NULL
);
CREATE INDEX idx_purchases_skill ON purchases (skill_id);
CREATE INDEX idx_purchases_buyer ON purchases (buyer_clerk_id);

-- What a purchase grants: the right to install the priced skill.
-- Buyer identity is the Clerk user id when signed in, else the email
-- captured at checkout.
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  buyer_clerk_id TEXT,
  buyer_email TEXT,
  purchase_id TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE INDEX idx_entitlements_skill_buyer ON entitlements (skill_id, buyer_clerk_id);
CREATE INDEX idx_entitlements_skill_email ON entitlements (skill_id, buyer_email);

-- One-time install tokens for anonymous gateway buyers. Only the
-- SHA-256 hash is stored; the plaintext is shown exactly once, on
-- the post-checkout success page. A token authorizes ONE gateway
-- install confirm of its skill, then it is spent (used_at set).
CREATE TABLE install_tokens (
  token_hash TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  purchase_id TEXT,
  buyer_clerk_id TEXT,
  buyer_email TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_install_tokens_skill ON install_tokens (skill_id);

-- Pending token delivery: Stripe's webhook (which creates the
-- entitlement) cannot show the buyer anything. The checkout session
-- id — known only to the buyer returning from Stripe — keys a
-- one-time pickup of the plaintext token on the success page. The
-- row is deleted on pickup; the hash above is what install checks.
CREATE TABLE pending_token_pickups (
  checkout_session_id TEXT PRIMARY KEY,
  token_plain TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
