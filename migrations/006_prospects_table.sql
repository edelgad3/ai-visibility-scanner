-- Prospects table for outreach campaigns
-- Populated by execution/prospect_scanner.py, consumed by execution/outreach_campaign.py

CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Prospect info
  website_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  contact_email TEXT,
  company_name TEXT,
  industry TEXT,

  -- Scan results
  score INTEGER,
  grade TEXT,
  qualified BOOLEAN NOT NULL DEFAULT false,
  top_issues JSONB DEFAULT '[]',

  -- Campaign tracking
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'responded', 'converted', 'unsubscribed', 'bounced')),
  source TEXT NOT NULL DEFAULT 'batch_scan',
  contacted_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,

  -- Metadata
  notes TEXT,
  scanned_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(website_url)
);

CREATE INDEX IF NOT EXISTS idx_prospects_qualified ON prospects(qualified, status);
CREATE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain);

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all_prospects" ON prospects FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "deny_anon_prospects" ON prospects FOR ALL
  TO anon, authenticated USING (false);

DROP TRIGGER IF EXISTS prospects_updated_at ON prospects;
CREATE TRIGGER prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
