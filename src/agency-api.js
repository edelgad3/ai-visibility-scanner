// Agency REST API — self-service endpoints for agency partners
// Auth: X-API-Key header (same key used for MCP endpoint)
// Mounts at /api/v1/agency/* on the Express app

const { Router } = require("express");
const crypto = require("crypto");
const { z } = require("zod");

// ── Zod schemas ──
const CreateClientSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  website_url: z.string().url().optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  contact_email: z.string().email().optional().nullable(),
  industry: z.string().max(100).optional(),
  notes: z.string().max(5000).optional().nullable(),
});

const UpdateClientSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  website_url: z.string().url().optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  contact_email: z.string().email().optional().nullable(),
  industry: z.string().max(100).optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.enum(["active", "archived", "paused"]).optional(),
});

const ClientScanSchema = z.object({
  url: z.string().url().optional(),
  tier: z.enum(["visibility", "forge", "diagnostic"]).default("visibility"),
  max_pages: z.number().int().min(1).max(50).optional(),
  industry: z.string().max(100).optional(),
});

const CreateApiKeySchema = z.object({
  name: z.string().max(200).default("API Key"),
  permissions: z.array(z.string().max(50)).default(["scan", "read"]),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

const UpdateBrandingSchema = z.object({
  brand_name: z.string().max(200).optional(),
  logo_url: z.string().url().optional(),
  accent_color: z.string().max(20).optional(),
  cta_text: z.string().max(200).optional(),
  powered_by: z.string().max(200).optional(),
  lead_webhook_url: z.string().url().optional(),
});

const UpgradeTierSchema = z.object({
  tier: z.enum(["starter", "pro", "enterprise"], { errorMap: () => ({ message: "Invalid tier. Choose: starter, pro, enterprise" }) }),
});

const CatalogItemRef = z.object({
  catalog_id: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  label: z.string().max(200).optional(),
});

const CreatePackageSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  description: z.string().max(2000).optional().nullable(),
  items: z.array(CatalogItemRef).min(1, "items[] must contain at least one item"),
  price_cents: z.number().int().min(0, "price_cents must be a positive number"),
  price_type: z.enum(["fixed", "monthly"]).default("fixed"),
  badge_text: z.string().max(100).optional().nullable(),
  features: z.array(z.string().max(500)).optional(),
});

const UpdatePackageSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  items: z.array(CatalogItemRef).min(1).optional(),
  price_cents: z.number().int().min(0).optional(),
  price_type: z.enum(["fixed", "monthly"]).optional(),
  badge_text: z.string().max(100).optional().nullable(),
  features: z.array(z.string().max(500)).optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Supabase helpers ──

async function sbQuery(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (options.method === "PATCH" || options.method === "DELETE") {
    if (!resp.ok) throw new Error(await resp.text());
    return null;
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sbInsert(table, data) {
  return sbQuery(table, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
}

async function sbUpdate(table, filter, data) {
  return sbQuery(`${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
}

// ── Auth middleware: validate API key, attach agency to req ──

function agencyApiAuth() {
  return async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "X-API-Key header required" });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      const rows = await sbQuery(
        `agencies?api_key=eq.${encodeURIComponent(apiKey)}&active=eq.true&select=*&limit=1`
      );
      if (!rows?.[0]) {
        return res.status(401).json({ error: "Invalid API key" });
      }
      req.agency = rows[0];
      next();
    } catch (e) {
      return res.status(500).json({ error: "Auth lookup failed" });
    }
  };
}

// ── Agency tier permissions ──

const TIER_FEATURES = {
  starter: { api_access: false, max_clients: 10, max_api_keys: 1, team_seats: 1 },
  pro:     { api_access: true,  max_clients: 100, max_api_keys: 5, team_seats: 5 },
  enterprise: { api_access: true, max_clients: 9999, max_api_keys: 20, team_seats: 99 },
  // Legacy tiers from billing.js
  growth:  { api_access: true,  max_clients: 50, max_api_keys: 3, team_seats: 3 },
};

function requireTier(minTier) {
  const tierOrder = ["starter", "growth", "pro", "enterprise"];
  return (req, res, next) => {
    const agencyTier = req.agency?.tier || "starter";
    const agencyIdx = tierOrder.indexOf(agencyTier);
    const requiredIdx = tierOrder.indexOf(minTier);
    if (agencyIdx < requiredIdx) {
      return res.status(403).json({
        error: `This feature requires ${minTier} tier or higher`,
        current_tier: agencyTier,
        upgrade_url: "/api/billing/plans",
      });
    }
    next();
  };
}

// ── Create router ──

function createAgencyApiRouter() {
  const router = Router();
  const auth = agencyApiAuth();

  // ────────────────────────────────────────────────────────
  // GET /api/v1/agency/me — Current agency profile
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/agency/me", auth, async (req, res) => {
    const a = req.agency;
    const features = TIER_FEATURES[a.tier] || TIER_FEATURES.starter;

    res.json({
      id: a.id,
      name: a.name,
      slug: a.slug,
      tier: a.tier,
      billing_email: a.billing_email,
      branding: {
        brand_name: a.brand_name,
        logo_url: a.logo_url,
        accent_color: a.accent_color,
        cta_text: a.cta_text,
        powered_by: a.powered_by,
      },
      usage: {
        scans_used: a.scans_used,
        scans_limit: a.scans_limit,
        usage_pct: Math.round((a.scans_used / a.scans_limit) * 100),
      },
      subscription: {
        status: a.subscription_status || "active",
        current_period_end: a.current_period_end,
        cancel_at_period_end: a.cancel_at_period_end || false,
      },
      features,
      mcp_endpoint: `/a/${a.slug}/mcp`,
      created_at: a.created_at,
    });
  });

  // ────────────────────────────────────────────────────────
  // GET /api/v1/agency/usage — Detailed usage stats
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/agency/usage", auth, async (req, res) => {
    const a = req.agency;

    try {
      // Recent scan events
      const events = await sbQuery(
        `scan_events?agency_id=eq.${a.id}&select=url,combined_score,grade,created_at&order=created_at.desc&limit=20`
      );

      // Client count
      const clients = await sbQuery(
        `agency_clients?agency_id=eq.${a.id}&status=eq.active&select=id`
      );

      // Scans from the scans table for this agency
      const scans = await sbQuery(
        `scans?agency_id=eq.${a.id}&status=eq.complete&select=id,grade&order=created_at.desc&limit=100`
      );

      // Grade distribution
      const gradeDistribution = {};
      for (const s of scans || []) {
        gradeDistribution[s.grade] = (gradeDistribution[s.grade] || 0) + 1;
      }

      res.json({
        period: {
          scans_used: a.scans_used,
          scans_limit: a.scans_limit,
          usage_pct: Math.round((a.scans_used / a.scans_limit) * 100),
          resets_at: a.current_period_end,
        },
        totals: {
          clients: clients?.length || 0,
          scans_all_time: (events || []).length,
        },
        grade_distribution: gradeDistribution,
        recent_scans: (events || []).slice(0, 10),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // CLIENTS CRUD
  // ────────────────────────────────────────────────────────

  // GET /api/v1/agency/clients — List all clients
  router.get("/api/v1/agency/clients", auth, async (req, res) => {
    const a = req.agency;
    const status = req.query.status || "active";
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    try {
      const clients = await sbQuery(
        `agency_clients?agency_id=eq.${a.id}&status=eq.${encodeURIComponent(status)}&select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
        { headers: { Prefer: "count=exact" } }
      );

      res.json({
        clients: clients || [],
        count: clients?.length || 0,
        limit,
        offset,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/clients — Create a client
  router.post("/api/v1/agency/clients", auth, async (req, res) => {
    const a = req.agency;
    const parsed = CreateClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { name, website_url, contact_name, contact_email, industry, notes } = parsed.data;

    // Check client limit
    const features = TIER_FEATURES[a.tier] || TIER_FEATURES.starter;
    try {
      const existing = await sbQuery(
        `agency_clients?agency_id=eq.${a.id}&status=eq.active&select=id`
      );
      if ((existing?.length || 0) >= features.max_clients) {
        return res.status(403).json({
          error: `Client limit reached (${features.max_clients} for ${a.tier} tier)`,
          upgrade_url: "/api/billing/plans",
        });
      }
    } catch {}

    try {
      const result = await sbInsert("agency_clients", {
        agency_id: a.id,
        name,
        website_url: website_url || null,
        contact_name: contact_name || null,
        contact_email: contact_email || null,
        industry: industry || "general",
        notes: notes || null,
      });

      const client = Array.isArray(result) ? result[0] : result;
      res.status(201).json(client);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/agency/clients/:id — Get a client
  router.get("/api/v1/agency/clients/:id", auth, async (req, res) => {
    const a = req.agency;
    try {
      const rows = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=*&limit=1`
      );
      if (!rows?.[0]) return res.status(404).json({ error: "Client not found" });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/v1/agency/clients/:id — Update a client
  router.put("/api/v1/agency/clients/:id", auth, async (req, res) => {
    const a = req.agency;
    const parsed = UpdateClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const updates = { updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) updates[key] = value;
    }

    try {
      await sbUpdate(
        "agency_clients",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        updates
      );
      // Fetch updated record
      const rows = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=*&limit=1`
      );
      res.json(rows?.[0] || { updated: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/v1/agency/clients/:id — Archive a client (soft delete)
  router.delete("/api/v1/agency/clients/:id", auth, async (req, res) => {
    const a = req.agency;
    try {
      await sbUpdate(
        "agency_clients",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        { status: "archived", updated_at: new Date().toISOString() }
      );
      res.json({ archived: true, id: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // SCAN HISTORY
  // ────────────────────────────────────────────────────────

  // GET /api/v1/agency/scans — All scans for this agency
  router.get("/api/v1/agency/scans", auth, async (req, res) => {
    const a = req.agency;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const clientId = req.query.client_id;

    try {
      let filter = `agency_id=eq.${a.id}`;
      if (clientId) filter += `&agency_client_id=eq.${encodeURIComponent(clientId)}`;

      const scans = await sbQuery(
        `scans?${filter}&select=id,url,tier,status,grade,scores,scan_duration_ms,pages_scanned,agency_client_id,created_at,completed_at&order=created_at.desc&limit=${limit}&offset=${offset}`
      );

      res.json({
        scans: scans || [],
        count: scans?.length || 0,
        limit,
        offset,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/agency/clients/:id/scans — Scans for a specific client
  router.get("/api/v1/agency/clients/:id/scans", auth, async (req, res) => {
    const a = req.agency;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    try {
      // Verify client belongs to this agency
      const client = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=id,name&limit=1`
      );
      if (!client?.[0]) return res.status(404).json({ error: "Client not found" });

      const scans = await sbQuery(
        `scans?agency_client_id=eq.${encodeURIComponent(req.params.id)}&select=id,url,tier,status,grade,scores,scan_duration_ms,pages_scanned,created_at,completed_at&order=created_at.desc&limit=${limit}`
      );

      res.json({
        client: client[0],
        scans: scans || [],
        count: scans?.length || 0,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/agency/clients/:id/inventory — Site asset inventory from latest scan
  router.get("/api/v1/agency/clients/:id/inventory", auth, async (req, res) => {
    const a = req.agency;

    try {
      // Verify client belongs to this agency
      const client = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=id,name,website_url&limit=1`
      );
      if (!client?.[0]) return res.status(404).json({ error: "Client not found" });
      const c = client[0];

      // Get latest complete scan with full results
      const scans = await sbQuery(
        `scans?agency_client_id=eq.${encodeURIComponent(req.params.id)}&status=eq.complete&select=id,url,results,scores,grade,created_at&order=created_at.desc&limit=1`
      );
      if (!scans?.[0] || !scans[0].results) {
        return res.status(404).json({
          error: "No completed scan found for this client",
          hint: "Run a scan first via POST /api/v1/agency/clients/:id/scan",
        });
      }

      const scan = scans[0];
      const results = typeof scan.results === "string" ? JSON.parse(scan.results) : scan.results;
      const inventory = buildInventory(results, c, scan);

      res.json(inventory);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/clients/:id/scan — Submit a scan for a client
  router.post("/api/v1/agency/clients/:id/scan", auth, async (req, res) => {
    const a = req.agency;
    const parsed = ClientScanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { tier, max_pages, industry } = parsed.data;

    try {
      // Verify client belongs to this agency
      const client = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=id,name,website_url,industry&limit=1`
      );
      if (!client?.[0]) return res.status(404).json({ error: "Client not found" });
      const c = client[0];

      const url = parsed.data.url || c.website_url;
      if (!url) {
        return res.status(400).json({ error: "url required (or set website_url on client)" });
      }

      // Check scan limit
      if (a.scans_used >= a.scans_limit) {
        return res.status(429).json({
          error: "Monthly scan limit reached",
          scans_used: a.scans_used,
          scans_limit: a.scans_limit,
          upgrade_url: "/api/billing/plans",
        });
      }

      // Forward to the scan API with agency context
      // Build internal scan request
      const scanPayload = {
        url,
        tier,
        max_pages,
        industry: industry || c.industry || "general",
        agency_id: a.id,
        agency_client_id: c.id,
      };

      // Call the scan endpoint internally via redirect to POST /api/v1/scan
      // Instead, we'll call performScan directly via the injected function
      if (req._performScan && req._validateScanUrl) {
        try {
          await req._validateScanUrl(url);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }

        const scanId = crypto.randomUUID();
        const scanRecord = {
          id: scanId,
          url,
          tier,
          status: "queued",
          agency_id: a.id,
          agency_client_id: c.id,
          max_pages: max_pages || 5,
          industry: scanPayload.industry,
          paid: true, // agency subscription covers it
          amount_cents: 0,
          ip_address: req.ip,
          created_at: new Date().toISOString(),
        };

        // Persist
        if (SUPABASE_URL && SUPABASE_KEY) {
          try { await sbInsert("scans", scanRecord); } catch {}
        }

        res.status(202).json({
          scan_id: scanId,
          client_id: c.id,
          client_name: c.name,
          url,
          tier,
          status: "queued",
          poll_url: `/api/v1/scan/${scanId}`,
        });

        // Run async
        runAgencyScan(scanId, scanRecord, req._performScan, a);
      } else {
        // Fallback: tell them to use the scan API directly
        res.status(501).json({
          error: "Direct scan not available. Use POST /api/v1/scan with agency_client_id",
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // API KEY MANAGEMENT (Pro+ only)
  // ────────────────────────────────────────────────────────

  // GET /api/v1/agency/api-keys — List API keys
  router.get("/api/v1/agency/api-keys", auth, requireTier("pro"), async (req, res) => {
    const a = req.agency;
    try {
      const keys = await sbQuery(
        `agency_api_keys?agency_id=eq.${a.id}&active=eq.true&select=id,key_prefix,name,permissions,last_used_at,expires_at,created_at&order=created_at.desc`
      );
      res.json({ api_keys: keys || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/api-keys — Generate a new API key
  router.post("/api/v1/agency/api-keys", auth, requireTier("pro"), async (req, res) => {
    const a = req.agency;
    const parsed = CreateApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { name, permissions, expires_in_days } = parsed.data;

    // Check key limit
    const features = TIER_FEATURES[a.tier] || TIER_FEATURES.starter;
    try {
      const existing = await sbQuery(
        `agency_api_keys?agency_id=eq.${a.id}&active=eq.true&select=id`
      );
      if ((existing?.length || 0) >= features.max_api_keys) {
        return res.status(403).json({
          error: `API key limit reached (${features.max_api_keys} for ${a.tier} tier)`,
        });
      }
    } catch {}

    // Generate key
    const rawKey = `efk_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 12);

    let expiresAt = null;
    if (expires_in_days) {
      expiresAt = new Date(Date.now() + expires_in_days * 86400000).toISOString();
    }

    try {
      const result = await sbInsert("agency_api_keys", {
        agency_id: a.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name,
        permissions,
        expires_at: expiresAt,
      });

      const record = Array.isArray(result) ? result[0] : result;

      res.status(201).json({
        id: record.id,
        key: rawKey, // Only shown once — client must save it
        key_prefix: keyPrefix,
        name,
        permissions,
        expires_at: expiresAt,
        warning: "Save this key now. It will not be shown again.",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/v1/agency/api-keys/:id — Revoke a key
  router.delete("/api/v1/agency/api-keys/:id", auth, requireTier("pro"), async (req, res) => {
    const a = req.agency;
    try {
      await sbUpdate(
        "agency_api_keys",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        { active: false }
      );
      res.json({ revoked: true, id: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // BRANDING (convenience — same as existing PATCH endpoint)
  // ────────────────────────────────────────────────────────

  router.put("/api/v1/agency/branding", auth, async (req, res) => {
    const a = req.agency;
    const parsed = UpdateBrandingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const updates = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) updates[key] = value;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields", allowed: Object.keys(UpdateBrandingSchema.shape) });
    }

    try {
      await sbUpdate("agencies", `id=eq.${a.id}`, updates);
      res.json({ updated: Object.keys(updates), slug: a.slug });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // BILLING (convenience wrappers)
  // ────────────────────────────────────────────────────────

  // GET /api/v1/agency/billing — Current subscription + MRR details
  router.get("/api/v1/agency/billing", auth, async (req, res) => {
    const a = req.agency;

    // Calculate overage
    const overageScans = Math.max(0, a.scans_used - a.scans_limit);
    const OVERAGE_RATES = { starter: 500, growth: 400, pro: 300, enterprise: 0 }; // cents per scan
    const overageRate = OVERAGE_RATES[a.tier] || 500;
    const overageCharges = overageScans * overageRate;

    res.json({
      tier: a.tier,
      status: a.subscription_status || "active",
      billing_email: a.billing_email,
      current_period_end: a.current_period_end,
      cancel_at_period_end: a.cancel_at_period_end || false,
      stripe_customer_id: a.stripe_customer_id ? "linked" : null,
      usage: {
        scans_used: a.scans_used,
        scans_limit: a.scans_limit,
        overage_scans: overageScans,
        overage_rate_cents: overageRate,
        overage_charges_cents: overageCharges,
      },
      portal_url: "/api/billing/portal",
      plans_url: "/api/billing/plans",
    });
  });

  // GET /api/v1/agency/billing/invoices — Invoice history from Stripe
  router.get("/api/v1/agency/billing/invoices", auth, async (req, res) => {
    const a = req.agency;
    if (!a.stripe_customer_id) {
      return res.status(400).json({ error: "No Stripe billing account linked" });
    }

    try {
      const Stripe = require("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      const invoices = await stripe.invoices.list({
        customer: a.stripe_customer_id,
        limit: parseInt(req.query.limit) || 12,
      });

      res.json({
        invoices: invoices.data.map(inv => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amount_due: inv.amount_due,
          amount_paid: inv.amount_paid,
          currency: inv.currency,
          period_start: new Date(inv.period_start * 1000).toISOString(),
          period_end: new Date(inv.period_end * 1000).toISOString(),
          paid_at: inv.status_transitions?.paid_at
            ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
            : null,
          hosted_invoice_url: inv.hosted_invoice_url,
          invoice_pdf: inv.invoice_pdf,
        })),
        has_more: invoices.has_more,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/billing/upgrade — Upgrade subscription tier
  router.post("/api/v1/agency/billing/upgrade", auth, async (req, res) => {
    const a = req.agency;
    const parsed = UpgradeTierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { tier } = parsed.data;

    const tierOrder = ["starter", "pro", "enterprise"];
    if (tierOrder.indexOf(tier) <= tierOrder.indexOf(a.tier)) {
      return res.status(400).json({
        error: "Can only upgrade to a higher tier. Use Stripe portal for downgrades.",
        current: a.tier,
        requested: tier,
        portal_url: "/api/billing/portal",
      });
    }

    if (!a.stripe_customer_id || !a.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription to upgrade" });
    }

    try {
      const Stripe = require("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      // Find the price for the new tier
      const products = await stripe.products.search({
        query: 'metadata["app"]:"ai-visibility-scanner"',
      });
      if (!products.data.length) {
        return res.status(500).json({ error: "Billing products not configured" });
      }

      const prices = await stripe.prices.list({
        product: products.data[0].id,
        active: true,
      });
      const newPrice = prices.data.find(p => p.metadata.tier === tier);
      if (!newPrice) {
        return res.status(500).json({ error: `Price not found for tier: ${tier}` });
      }

      // Retrieve current subscription
      const subscription = await stripe.subscriptions.retrieve(a.stripe_subscription_id);
      const currentItem = subscription.items.data[0];

      // Update subscription (prorated)
      const updated = await stripe.subscriptions.update(a.stripe_subscription_id, {
        items: [{ id: currentItem.id, price: newPrice.id }],
        proration_behavior: "create_prorations",
      });

      res.json({
        upgraded: true,
        from: a.tier,
        to: tier,
        effective: "immediate",
        next_invoice_preview: `Prorated charge applied. Next full invoice at period end.`,
        subscription_status: updated.status,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // PACKAGE BUILDER
  // ────────────────────────────────────────────────────────

  // Available offerings that can be added to packages
  const CATALOG_ITEMS = [
    // Scans
    { id: "visibility-scan", category: "scan", name: "Visibility Scan", price_cents: 4900, description: "GEO layer — 9 components" },
    { id: "forge-scan", category: "scan", name: "Forge Scan", price_cents: 29900, description: "GEO + Executable layers — 17 components" },
    { id: "full-diagnostic", category: "scan", name: "Full Diagnostic", price_cents: 49900, description: "All 3 layers — 24 components + competitive analysis" },
    // Builds
    { id: "geo-build", category: "build", name: "GEO Build", price_cents: 99900, description: "Protocol files + schema markup + semantic HTML" },
    { id: "forge-build", category: "build", name: "Forge Build", price_cents: 249900, description: "Full executable website reconstruction" },
    { id: "agent-access", category: "build", name: "Agent Access Build", price_cents: 499900, description: "WebMCP + agent-card + UCP manifest" },
    // Services
    { id: "monthly-monitoring", category: "service", name: "Monthly Monitoring", price_cents: 14900, price_type: "monthly", description: "Ongoing scan + report delivery" },
    { id: "managed-optimization", category: "service", name: "Managed Optimization", price_cents: 49900, price_type: "monthly", description: "Active management + build updates" },
    { id: "enterprise-retainer", category: "service", name: "Enterprise Retainer", price_cents: 99900, price_type: "monthly", description: "Dedicated agent access + priority support" },
  ];

  // GET /api/v1/agency/packages/catalog — Available items for building packages
  router.get("/api/v1/agency/packages/catalog", auth, (_req, res) => {
    res.json({ items: CATALOG_ITEMS });
  });

  // GET /api/v1/agency/packages — List agency's packages
  router.get("/api/v1/agency/packages", auth, async (req, res) => {
    const a = req.agency;
    const activeOnly = req.query.active !== "false";

    try {
      let filter = `agency_id=eq.${a.id}`;
      if (activeOnly) filter += `&active=eq.true`;

      const packages = await sbQuery(
        `agency_packages?${filter}&select=*&order=sort_order.asc,created_at.desc`
      );

      res.json({ packages: packages || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/packages — Create a package
  router.post("/api/v1/agency/packages", auth, async (req, res) => {
    const a = req.agency;
    const parsed = CreatePackageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { name, description, items, price_cents, price_type, badge_text, features } = parsed.data;

    // Validate items against catalog
    const validIds = new Set(CATALOG_ITEMS.map(c => c.id));
    for (const item of items) {
      if (!item.catalog_id || !validIds.has(item.catalog_id)) {
        return res.status(400).json({ error: `Invalid catalog_id: ${item.catalog_id}`, valid_ids: [...validIds] });
      }
    }

    // Calculate base cost
    const baseCost = items.reduce((sum, item) => {
      const catalogItem = CATALOG_ITEMS.find(c => c.id === item.catalog_id);
      return sum + (catalogItem ? catalogItem.price_cents * (item.quantity || 1) : 0);
    }, 0);

    // Generate slug
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    try {
      const result = await sbInsert("agency_packages", {
        agency_id: a.id,
        name,
        slug,
        description: description || null,
        items: items.map(item => ({
          catalog_id: item.catalog_id,
          quantity: item.quantity || 1,
          label: item.label || CATALOG_ITEMS.find(c => c.id === item.catalog_id)?.name,
        })),
        price_cents,
        base_cost_cents: baseCost,
        price_type: price_type || "fixed",
        badge_text: badge_text || null,
        features: features || [],
      });

      const pkg = Array.isArray(result) ? result[0] : result;
      pkg.margin_cents = price_cents - baseCost;
      pkg.margin_pct = baseCost > 0 ? Math.round(((price_cents - baseCost) / baseCost) * 100) : 100;

      res.status(201).json(pkg);
    } catch (e) {
      if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
        return res.status(409).json({ error: `Package slug "${slug}" already exists. Choose a different name.` });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/agency/packages/:id — Get a package
  router.get("/api/v1/agency/packages/:id", auth, async (req, res) => {
    const a = req.agency;
    try {
      const rows = await sbQuery(
        `agency_packages?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=*&limit=1`
      );
      if (!rows?.[0]) return res.status(404).json({ error: "Package not found" });

      const pkg = rows[0];
      pkg.margin_cents = pkg.price_cents - pkg.base_cost_cents;
      pkg.margin_pct = pkg.base_cost_cents > 0 ? Math.round(((pkg.price_cents - pkg.base_cost_cents) / pkg.base_cost_cents) * 100) : 100;

      res.json(pkg);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/v1/agency/packages/:id — Update a package
  router.put("/api/v1/agency/packages/:id", auth, async (req, res) => {
    const a = req.agency;
    const parsed = UpdatePackageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const updates = { updated_at: new Date().toISOString() };

    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) updates[key] = value;
    }

    // Recalculate base cost if items changed
    if (updates.items && Array.isArray(updates.items)) {
      updates.base_cost_cents = updates.items.reduce((sum, item) => {
        const catalogItem = CATALOG_ITEMS.find(c => c.id === item.catalog_id);
        return sum + (catalogItem ? catalogItem.price_cents * (item.quantity || 1) : 0);
      }, 0);
    }

    // Regenerate slug if name changed
    if (updates.name) {
      updates.slug = updates.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    }

    try {
      await sbUpdate(
        "agency_packages",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        updates
      );
      const rows = await sbQuery(
        `agency_packages?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=*&limit=1`
      );
      res.json(rows?.[0] || { updated: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/v1/agency/packages/:id — Archive a package (soft delete)
  router.delete("/api/v1/agency/packages/:id", auth, async (req, res) => {
    const a = req.agency;
    try {
      await sbUpdate(
        "agency_packages",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        { active: false, published: false, updated_at: new Date().toISOString() }
      );
      res.json({ archived: true, id: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/packages/:id/publish — Create Stripe product + publish
  router.post("/api/v1/agency/packages/:id/publish", auth, async (req, res) => {
    const a = req.agency;

    try {
      const rows = await sbQuery(
        `agency_packages?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&active=eq.true&select=*&limit=1`
      );
      if (!rows?.[0]) return res.status(404).json({ error: "Package not found" });
      const pkg = rows[0];

      // Create or update Stripe product
      const Stripe = require("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      let productId = pkg.stripe_product_id;
      if (!productId) {
        const product = await stripe.products.create({
          name: `${a.brand_name || a.name} — ${pkg.name}`,
          description: pkg.description || `Custom package by ${a.name}`,
          metadata: {
            app: "ethereal-forge-package",
            agency_id: a.id,
            package_id: pkg.id,
          },
        });
        productId = product.id;
      }

      // Create price
      const priceParams = {
        product: productId,
        unit_amount: pkg.price_cents,
        currency: pkg.currency || "usd",
        metadata: { package_id: pkg.id, agency_id: a.id },
      };

      if (pkg.price_type === "monthly") {
        priceParams.recurring = { interval: "month" };
      }

      const price = await stripe.prices.create(priceParams);

      // Create payment link
      const paymentLink = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { package_id: pkg.id, agency_id: a.id },
        after_completion: {
          type: "redirect",
          redirect: { url: `${process.env.APP_BASE_URL || "https://app.etherealmedia.ai"}/portal?package=${pkg.id}` },
        },
      });

      // Update package with Stripe IDs
      await sbUpdate(
        "agency_packages",
        `id=eq.${encodeURIComponent(pkg.id)}&agency_id=eq.${a.id}`,
        {
          stripe_product_id: productId,
          stripe_price_id: price.id,
          stripe_payment_link: paymentLink.url,
          published: true,
          updated_at: new Date().toISOString(),
        }
      );

      res.json({
        published: true,
        package_id: pkg.id,
        stripe_product_id: productId,
        stripe_price_id: price.id,
        payment_link: paymentLink.url,
        message: "Package is now live. Share the payment link with clients.",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/agency/packages/:id/unpublish — Hide package
  router.post("/api/v1/agency/packages/:id/unpublish", auth, async (req, res) => {
    const a = req.agency;
    try {
      await sbUpdate(
        "agency_packages",
        `id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}`,
        { published: false, updated_at: new Date().toISOString() }
      );
      res.json({ unpublished: true, id: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ── Async scan for agency client ──

async function runAgencyScan(scanId, scanRecord, performScan, agency) {
  const startedAt = new Date().toISOString();

  if (SUPABASE_URL && SUPABASE_KEY) {
    try { await sbUpdate("scans", `id=eq.${scanId}`, { status: "running", started_at: startedAt }); } catch {}
  }

  try {
    const results = await performScan(scanRecord.url, scanRecord.max_pages, scanRecord.industry);

    const completedAt = new Date().toISOString();
    const update = {
      status: "complete",
      results,
      scores: {
        ai_visibility: results.scores.ai_visibility.overall,
        geo: results.scores.ai_visibility.geo,
        multimodal: results.scores.ai_visibility.multimodal,
        agent_ready: results.scores.ai_visibility.agent_ready,
        marketing_health: results.scores.marketing_health.overall,
        combined: results.scores.combined.overall,
      },
      grade: results.scores.combined.grade,
      scan_duration_ms: results.metadata.scan_duration_ms,
      pages_scanned: results.metadata.pages_scanned,
      completed_at: completedAt,
    };

    if (SUPABASE_URL && SUPABASE_KEY) {
      try { await sbUpdate("scans", `id=eq.${scanId}`, update); } catch {}
    }

    // Meter the scan against the agency
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_agency_scans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ agency_uuid: agency.id }),
      });
    } catch {}

    console.log(`Agency scan ${scanId} complete: ${results.scores.combined.grade} for ${agency.slug}`);
  } catch (e) {
    console.error(`Agency scan ${scanId} failed:`, e.message);
    if (SUPABASE_URL && SUPABASE_KEY) {
      try { await sbUpdate("scans", `id=eq.${scanId}`, { status: "failed", error: e.message, completed_at: new Date().toISOString() }); } catch {}
    }
  }
}

// ── Build site asset inventory from scan results ──

function buildInventory(results, client, scan) {
  const pages = results.pages_analyzed || [];
  const homepage = pages.find(p => p.type === "homepage") || pages[0] || {};
  const extracted = homepage.extracted || {};
  const checks = results.checks || results.scores?.ai_visibility?.checks || {};

  // Aggregate across all pages
  const allSeoDetails = pages.map(p => p.seo_details).filter(Boolean);
  const allJsDiffs = pages.map(p => p.js_diff).filter(Boolean);

  // ── 1. Protocol Files ──
  const protocols = [
    { name: "robots.txt", type: "protocol", exists: !!checks.robots?.exists, detail: checks.robots?.has_sitemap_reference ? "Has sitemap reference" : null },
    { name: "sitemap.xml", type: "protocol", exists: !!checks.sitemap?.exists, detail: checks.sitemap?.url_count ? `${checks.sitemap.url_count} URLs` : null },
    { name: "llms.txt", type: "protocol", exists: !!checks.llms_txt?.exists, detail: checks.llms_txt?.length ? `${checks.llms_txt.length} chars` : null },
    { name: "llms-full.txt", type: "protocol", exists: !!checks.llms_full_txt?.exists, detail: checks.llms_full_txt?.length ? `${checks.llms_full_txt.length} chars` : null },
    { name: "agent-card.json", type: "protocol", exists: !!checks.agent_card?.exists },
    { name: "UCP manifest", type: "protocol", exists: !!checks.ucp?.exists },
    { name: "A2UI config", type: "protocol", exists: !!(checks.a2ui?.exists || checks.protocol_signals?.a2ui?.detected), detail: checks.a2ui?.version ? `v${checks.a2ui.version}` : null },
    { name: "AG-UI manifest", type: "protocol", exists: !!(checks.ag_ui?.exists || checks.protocol_signals?.ag_ui?.detected), detail: checks.ag_ui?.version ? `v${checks.ag_ui.version}` : null },
    { name: "ACP endpoint", type: "protocol", exists: !!(checks.acp?.exists || checks.protocol_signals?.acp?.detected), detail: checks.acp?.version ? `v${checks.acp.version}` : null },
    { name: "ANP / DID", type: "protocol", exists: !!(checks.anp?.exists || checks.protocol_signals?.anp?.detected), detail: checks.anp?.has_did ? "DID document found" : null },
  ];

  // ── 2. Schema Markup ──
  const schema = extracted.schema || {};
  const schemaItems = [
    { name: "Organization", exists: !!schema.has_organization },
    { name: "Service", exists: !!schema.has_service },
    { name: "Product", exists: !!schema.has_product },
    { name: "FAQ", exists: !!schema.has_faq },
    { name: "Person", exists: !!schema.has_person },
    { name: "BreadcrumbList", exists: !!schema.has_breadcrumb },
    { name: "HowTo", exists: !!schema.has_howto },
    { name: "Speakable", exists: !!schema.has_speakable },
    { name: "ImageObject", exists: !!schema.has_image_object },
    { name: "VideoObject", exists: !!schema.has_video_object },
    { name: "SoftwareApplication", exists: !!schema.has_software_app },
    { name: "DataDownload", exists: !!schema.has_data_download },
    { name: "DigitalDocument", exists: !!schema.has_digital_document },
    { name: "MediaObject", exists: !!schema.has_media_object },
    { name: "CreativeWork", exists: !!schema.has_creative_work },
  ].map(s => ({ ...s, type: "schema" }));
  const totalSchemaBlocks = schema.schema_count || 0;

  // ── 3. Semantic HTML ──
  const aeo = extracted.aeo || {};
  const semanticTags = aeo.semantic_tags || {};
  const semanticItems = [
    { name: "<header>", count: semanticTags.header || 0 },
    { name: "<nav>", count: semanticTags.nav || 0 },
    { name: "<main>", count: semanticTags.main || 0 },
    { name: "<article>", count: semanticTags.article || 0 },
    { name: "<section>", count: semanticTags.section || 0 },
    { name: "<aside>", count: semanticTags.aside || 0 },
    { name: "<footer>", count: semanticTags.footer || 0 },
  ].map(s => ({ ...s, type: "semantic", exists: s.count > 0 }));

  // ── 4. Forms & Interactivity ──
  const formCount = aeo.form_count || 0;
  const webmcpForms = aeo.declarative_forms || [];
  const formsWithoutWebmcp = aeo.forms_without_webmcp || 0;
  const forms = {
    total: formCount,
    webmcp_enabled: webmcpForms.length,
    standard: formsWithoutWebmcp,
    declarative_forms: webmcpForms,
    js_injected: allJsDiffs.reduce((sum, d) => sum + (d.forms_added_by_js || 0), 0),
  };

  // ── 5. Media Assets ──
  const media = extracted.media || {};
  const mediaInventory = {
    images: {
      total: media.images_total || 0,
      with_alt: media.images_with_alt || 0,
      alt_coverage_pct: media.images_with_alt_pct || 0,
      has_webp_avif: !!media.has_webp_avif,
      has_srcset: !!media.has_srcset,
      is_spa: !!media.is_spa,
    },
    video: {
      detected: !!media.has_video,
    },
    og_image: !!media.has_og_image,
    twitter_card: !!media.has_twitter_card,
  };

  // ── 6. SEO Components (aggregated across pages) ──
  const seoSummary = {
    pages_analyzed: pages.length,
    pages: pages.map(p => {
      const seo = p.seo_details || {};
      return {
        url: p.url,
        type: p.type,
        status_code: p.status_code,
        response_time_ms: p.response_time_ms,
        title: seo.title || { quality: "unknown" },
        description: seo.description || { quality: "unknown" },
        h1_count: seo.h1?.count ?? 0,
        heading_hierarchy_valid: seo.heading_hierarchy_valid ?? null,
        images: seo.images || {},
        schema_count: seo.schema_count || 0,
        og_complete: seo.og_complete || 0,
        has_canonical: !!seo.canonical,
        has_viewport: !!seo.has_viewport,
        internal_link_count: seo.internal_link_count || 0,
      };
    }),
  };

  // ── 7. Tracking & Analytics ──
  const homepageScores = homepage.scores || {};
  const tracking = {
    score: homepageScores.tracking || 0,
    detected: homepageScores.tracking > 0,
  };

  // ── 8. Accessibility ──
  const accessibility = {
    aria_count: aeo.aria_count || 0,
    interactive_without_aria: aeo.interactive_without_aria || 0,
    has_aria_labels: !!aeo.has_aria_labels,
  };

  // ── 9. Digital Assets ──
  const digital = extracted.digital_assets || {};
  const digitalAssets = {
    download_links: digital.download_link_count || 0,
    download_attrs: digital.download_attr_count || 0,
    has_transcripts: !!digital.has_transcripts,
    has_schema: !!digital.has_digital_asset_schema,
  };

  // ── 10. JS Rendering Impact ──
  const jsDiff = {
    total_elements_added: allJsDiffs.reduce((sum, d) => sum + (d.elements_added || 0), 0),
    schemas_injected_by_js: allJsDiffs.reduce((sum, d) => sum + (d.schemas_injected_by_js || 0), 0),
    forms_added_by_js: allJsDiffs.reduce((sum, d) => sum + (d.forms_added_by_js || 0), 0),
    text_changes: allJsDiffs.flatMap(d => d.text_content_changed || []),
  };

  // ── Summary counts ──
  const protocolsFound = protocols.filter(p => p.exists).length;
  const schemasFound = schemaItems.filter(s => s.exists).length;
  const semanticFound = semanticItems.filter(s => s.exists).length;

  return {
    client: { id: client.id, name: client.name, website: client.website_url },
    scan: {
      id: scan.id,
      url: scan.url,
      grade: scan.grade,
      scores: scan.scores,
      scanned_at: scan.created_at,
    },
    summary: {
      protocols: { found: protocolsFound, total: protocols.length },
      schemas: { found: schemasFound, total: schemaItems.length, blocks: totalSchemaBlocks },
      semantic_html: { found: semanticFound, total: semanticItems.length, score: aeo.semantic_score || 0 },
      forms: { total: forms.total, webmcp_enabled: forms.webmcp_enabled },
      images: { total: mediaInventory.images.total, alt_coverage_pct: mediaInventory.images.alt_coverage_pct },
      accessibility: { aria_count: accessibility.aria_count, issues: accessibility.interactive_without_aria },
      digital_assets: { total: digitalAssets.download_links + digitalAssets.download_attrs },
      js_rendering: { elements_added: jsDiff.total_elements_added },
      pages_analyzed: seoSummary.pages_analyzed,
    },
    categories: {
      protocols,
      schemas: schemaItems,
      semantic_html: semanticItems,
      forms,
      media: mediaInventory,
      seo: seoSummary,
      tracking,
      accessibility,
      digital_assets: digitalAssets,
      js_rendering: jsDiff,
    },
  };
}

module.exports = { createAgencyApiRouter };
