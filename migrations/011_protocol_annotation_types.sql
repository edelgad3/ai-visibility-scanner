-- Add AG-UI, ACP, ANP annotation types to asset_annotations CHECK constraint
-- Depends on: 010_asset_catalog.sql (asset_annotations table)

-- Drop the existing constraint and re-create with expanded enum
ALTER TABLE asset_annotations
  DROP CONSTRAINT IF EXISTS asset_annotations_annotation_type_check;

ALTER TABLE asset_annotations
  ADD CONSTRAINT asset_annotations_annotation_type_check
  CHECK (annotation_type IN (
    'aria', 'schema_org', 'webmcp', 'a2ui',
    'llms_txt', 'semantic_html', 'agent_card',
    'ag_ui', 'acp', 'anp'
  ));
