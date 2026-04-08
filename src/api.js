// REST API router — Scan Funnel MVP
// Endpoints: POST /api/v1/scan, GET /api/v1/scan/:id, GET /api/v1/scan/:id/report
// Mounts on the existing Express app in server.mjs

const { Router } = require("express");
const crypto = require("crypto");
const { z } = require("zod");

// ── Zod schemas ──
const ScanSubmitSchema = z.object({
  url: z.string().url("url must be a valid URL"),
  email: z.string().email().optional(),
  max_pages: z.number().int().min(1).max(50).optional(),
  industry: z.string().max(100).optional(),
  stripe_session_id: z.string().max(500).optional(),
});

const CheckoutSchema = z.object({
  tier: z.string().min(1, "tier is required"),
  email: z.string().email("valid email is required"),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Tier definitions ──
const SCAN_TIERS = {
  visibility: {
    name: "Visibility Scan",
    price_cents: 0,         // free
    paid_price_cents: 4900, // $49 for email-gated version with full report
    max_pages: 5,
    description: "GEO layer — 9 components scanned",
  },
  forge: {
    name: "Forge Scan",
    price_cents: 29900,     // $299
    max_pages: 10,
    description: "GEO + Executable layers — 17 components scanned",
  },
  diagnostic: {
    name: "Full Diagnostic",
    price_cents: 49900,     // $499
    max_pages: 20,
    description: "All 3 layers — 24 components, competitive analysis, full report",
  },
};

// ── Tier gating: filter results based on what the tier includes ──
function gateResultsByTier(fullResults, tier) {
  if (tier === "diagnostic") {
    // Full access — return everything
    return fullResults;
  }

  const gated = JSON.parse(JSON.stringify(fullResults));

  if (tier === "visibility") {
    // GEO layer only: show GEO score, hide agent-ready details, limit findings
    gated.scores.ai_visibility.agent_ready = null;
    gated.scores.ai_visibility.multimodal = null;
    gated.scores.marketing_health = {
      overall: gated.scores.marketing_health.overall,
      grade: gated.scores.marketing_health.grade,
    };
    // SEO Health: show overall + grade only
    if (gated.scores.seo_health) {
      gated.scores.seo_health = {
        overall: gated.scores.seo_health.overall,
        grade: gated.scores.seo_health.grade,
      };
    }

    // Only show P0 findings (critical) — rest are upgrade incentive
    const p1Count = gated.findings.p1.length;
    const p2Count = gated.findings.p2.length;
    gated.findings.p1 = [];
    gated.findings.p2 = [];
    gated.findings._gated = {
      hidden_p1: p1Count,
      hidden_p2: p2Count,
      upgrade_message: "Upgrade to Forge Scan ($299) to see all findings and detailed scores.",
    };

    // Hide per-page details
    gated.pages_analyzed = gated.pages_analyzed.map(p => ({
      url: p.url,
      type: p.type,
      status_code: p.status_code,
    }));

    // Remove checks (raw data)
    delete gated.checks;

    // Limit recommendations to top 3
    gated.recommendations = gated.recommendations.slice(0, 3);
    if (fullResults.recommendations.length > 3) {
      gated.recommendations.push({
        priority: "UPGRADE",
        action: `${fullResults.recommendations.length - 3} more recommendations available`,
        detail: "Upgrade to Forge Scan for the complete action plan.",
      });
    }
  }

  if (tier === "forge") {
    // GEO + Executable: show most scores, hide some infrastructure details
    gated.scores.marketing_health = {
      overall: gated.scores.marketing_health.overall,
      grade: gated.scores.marketing_health.grade,
      dimensions: gated.scores.marketing_health.dimensions,
    };

    // SEO Health: show sub-scores + homepage CWV, hide per-page details and lighthouse raw
    if (gated.scores.seo_health) {
      gated.scores.seo_health = {
        overall: gated.scores.seo_health.overall,
        grade: gated.scores.seo_health.grade,
        sub_scores: gated.scores.seo_health.sub_scores,
        core_web_vitals: gated.scores.seo_health.core_web_vitals,
        broken_link_count: gated.scores.seo_health.broken_link_count,
        pagespeed_available: gated.scores.seo_health.pagespeed_available,
        // Hide lighthouse raw scores (diagnostic only)
      };
    }

    // Show all findings but hide revenue impact on P2
    gated.findings.p2 = gated.findings.p2.map(f => {
      const { revenue_impact, ...rest } = f;
      return rest;
    });

    // Remove raw checks (full diagnostic only)
    delete gated.checks;
  }

  return gated;
}

// ── Supabase helpers ──
async function supabaseInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(data),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(`Supabase insert failed: ${JSON.stringify(result)}`);
  return Array.isArray(result) ? result[0] : result;
}

async function supabaseUpdate(table, id, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase update failed: ${err}`);
  }
}

async function supabaseGet(table, id) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=*&limit=1`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  const rows = await resp.json();
  return rows?.[0] || null;
}

// ── In-memory scan tracking (fallback if no Supabase) ──
const scanJobs = new Map();
const MAX_SCAN_JOBS = 500;

// Clean up completed jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of scanJobs) {
    if (job.completed_at && new Date(job.completed_at).getTime() < cutoff) {
      scanJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── Create router ──
function createApiRouter(performScan, validateScanUrl) {
  const router = Router();

  // ────────────────────────────────────────────────────────
  // STATIC ROUTES FIRST (before parameterized :id routes)
  // ────────────────────────────────────────────────────────

  // GET /api/v1/scan/tiers — Public tier/pricing info
  router.get("/api/v1/scan/tiers", (_req, res) => {
    const tiers = Object.entries(SCAN_TIERS).map(([key, t]) => ({
      tier: key,
      name: t.name,
      price: t.price_cents === 0 ? "Free" : `$${t.price_cents / 100}`,
      price_cents: t.price_cents,
      max_pages: t.max_pages,
      description: t.description,
    }));
    res.json({ tiers });
  });

  // POST /api/v1/scan/checkout — Create Stripe checkout for paid tiers
  router.post("/api/v1/scan/checkout", async (req, res) => {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { tier, email, success_url, cancel_url } = parsed.data;

    const tierConfig = SCAN_TIERS[tier];
    if (!tierConfig) {
      return res.status(400).json({ error: `Invalid tier: ${tier}` });
    }

    if (tierConfig.price_cents === 0) {
      return res.status(400).json({
        error: "Visibility scans are free — submit directly to POST /api/v1/scan",
      });
    }

    try {
      const Stripe = require("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      // Find or create scan product
      let productId;
      const existing = await stripe.products.search({
        query: 'metadata["app"]:"ethereal-forge-scan"',
      }).catch(() => ({ data: [] }));

      if (existing.data.length > 0) {
        productId = existing.data[0].id;
      } else {
        const product = await stripe.products.create({
          name: "Ethereal Forge Scan",
          description: "AI Visibility & Marketing Health website scan",
          metadata: { app: "ethereal-forge-scan" },
        });
        productId = product.id;
      }

      const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [{
          price_data: {
            currency: "usd",
            product: productId,
            unit_amount: tierConfig.price_cents,
          },
          quantity: 1,
        }],
        metadata: {
          tier,
          scan_type: "one_time",
        },
        success_url: success_url || `${baseUrl}/api/v1/scan/success?session_id={CHECKOUT_SESSION_ID}&tier=${tier}`,
        cancel_url: cancel_url || `${baseUrl}/api/v1/scan/cancel`,
        allow_promotion_codes: true,
      });

      // Persist checkout record
      if (SUPABASE_URL && SUPABASE_KEY) {
        try {
          await supabaseInsert("scan_payments", {
            scan_id: null,
            stripe_session_id: session.id,
            email,
            tier,
            amount_cents: tierConfig.price_cents,
            status: "pending",
          });
        } catch (e) {
          console.error("Failed to persist checkout:", e.message);
        }
      }

      res.json({
        checkout_url: session.url,
        session_id: session.id,
        tier,
        price: `$${tierConfig.price_cents / 100}`,
        next_step: `After payment, POST /api/v1/scan with stripe_session_id="${session.id}"`,
      });
    } catch (e) {
      console.error("Checkout creation failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/scan/success — Payment success page
  router.get("/api/v1/scan/success", (_req, res) => {
    const sessionId = escapeHtml(_req.query.session_id || "");
    const tier = escapeHtml(_req.query.tier || "");
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payment Confirmed</title>
<style>body{font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;text-align:center;color:#1a1a1a}
h1{color:#6366f1}.check{font-size:64px;margin:20px}code{background:#f1f1f5;padding:2px 8px;border-radius:4px;font-size:13px}
.next{background:#f8f8fc;border:1px solid #e2e2f0;border-radius:8px;padding:20px;margin:24px 0;text-align:left}</style></head>
<body>
<div class="check">&#10003;</div>
<h1>Payment Confirmed!</h1>
<p>Your <strong>${tier}</strong> scan is ready to run.</p>
<div class="next">
<h3>Next Step</h3>
<p>Submit your scan with this session ID:</p>
<code style="display:block;background:#1a1a2e;color:#a5f3fc;padding:12px;border-radius:4px;word-break:break-all;font-size:12px">
POST /api/v1/scan
{
  "url": "https://your-site.com",
  "tier": "${tier}",
  "stripe_session_id": "${sessionId}"
}</code>
</div>
</body></html>`);
  });

  // ────────────────────────────────────────────────────────
  // POST /api/v1/scan — Submit a new scan
  // ────────────────────────────────────────────────────────
  router.post("/api/v1/scan", async (req, res) => {
    const parsed = ScanSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { url, email, max_pages, industry, stripe_session_id: bodyStripeSessionId } = parsed.data;

    // Validate URL against SSRF
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }

    try {
      await validateScanUrl(url);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Determine tier from authenticated session/JWT, not from client request body.
    // If the user has a valid JWT with a tier claim, use that; otherwise default to free tier.
    let tier = "visibility"; // default: free tier
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        // Decode JWT payload (validation happens at middleware level;
        // here we extract the tier claim from a verified token)
        const payloadB64 = token.split(".")[1];
        if (payloadB64) {
          const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
          if (payload.tier && SCAN_TIERS[payload.tier]) {
            tier = payload.tier;
          }
        }
      } catch {
        // Malformed token — fall through to free tier
      }
    }

    // Validate tier
    if (!SCAN_TIERS[tier]) {
      return res.status(400).json({
        error: `Invalid tier. Choose: ${Object.keys(SCAN_TIERS).join(", ")}`,
        tiers: Object.keys(SCAN_TIERS).map(k => ({
          tier: k,
          name: SCAN_TIERS[k].name,
          price: SCAN_TIERS[k].price_cents === 0 ? "Free" : `$${SCAN_TIERS[k].price_cents / 100}`,
        })),
      });
    }

    // Paid tiers require checkout first (unless already paid via stripe_session_id)
    const tierConfig = SCAN_TIERS[tier];
    const isPaid = tierConfig.price_cents > 0;
    const stripeSessionId = bodyStripeSessionId || null;

    if (isPaid && !stripeSessionId) {
      return res.status(402).json({
        error: "Payment required",
        tier,
        price: `$${tierConfig.price_cents / 100}`,
        checkout_url: "/api/v1/scan/checkout",
        message: `Create a checkout session first via POST /api/v1/scan/checkout with tier="${tier}"`,
      });
    }

    // If paid, verify the Stripe session
    if (isPaid && stripeSessionId) {
      try {
        const Stripe = require("stripe");
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.retrieve(stripeSessionId);

        if (session.payment_status !== "paid") {
          return res.status(402).json({
            error: "Payment not completed",
            payment_status: session.payment_status,
            checkout_url: session.url,
          });
        }
      } catch (e) {
        return res.status(400).json({ error: `Invalid stripe_session_id: ${e.message}` });
      }
    }

    // Create scan record
    const scanId = crypto.randomUUID();
    const scanRecord = {
      id: scanId,
      url,
      tier,
      status: "queued",
      email: email || null,
      lead_email: email || null,
      max_pages: max_pages || tierConfig.max_pages,
      industry: industry || "general",
      paid: !isPaid || !!stripeSessionId,
      amount_cents: tierConfig.price_cents,
      stripe_session_id: stripeSessionId || null,
      ip_address: req.ip,
      created_at: new Date().toISOString(),
    };

    // Persist to Supabase (or in-memory fallback)
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        await supabaseInsert("scans", scanRecord);
      } catch (e) {
        console.error("Failed to persist scan to Supabase:", e.message);
        // Fall back to in-memory
        scanJobs.set(scanId, scanRecord);
      }
    } else {
      if (scanJobs.size >= MAX_SCAN_JOBS) {
        return res.status(503).json({ error: "Too many pending scans. Try again later." });
      }
      scanJobs.set(scanId, scanRecord);
    }

    // Return immediately with scan ID
    res.status(202).json({
      scan_id: scanId,
      status: "queued",
      tier,
      url,
      poll_url: `/api/v1/scan/${scanId}`,
      report_url: `/api/v1/scan/${scanId}/report`,
      estimated_seconds: tierConfig.max_pages * 8,
    });

    // Run scan async (fire and forget — don't await in request handler)
    runScanAsync(scanId, scanRecord, performScan);
  });

  // ────────────────────────────────────────────────────────
  // GET /api/v1/scan/:id — Poll scan status + results
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/scan/:id", async (req, res) => {
    const { id } = req.params;

    // Try Supabase first, then in-memory
    let scan = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        scan = await supabaseGet("scans", id);
      } catch (e) {
        console.error("Supabase fetch failed:", e.message);
      }
    }
    if (!scan) {
      scan = scanJobs.get(id);
    }

    if (!scan) {
      return res.status(404).json({ error: "Scan not found", scan_id: id });
    }

    // Build response based on status
    const response = {
      scan_id: scan.id,
      url: scan.url,
      tier: scan.tier,
      status: scan.status,
      created_at: scan.created_at,
    };

    if (scan.status === "running") {
      response.started_at = scan.started_at;
      response.message = "Scan in progress...";
    }

    if (scan.status === "complete") {
      response.completed_at = scan.completed_at;
      response.scan_duration_ms = scan.scan_duration_ms;
      response.pages_scanned = scan.pages_scanned;
      response.scores = scan.scores;
      response.grade = scan.grade;
      response.report_url = `/api/v1/scan/${id}/report`;

      // Include gated results
      if (scan.results) {
        const results = typeof scan.results === "string" ? JSON.parse(scan.results) : scan.results;
        response.results = gateResultsByTier(results, scan.tier);
      }
    }

    if (scan.status === "failed") {
      response.error = scan.error;
    }

    res.json(response);
  });

  // ────────────────────────────────────────────────────────
  // GET /api/v1/scan/:id/report — Download report (JSON)
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/scan/:id/report", async (req, res) => {
    const { id } = req.params;
    const format = req.query.format || "json";

    let scan = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        scan = await supabaseGet("scans", id);
      } catch (e) {
        console.error("Supabase fetch failed:", e.message);
      }
    }
    if (!scan) scan = scanJobs.get(id);

    if (!scan) {
      return res.status(404).json({ error: "Scan not found" });
    }

    if (scan.status !== "complete") {
      return res.status(409).json({
        error: "Scan not complete",
        status: scan.status,
        poll_url: `/api/v1/scan/${id}`,
      });
    }

    const results = typeof scan.results === "string" ? JSON.parse(scan.results) : scan.results;
    const gated = gateResultsByTier(results, scan.tier);

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="scan-${id}.json"`);
      return res.json({
        report_type: "ai_visibility_scan",
        tier: scan.tier,
        tier_name: SCAN_TIERS[scan.tier]?.name,
        generated_at: new Date().toISOString(),
        scan_id: id,
        ...gated,
      });
    }

    // TODO: PDF generation (Phase 2)
    res.status(501).json({
      error: "PDF reports coming soon",
      json_url: `/api/v1/scan/${id}/report?format=json`,
    });
  });

  return router;
}

// ── Async scan execution ──
async function runScanAsync(scanId, scanRecord, performScan) {
  const startedAt = new Date().toISOString();

  // Update status to running
  const runningUpdate = { status: "running", started_at: startedAt };

  if (SUPABASE_URL && SUPABASE_KEY) {
    try { await supabaseUpdate("scans", scanId, runningUpdate); } catch {}
  }
  if (scanJobs.has(scanId)) {
    Object.assign(scanJobs.get(scanId), runningUpdate);
  }

  try {
    const results = await performScan(
      scanRecord.url,
      scanRecord.max_pages,
      scanRecord.industry
    );

    const completedAt = new Date().toISOString();
    const forgeScore = results.scores.forge_score || results.scores.combined;
    const completionUpdate = {
      status: "complete",
      results,
      scores: {
        ai_visibility: results.scores.ai_visibility.overall,
        geo: results.scores.ai_visibility.geo,
        multimodal: results.scores.ai_visibility.multimodal,
        agent_ready: results.scores.ai_visibility.agent_ready,
        seo_health: results.scores.seo_health?.overall || null,
        marketing_health: results.scores.marketing_health.overall,
        forge_score: forgeScore.overall,
        combined: forgeScore.overall,
      },
      grade: forgeScore.grade,
      scan_duration_ms: results.metadata.scan_duration_ms,
      pages_scanned: results.metadata.pages_scanned,
      completed_at: completedAt,
    };

    if (SUPABASE_URL && SUPABASE_KEY) {
      try { await supabaseUpdate("scans", scanId, completionUpdate); } catch (e) {
        console.error(`Scan ${scanId} Supabase update failed:`, e.message);
      }
    }
    if (scanJobs.has(scanId)) {
      Object.assign(scanJobs.get(scanId), completionUpdate);
    }

    console.log(`Scan ${scanId} complete: Forge Score ${forgeScore.grade} (${forgeScore.overall}/100) in ${results.metadata.scan_duration_ms}ms`);

    // Capture lead if email was provided (feeds into nurture sequence)
    if (scanRecord.email && SUPABASE_URL && SUPABASE_KEY) {
      try {
        // Check if lead already exists
        const checkResp = await fetch(
          `${SUPABASE_URL}/rest/v1/leads?email=eq.${encodeURIComponent(scanRecord.email)}&select=id&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const existing = await checkResp.json();

        if (!existing || existing.length === 0) {
          await supabaseInsert("leads", {
            email: scanRecord.email,
            website_url: scanRecord.url,
            source: "scan_form",
            status: "new",
            lead_score: 10,
            notes: `${scanRecord.tier} scan — Forge Score ${forgeScore.grade} (${forgeScore.overall}/100)`,
          });
          console.log(`Lead captured from scan: ${scanRecord.email}`);
        }
      } catch (e) {
        console.error(`Lead capture failed for ${scanRecord.email}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`Scan ${scanId} failed:`, e.message);

    const failUpdate = { status: "failed", error: e.message, completed_at: new Date().toISOString() };

    if (SUPABASE_URL && SUPABASE_KEY) {
      try { await supabaseUpdate("scans", scanId, failUpdate); } catch {}
    }
    if (scanJobs.has(scanId)) {
      Object.assign(scanJobs.get(scanId), failUpdate);
    }
  }
}

// HTML escape helper
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { createApiRouter, SCAN_TIERS, gateResultsByTier };
