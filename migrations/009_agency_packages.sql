-- Agency Packages: custom bundles agencies sell to their clients
-- Each package is a named combination of offerings with a custom total price

CREATE TABLE IF NOT EXISTS agency_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,

  -- Bundle contents: array of offering references with quantities
  -- [{offering_id, quantity, label}]
  items JSONB NOT NULL DEFAULT '[]',

  -- Pricing
  price_cents INTEGER NOT NULL,           -- what the agency charges their client
  base_cost_cents INTEGER DEFAULT 0,      -- sum of component costs (for margin calc)
  price_type TEXT NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed', 'monthly', 'quote')),
  currency TEXT NOT NULL DEFAULT 'usd',

  -- Stripe
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_payment_link TEXT,

  -- Display
  badge_text TEXT,                         -- e.g. "Most Popular", "Best Value"
  features JSONB DEFAULT '[]',             -- bullet points for the package card

  -- State
  active BOOLEAN NOT NULL DEFAULT true,
  published BOOLEAN NOT NULL DEFAULT false, -- visible to clients when published
  sort_order INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (agency_id, slug)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agency_packages_agency ON agency_packages(agency_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_agency_packages_published ON agency_packages(agency_id) WHERE published = true AND active = true;

-- RLS
ALTER TABLE agency_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY agency_packages_agency_access ON agency_packages
  FOR ALL USING (agency_id = current_setting('app.agency_id', true)::uuid);
