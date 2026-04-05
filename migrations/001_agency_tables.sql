-- Agency Multi-Tenant Tables for AI Visibility Scanner
-- Run against Supabase SQL Editor or psql

-- 1. Agencies table
CREATE TABLE IF NOT EXISTS agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),

  -- Tier & limits
  tier TEXT NOT NULL DEFAULT 'starter' CHECK (tier IN ('starter', 'growth', 'enterprise')),
  scans_used INTEGER NOT NULL DEFAULT 0,
  scans_limit INTEGER NOT NULL DEFAULT 50,

  -- White-label branding
  brand_name TEXT NOT NULL DEFAULT 'AI Visibility Scanner',
  logo_url TEXT,
  accent_color TEXT NOT NULL DEFAULT '#6366f1',
  cta_text TEXT NOT NULL DEFAULT 'Get This Fixed',
  powered_by TEXT NOT NULL DEFAULT 'Powered by Ethereal Media',

  -- Lead routing
  lead_webhook_url TEXT,

  -- Service tier pricing overrides (JSON)
  pricing_overrides JSONB,

  -- Status
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for slug lookups (primary auth path)
CREATE INDEX IF NOT EXISTS idx_agencies_slug ON agencies(slug) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_agencies_api_key ON agencies(api_key) WHERE active = true;

-- 2. Scan events table (usage metering + analytics)
CREATE TABLE IF NOT EXISTS scan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID REFERENCES agencies(id),
  url TEXT NOT NULL,
  pages_scanned INTEGER NOT NULL DEFAULT 1,
  scan_duration_ms INTEGER,
  ai_visibility_score NUMERIC(5,1),
  marketing_health_score NUMERIC(5,1),
  combined_score NUMERIC(5,1),
  grade TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_events_agency ON scan_events(agency_id, created_at DESC);

-- 3. Add agency_id to existing leads table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'agency_id'
  ) THEN
    ALTER TABLE leads ADD COLUMN agency_id UUID REFERENCES agencies(id);
    CREATE INDEX idx_leads_agency ON leads(agency_id);
  END IF;
END $$;

-- 4. Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agencies_updated_at ON agencies;
CREATE TRIGGER agencies_updated_at
  BEFORE UPDATE ON agencies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5. Row Level Security
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (server-side only)
CREATE POLICY "service_all_agencies" ON agencies FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "service_all_scan_events" ON scan_events FOR ALL
  USING (auth.role() = 'service_role');

-- 6. RPC for atomic scan increment (called from agency.js metering)
CREATE OR REPLACE FUNCTION increment_agency_scans(agency_uuid UUID)
RETURNS void AS $$
BEGIN
  UPDATE agencies SET scans_used = scans_used + 1 WHERE id = agency_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Seed Ethereal Media as default agency (slug: ethereal)
INSERT INTO agencies (name, slug, tier, scans_limit, brand_name, accent_color, powered_by)
VALUES (
  'Ethereal Media',
  'ethereal',
  'enterprise',
  999999,
  'AI Visibility Scanner',
  '#6366f1',
  'Powered by <strong>Ethereal Media</strong> — The Ethereal Forge'
)
ON CONFLICT (slug) DO NOTHING;
