-- Auto-link Supabase Auth users to agencies by matching billing_email
-- Runs as a trigger on agencies table: when billing_email is set but auth_user_id is null,
-- look up the auth user and link them automatically.

CREATE OR REPLACE FUNCTION link_agency_auth_user()
RETURNS TRIGGER AS $$
DECLARE
  found_user_id UUID;
BEGIN
  -- Only run if billing_email is set and auth_user_id is null
  IF NEW.billing_email IS NOT NULL AND NEW.auth_user_id IS NULL THEN
    SELECT id INTO found_user_id
    FROM auth.users
    WHERE email = NEW.billing_email
    LIMIT 1;

    IF found_user_id IS NOT NULL THEN
      NEW.auth_user_id := found_user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_link_agency_auth ON agencies;
CREATE TRIGGER trg_link_agency_auth
  BEFORE INSERT OR UPDATE OF billing_email ON agencies
  FOR EACH ROW EXECUTE FUNCTION link_agency_auth_user();
