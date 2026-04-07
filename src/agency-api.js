// Agency REST API — self-service endpoints for agency partners
// Auth: X-API-Key header (same key used for MCP endpoint)
// Mounts at /api/v1/agency/* on the Express app

const { Router } = require("express");
const crypto = require("crypto");

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
    const { name, website_url, contact_name, contact_email, industry, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

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
    const allowed = ["name", "website_url", "contact_name", "contact_email", "industry", "notes", "status"];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
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

  // POST /api/v1/agency/clients/:id/scan — Submit a scan for a client
  router.post("/api/v1/agency/clients/:id/scan", auth, async (req, res) => {
    const a = req.agency;
    const { tier = "visibility", max_pages, industry } = req.body;

    try {
      // Verify client belongs to this agency
      const client = await sbQuery(
        `agency_clients?id=eq.${encodeURIComponent(req.params.id)}&agency_id=eq.${a.id}&select=id,name,website_url,industry&limit=1`
      );
      if (!client?.[0]) return res.status(404).json({ error: "Client not found" });
      const c = client[0];

      const url = req.body.url || c.website_url;
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
    const { name = "API Key", permissions = ["scan", "read"], expires_in_days } = req.body;

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
    const allowed = ["brand_name", "logo_url", "accent_color", "cta_text", "powered_by", "lead_webhook_url"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields", allowed });
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
    const { tier } = req.body;
    const validTiers = ["starter", "pro", "enterprise"];

    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier. Choose: ${validTiers.join(", ")}` });
    }

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

module.exports = { createAgencyApiRouter };
