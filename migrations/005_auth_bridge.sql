-- Auth Bridge: Link Supabase Auth users to agencies + client scans
-- Enables dashboard to look up API key after Supabase Auth login

-- 1. Add auth_user_id to agencies (links Supabase Auth → agency record)
ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;

CREATE INDEX IF NOT EXISTS idx_agencies_auth_user
  ON agencies(auth_user_id) WHERE auth_user_id IS NOT NULL;

-- 2. Add email to scans for client lookup (links lead email → their scans)
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS lead_email TEXT;

CREATE INDEX IF NOT EXISTS idx_scans_lead_email
  ON scans(lead_email) WHERE lead_email IS NOT NULL;

-- 3. RPC: Look up agency by Supabase Auth user ID
CREATE OR REPLACE FUNCTION get_agency_by_auth_user(p_auth_user_id UUID)
RETURNS TABLE(agency_id UUID, api_key TEXT, name TEXT, slug TEXT, tier TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT a.id, a.api_key, a.name, a.slug, a.tier
  FROM agencies a
  WHERE a.auth_user_id = p_auth_user_id AND a.active = true
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC: Look up scans by lead email (for client portal)
CREATE OR REPLACE FUNCTION get_scans_by_email(p_email TEXT)
RETURNS TABLE(
  scan_id UUID, url TEXT, tier TEXT, status TEXT,
  grade TEXT, scores JSONB, created_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.url, s.tier, s.status, s.grade, s.scores, s.created_at, s.completed_at
  FROM scans s
  JOIN leads l ON l.email = p_email AND s.lead_email = p_email
  WHERE s.status = 'complete'
  ORDER BY s.created_at DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Link Erik's auth user to the Ethereal agency
-- Run this manually after finding Erik's auth user ID:
-- UPDATE agencies SET auth_user_id = '<erik-auth-uuid>' WHERE slug = 'ethereal';
