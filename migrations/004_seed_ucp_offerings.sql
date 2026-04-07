-- Seed Ethereal Media's UCP offerings
-- Run after 003_ucp_tables.sql

DO $$
DECLARE
  v_agency_id UUID;
BEGIN
  SELECT id INTO v_agency_id FROM agencies WHERE slug = 'ethereal' LIMIT 1;
  IF v_agency_id IS NULL THEN
    RAISE EXCEPTION 'Ethereal agency not found — run 001 first';
  END IF;

  -- ══════════════════════════════════════
  -- SCAN PRODUCTS
  -- ══════════════════════════════════════

  INSERT INTO ucp_offerings (agency_id, name, slug, description, category, price_amount, price_currency, price_type, fulfillment_type, requires_auth, lead_time_hours, sort_order, metadata)
  VALUES
    (v_agency_id, 'Visibility Scan', 'visibility-scan',
     'Free AI visibility scan — GEO score, grade, critical findings. Covers robots.txt, llms.txt, Schema.org, sitemap, and AI crawler access.',
     'scan', 4900, 'USD', 'fixed', 'digital', false, 1, 10,
     '{"tier": "visibility", "free_tier_available": true, "pages_scanned": 5}'::jsonb),

    (v_agency_id, 'Forge Scan', 'forge-scan',
     'Full AI readiness scan — GEO + Protocol + Marketing Health. Includes agent-card.json, UCP manifest analysis, competitive benchmarking, and revenue impact estimates.',
     'scan', 29900, 'USD', 'fixed', 'digital', true, 1, 20,
     '{"tier": "forge", "pages_scanned": 10, "includes_report": true}'::jsonb),

    (v_agency_id, 'Full Diagnostic', 'full-diagnostic',
     'Enterprise diagnostic — GEO + Protocol + WebMCP + Marketing Health. Complete 14-page report with evidence screenshots, ROI math, protocol glossary, and implementation roadmap.',
     'scan', 49900, 'USD', 'fixed', 'digital', true, 2, 30,
     '{"tier": "diagnostic", "pages_scanned": 20, "includes_report": true, "includes_roadmap": true}'::jsonb),

  -- ══════════════════════════════════════
  -- BUILD PRODUCTS
  -- ══════════════════════════════════════

    (v_agency_id, 'GEO Build', 'geo-build',
     'AI visibility retrofit — GEO layer only. Generates and deploys llms.txt, robots.txt, sitemap.xml, Schema.org JSON-LD, and AI crawler configuration.',
     'build', 99900, 'USD', 'fixed', 'digital', true, 24, 40,
     '{"tier": "visibility", "artifacts": ["llms.txt", "robots.txt", "sitemap.xml", "schema.jsonld"], "deploy_methods": ["edge", "pr", "plugin"]}'::jsonb),

    (v_agency_id, 'Forge Build', 'forge-build',
     'Full protocol retrofit — GEO + Protocol layers. Everything in GEO Build plus agent-card.json, UCP manifest, AP2 OAuth scaffold, and llms-full.txt.',
     'build', 249900, 'USD', 'fixed', 'manual', true, 72, 50,
     '{"tier": "forge", "artifacts": ["llms.txt", "llms-full.txt", "robots.txt", "sitemap.xml", "schema.jsonld", "agent-card.json", "ucp-manifest.json", "ap2-config"], "deploy_methods": ["edge", "pr", "plugin"]}'::jsonb),

    (v_agency_id, 'Agent Access Build', 'agent-access-build',
     'Complete AI transformation — GEO + Protocol + WebMCP. Makes your business fully agent-purchasable. Includes all Forge Build artifacts plus WebMCP forms, tool registration, and meta tags.',
     'build', 499900, 'USD', 'fixed', 'manual', true, 120, 60,
     '{"tier": "agent_access", "artifacts": "all", "deploy_methods": ["edge", "pr", "plugin"], "includes_webmcp": true}'::jsonb),

  -- ══════════════════════════════════════
  -- SERVICES
  -- ══════════════════════════════════════

    (v_agency_id, 'AI Visibility Audit', 'ai-visibility-audit',
     'White-glove audit with a human strategist. Full diagnostic scan plus 1-on-1 walkthrough, prioritized implementation plan, and 30-day follow-up.',
     'service', 150000, 'USD', 'fixed', 'manual', true, 168, 70,
     '{"includes_diagnostic": true, "includes_consultation": true, "followup_days": 30}'::jsonb),

    (v_agency_id, 'Managed Retainer — Starter', 'managed-retainer-starter',
     'Monthly managed AI visibility. Ongoing monitoring, monthly re-scans, protocol updates, and priority support.',
     'service', 29900, 'USD', 'monthly', 'manual', true, NULL, 80,
     '{"billing_cycle": "monthly", "rescans_per_month": 4, "support_tier": "priority"}'::jsonb),

    (v_agency_id, 'Managed Retainer — Growth', 'managed-retainer-growth',
     'Growth-tier managed service. Everything in Starter plus content optimization, competitive tracking, and quarterly strategy reviews.',
     'service', 59900, 'USD', 'monthly', 'manual', true, NULL, 85,
     '{"billing_cycle": "monthly", "rescans_per_month": 12, "support_tier": "dedicated", "includes_content_optimization": true}'::jsonb),

    (v_agency_id, 'Managed Retainer — Enterprise', 'managed-retainer-enterprise',
     'Enterprise managed service. Full AI visibility management, weekly optimization cycles, dedicated strategist, and SLA guarantees.',
     'service', 99900, 'USD', 'monthly', 'manual', true, NULL, 90,
     '{"billing_cycle": "monthly", "rescans_per_month": 30, "support_tier": "dedicated_strategist", "sla": true}'::jsonb)

  ON CONFLICT (agency_id, slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price_amount = EXCLUDED.price_amount,
    price_type = EXCLUDED.price_type,
    fulfillment_type = EXCLUDED.fulfillment_type,
    lead_time_hours = EXCLUDED.lead_time_hours,
    metadata = EXCLUDED.metadata,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();
END $$;
