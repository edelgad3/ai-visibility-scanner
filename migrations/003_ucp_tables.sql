-- UCP Commerce Tables for Agent-to-Business Purchasing
-- Sprint 2: UCP Tool — Run against Supabase SQL Editor
-- Depends on: 001_agency_tables.sql (agencies table)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. UCP Offerings — product/service catalog per agency
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ucp_offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,

  -- Product details
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'service',

  -- Pricing
  price_amount INTEGER NOT NULL,             -- cents
  price_currency TEXT NOT NULL DEFAULT 'USD',
  price_type TEXT NOT NULL DEFAULT 'fixed'
    CHECK (price_type IN ('fixed', 'hourly', 'monthly', 'quote')),

  -- Fulfillment
  fulfillment_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (fulfillment_type IN ('digital', 'manual', 'api')),
  fulfillment_endpoint TEXT,                 -- for api fulfillment

  -- Availability
  active BOOLEAN NOT NULL DEFAULT true,
  requires_auth BOOLEAN NOT NULL DEFAULT true,
  max_quantity INTEGER,                      -- NULL = unlimited
  lead_time_hours INTEGER,                   -- estimated fulfillment time

  -- Metadata
  metadata JSONB DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(agency_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_ucp_offerings_agency
  ON ucp_offerings(agency_id) WHERE active = true;

DROP TRIGGER IF EXISTS ucp_offerings_updated_at ON ucp_offerings;
CREATE TRIGGER ucp_offerings_updated_at
  BEFORE UPDATE ON ucp_offerings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. UCP Agent Keys — registered AI agent API keys
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ucp_agent_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,

  -- Agent identity
  agent_name TEXT NOT NULL,
  agent_url TEXT,                             -- agent's home URL
  contact_email TEXT NOT NULL,

  -- Auth
  key_hash TEXT NOT NULL UNIQUE,              -- SHA-256 of the raw key
  key_prefix TEXT NOT NULL,                   -- first 12 chars for display

  -- Permissions
  permissions TEXT[] NOT NULL DEFAULT ARRAY['browse_catalog', 'get_quote', 'place_order'],

  -- Status
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  requests_today INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_day INTEGER NOT NULL DEFAULT 1000,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ucp_agent_keys_agency
  ON ucp_agent_keys(agency_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_ucp_agent_keys_hash
  ON ucp_agent_keys(key_hash) WHERE active = true;

DROP TRIGGER IF EXISTS ucp_agent_keys_updated_at ON ucp_agent_keys;
CREATE TRIGGER ucp_agent_keys_updated_at
  BEFORE UPDATE ON ucp_agent_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. UCP Orders — orders placed by AI agents
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ucp_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  offering_id UUID NOT NULL REFERENCES ucp_offerings(id),
  agent_key_id UUID NOT NULL REFERENCES ucp_agent_keys(id),

  -- Order details
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'processing', 'fulfilled', 'cancelled', 'refunded')),

  -- Payment
  payment_method TEXT DEFAULT 'stripe',
  payment_intent_id TEXT,
  paid BOOLEAN NOT NULL DEFAULT false,

  -- Agent context
  agent_name TEXT NOT NULL,
  agent_reference TEXT,                      -- agent's own order ID
  agent_notes TEXT,

  -- Fulfillment
  fulfillment_type TEXT NOT NULL DEFAULT 'manual',
  fulfilled_at TIMESTAMPTZ,
  fulfillment_data JSONB,                    -- delivery payload (URLs, keys, etc.)

  -- Metadata
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ucp_orders_agency
  ON ucp_orders(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ucp_orders_agent_key
  ON ucp_orders(agent_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ucp_orders_status
  ON ucp_orders(agency_id, status) WHERE status NOT IN ('fulfilled', 'cancelled', 'refunded');

DROP TRIGGER IF EXISTS ucp_orders_updated_at ON ucp_orders;
CREATE TRIGGER ucp_orders_updated_at
  BEFORE UPDATE ON ucp_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 4. UCP Order Events — status changes + fulfillment tracking
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ucp_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES ucp_orders(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'created', 'confirmed', 'processing',
      'fulfilled', 'cancelled', 'refunded',
      'payment_received', 'payment_failed',
      'webhook_sent', 'webhook_failed',
      'note'
    )),

  -- Event data
  detail TEXT,
  metadata JSONB DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT 'system',       -- 'system', 'agent', 'agency'

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ucp_order_events_order
  ON ucp_order_events(order_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Row Level Security
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE ucp_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucp_agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucp_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ucp_order_events ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (server-side only)
CREATE POLICY "service_all_ucp_offerings" ON ucp_offerings FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "service_all_ucp_agent_keys" ON ucp_agent_keys FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "service_all_ucp_orders" ON ucp_orders FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "service_all_ucp_order_events" ON ucp_order_events FOR ALL
  USING (auth.role() = 'service_role');

-- Deny all for anon/authenticated roles (API handles all access)
CREATE POLICY "deny_anon_ucp_offerings" ON ucp_offerings FOR ALL
  TO anon, authenticated USING (false);

CREATE POLICY "deny_anon_ucp_agent_keys" ON ucp_agent_keys FOR ALL
  TO anon, authenticated USING (false);

CREATE POLICY "deny_anon_ucp_orders" ON ucp_orders FOR ALL
  TO anon, authenticated USING (false);

CREATE POLICY "deny_anon_ucp_order_events" ON ucp_order_events FOR ALL
  TO anon, authenticated USING (false);

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Helper RPCs
-- ═══════════════════════════════════════════════════════════════════════

-- Atomic rate-limit check + increment for agent keys
CREATE OR REPLACE FUNCTION ucp_check_agent_rate_limit(p_key_hash TEXT)
RETURNS TABLE(allowed BOOLEAN, agent_key_id UUID, agency_id UUID, agent_name TEXT, permissions TEXT[]) AS $$
DECLARE
  v_key RECORD;
BEGIN
  SELECT ak.id, ak.agency_id, ak.agent_name, ak.permissions,
         ak.requests_today, ak.rate_limit_per_day, ak.active
  INTO v_key
  FROM ucp_agent_keys ak
  WHERE ak.key_hash = p_key_hash AND ak.active = true
  LIMIT 1;

  IF NOT FOUND THEN
    allowed := false;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_key.requests_today >= v_key.rate_limit_per_day THEN
    allowed := false;
    agent_key_id := v_key.id;
    agency_id := v_key.agency_id;
    agent_name := v_key.agent_name;
    permissions := v_key.permissions;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Increment counter + update last_used_at
  UPDATE ucp_agent_keys
  SET requests_today = requests_today + 1, last_used_at = now()
  WHERE id = v_key.id;

  allowed := true;
  agent_key_id := v_key.id;
  agency_id := v_key.agency_id;
  agent_name := v_key.agent_name;
  permissions := v_key.permissions;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Daily reset of agent rate limits (call from cron)
CREATE OR REPLACE FUNCTION ucp_reset_daily_rate_limits()
RETURNS void AS $$
BEGIN
  UPDATE ucp_agent_keys SET requests_today = 0 WHERE requests_today > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
