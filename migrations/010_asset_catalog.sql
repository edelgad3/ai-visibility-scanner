-- Asset Catalog: persistent, editable, versioned component inventory with agentic annotations
-- Depends on: 001_agency_tables.sql (agencies, update_updated_at function)
-- Depends on: agency_clients table, scans table

-- ═══════════════════════════════════════════════════════════════════════
-- 1. asset_catalog
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS asset_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES agency_clients(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('protocol','schema','semantic_html','form','media','seo','tracking','accessibility','digital_asset','js_rendering')),
  sub_type TEXT,
  page_url TEXT,
  page_type TEXT CHECK (page_type IN ('homepage', 'subpage')),
  dom_selector TEXT,
  line_number INTEGER,
  component_type TEXT,
  content_summary TEXT,
  raw_value JSONB DEFAULT '{}',
  dimensions JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected','reviewed','enhanced','archived')),
  exists_on_site BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_catalog_client ON asset_catalog(client_id, category) WHERE status != 'archived';
CREATE INDEX IF NOT EXISTS idx_asset_catalog_agency ON asset_catalog(agency_id, client_id);
CREATE INDEX IF NOT EXISTS idx_asset_catalog_scan ON asset_catalog(scan_id);
CREATE INDEX IF NOT EXISTS idx_asset_catalog_page ON asset_catalog(client_id, page_url);

DROP TRIGGER IF EXISTS asset_catalog_updated_at ON asset_catalog;
CREATE TRIGGER asset_catalog_updated_at
  BEFORE UPDATE ON asset_catalog
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. asset_annotations
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS asset_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES asset_catalog(id) ON DELETE CASCADE,
  annotation_type TEXT NOT NULL
    CHECK (annotation_type IN ('aria','schema_org','webmcp','a2ui','llms_txt','semantic_html','agent_card','ag_ui','acp','anp')),
  current_value JSONB NOT NULL DEFAULT '{}',
  recommended_value JSONB DEFAULT NULL,
  override_value JSONB DEFAULT NULL,
  override_by TEXT DEFAULT NULL,
  override_at TIMESTAMPTZ DEFAULT NULL,
  completeness_score INTEGER DEFAULT 0
    CHECK (completeness_score >= 0 AND completeness_score <= 100),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(asset_id, annotation_type)
);

CREATE INDEX IF NOT EXISTS idx_asset_annotations_asset ON asset_annotations(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_annotations_type ON asset_annotations(annotation_type, asset_id);

DROP TRIGGER IF EXISTS asset_annotations_updated_at ON asset_annotations;
CREATE TRIGGER asset_annotations_updated_at
  BEFORE UPDATE ON asset_annotations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. asset_annotation_history
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS asset_annotation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id UUID NOT NULL REFERENCES asset_annotations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES asset_catalog(id) ON DELETE CASCADE,
  annotation_type TEXT NOT NULL,
  previous_value JSONB NOT NULL,
  new_value JSONB NOT NULL,
  change_source TEXT NOT NULL DEFAULT 'scan'
    CHECK (change_source IN ('scan','agency_edit','forge_build','system')),
  changed_by TEXT,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_annotation_history_annotation ON asset_annotation_history(annotation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotation_history_asset ON asset_annotation_history(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotation_history_scan ON asset_annotation_history(scan_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. asset_custom_annotations
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS asset_custom_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES asset_catalog(id) ON DELETE CASCADE,
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_text TEXT,
  value_json JSONB,
  value_type TEXT NOT NULL DEFAULT 'text'
    CHECK (value_type IN ('text','json','markdown','url','number','boolean')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(asset_id, agency_id, key)
);

CREATE INDEX IF NOT EXISTS idx_custom_annotations_asset ON asset_custom_annotations(asset_id);
CREATE INDEX IF NOT EXISTS idx_custom_annotations_agency ON asset_custom_annotations(agency_id, asset_id);

DROP TRIGGER IF EXISTS asset_custom_annotations_updated_at ON asset_custom_annotations;
CREATE TRIGGER asset_custom_annotations_updated_at
  BEFORE UPDATE ON asset_custom_annotations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 5. RLS Policies
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE asset_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_asset_catalog" ON asset_catalog FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "deny_anon_asset_catalog" ON asset_catalog FOR ALL
  TO anon, authenticated USING (false);

ALTER TABLE asset_annotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_asset_annotations" ON asset_annotations FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "deny_anon_asset_annotations" ON asset_annotations FOR ALL
  TO anon, authenticated USING (false);

ALTER TABLE asset_annotation_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_asset_annotation_history" ON asset_annotation_history FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "deny_anon_asset_annotation_history" ON asset_annotation_history FOR ALL
  TO anon, authenticated USING (false);

ALTER TABLE asset_custom_annotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_asset_custom_annotations" ON asset_custom_annotations FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY "deny_anon_asset_custom_annotations" ON asset_custom_annotations FOR ALL
  TO anon, authenticated USING (false);
