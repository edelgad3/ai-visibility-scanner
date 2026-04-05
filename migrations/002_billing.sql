-- Billing: Add Stripe fields to agencies table
-- Run against Supabase SQL Editor

-- 1. Add Stripe columns to agencies
ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_email TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none'
    CHECK (subscription_status IN ('none', 'active', 'past_due', 'canceled', 'trialing')),
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;

-- 2. Index for Stripe lookups
CREATE INDEX IF NOT EXISTS idx_agencies_stripe_customer
  ON agencies(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agencies_stripe_subscription
  ON agencies(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- 3. RPC to reset scans_used monthly (call from cron or Stripe invoice.paid)
CREATE OR REPLACE FUNCTION reset_agency_scans(agency_uuid UUID)
RETURNS void AS $$
BEGIN
  UPDATE agencies SET scans_used = 0 WHERE id = agency_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC to provision agency (called from webhook handler)
CREATE OR REPLACE FUNCTION provision_agency(
  p_name TEXT,
  p_slug TEXT,
  p_tier TEXT,
  p_scans_limit INTEGER,
  p_billing_email TEXT,
  p_stripe_customer_id TEXT,
  p_stripe_subscription_id TEXT,
  p_stripe_price_id TEXT,
  p_brand_name TEXT DEFAULT 'AI Visibility Scanner',
  p_current_period_end TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(id UUID, api_key TEXT, slug TEXT) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO agencies (
    name, slug, tier, scans_limit, billing_email,
    stripe_customer_id, stripe_subscription_id, stripe_price_id,
    brand_name, subscription_status, current_period_end
  ) VALUES (
    p_name, p_slug, p_tier, p_scans_limit, p_billing_email,
    p_stripe_customer_id, p_stripe_subscription_id, p_stripe_price_id,
    p_brand_name, 'active', p_current_period_end
  )
  RETURNING agencies.id, agencies.api_key, agencies.slug;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
