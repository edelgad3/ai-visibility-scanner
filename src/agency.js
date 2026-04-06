// Agency multi-tenant module — auth, branding, metering, lead routing
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_KEY && process.env.NODE_ENV === "production") {
  console.warn("WARNING: SUPABASE_SERVICE_KEY not set. Agency features will not work.");
}

// HTML escape for branding tokens injected into templates
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Validate hex color to prevent CSS injection
function isValidHexColor(s) {
  return /^#[0-9a-fA-F]{3,8}$/.test(s);
}

// Validate URL for logo_url (must be https, no injection chars)
function isValidLogoUrl(s) {
  try {
    const url = new URL(s);
    return url.protocol === "https:" && !s.includes('"') && !s.includes("'") && !s.includes("<") && !s.includes(">");
  } catch { return false; }
}

// In-memory agency cache (TTL: 5 min)
const agencyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Default Ethereal Media config (used when no agency slug)
const DEFAULT_AGENCY = {
  id: null,
  name: "Ethereal Media",
  slug: "ethereal",
  tier: "enterprise",
  scans_used: 0,
  scans_limit: 999999,
  brand_name: "AI Visibility Scanner",
  logo_url: null,
  accent_color: "#6366f1",
  cta_text: "Get This Fixed",
  powered_by: 'Powered by <strong>Ethereal Media</strong> &mdash; The Ethereal Forge',
  lead_webhook_url: null,
  pricing_overrides: null,
  active: true,
};

// Tier scan limits
const TIER_LIMITS = {
  starter: 50,
  growth: 250,
  enterprise: 999999,
};

// ── Fetch agency by slug ──
async function getAgencyBySlug(slug) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const cached = agencyCache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=*&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const rows = await resp.json();
    const agency = rows?.[0] || null;
    agencyCache.set(slug, { data: agency, ts: Date.now() });
    return agency;
  } catch (e) {
    console.error("Agency lookup failed:", e.message);
    return null;
  }
}

// ── Validate API key ──
async function validateApiKey(slug, apiKey) {
  const agency = await getAgencyBySlug(slug);
  if (!agency) return { valid: false, error: "Agency not found", status: 404 };
  // Timing-safe comparison to prevent side-channel attacks
  const storedKey = agency.api_key || "";
  const providedKey = apiKey || "";
  if (storedKey.length !== providedKey.length || !crypto.timingSafeEqual(Buffer.from(storedKey), Buffer.from(providedKey))) {
    return { valid: false, error: "Invalid API key", status: 401 };
  }
  if (agency.scans_used >= agency.scans_limit) return { valid: false, error: "Scan limit reached", status: 429 };
  return { valid: true, agency };
}

// ── Express middleware for /a/:slug/mcp ──
function agencyAuth() {
  return async (req, res, next) => {
    const { slug } = req.params;
    const apiKey = req.query.key || req.headers["x-api-key"];

    if (!apiKey) {
      return res.status(401).json({ error: "API key required. Use ?key=xxx or X-API-Key header." });
    }

    const result = await validateApiKey(slug, apiKey);
    if (!result.valid) {
      return res.status(result.status).json({ error: result.error });
    }

    req.agency = result.agency;
    next();
  };
}

// ── Branding: inject template tokens into HTML ──
function brandDashboard(html, agency) {
  if (!agency) return html;

  // Sanitize all agency-controlled values before injection
  const brandName = escapeHtml(agency.brand_name || DEFAULT_AGENCY.brand_name);
  const accentColor = isValidHexColor(agency.accent_color || "") ? agency.accent_color : DEFAULT_AGENCY.accent_color;
  const ctaText = escapeHtml(agency.cta_text || DEFAULT_AGENCY.cta_text);
  const poweredBy = escapeHtml(agency.powered_by || "Powered by Ethereal Media");

  let logoHtml;
  if (agency.logo_url && isValidLogoUrl(agency.logo_url)) {
    logoHtml = `<img src="${escapeHtml(agency.logo_url)}" alt="${brandName}" class="agency-logo" height="28" />`;
  } else {
    logoHtml = `<svg class="logo" viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
  }

  const tokens = {
    "{{BRAND_NAME}}": brandName,
    "{{ACCENT_COLOR}}": accentColor,
    "{{LOGO_HTML}}": logoHtml,
    "{{POWERED_BY}}": poweredBy,
    "{{CTA_TEXT}}": ctaText,
  };

  let branded = html;
  for (const [token, value] of Object.entries(tokens)) {
    branded = branded.replaceAll(token, value);
  }

  // Inject CSS variable override for accent color (validated above)
  const accentCSS = `<style>:root { --accent: ${accentColor}; --accent-hover: ${accentColor}dd; }</style>`;
  branded = branded.replace("</head>", `${accentCSS}\n</head>`);

  return branded;
}

// ── Pricing: get tier prices (with agency overrides) ──
function getTierPricing(agency) {
  const defaults = {
    quick_fix: { name: "Quick Fix", price: "$99", desc: "Single finding fix" },
    full_audit: { name: "Full Audit Fix", price: "$299", desc: "All critical + important findings" },
    agent_access: { name: "Agent Access", price: "$4,999", desc: "Full Forge Build + ongoing optimization" },
  };

  if (agency?.pricing_overrides) {
    for (const [tier, overrides] of Object.entries(agency.pricing_overrides)) {
      if (defaults[tier]) Object.assign(defaults[tier], overrides);
    }
  }

  return defaults;
}

// ── Metering: increment scan count + log event ──
async function recordScanEvent(agencyId, scanResults) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !agencyId) return;

  try {
    // Increment scans_used via RPC (atomic increment in Postgres)
    const rpcResp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/increment_agency_scans`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ agency_uuid: agencyId }),
      }
    );
    if (!rpcResp.ok) {
      console.error(`METERING FAILED for agency ${agencyId}: RPC returned ${rpcResp.status} ${await rpcResp.text()}`);
      // No fallback — the RPC must exist (created in migration 001). Log loudly so we notice.
    }

    // Log scan event
    await fetch(`${SUPABASE_URL}/rest/v1/scan_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        agency_id: agencyId,
        url: scanResults.client?.url || "",
        pages_scanned: scanResults.metadata?.pages_scanned || 1,
        scan_duration_ms: scanResults.metadata?.scan_duration_ms || 0,
        ai_visibility_score: scanResults.scores?.ai_visibility?.overall || 0,
        marketing_health_score: scanResults.scores?.marketing_health?.overall || 0,
        combined_score: scanResults.scores?.combined?.overall || 0,
        grade: scanResults.scores?.combined?.grade || "",
      }),
    });

    // Invalidate cache so next request sees updated count
    for (const [key, val] of agencyCache.entries()) {
      if (val.data?.id === agencyId) agencyCache.delete(key);
    }
  } catch (e) {
    console.error("Metering failed:", e.message);
  }
}

// ── Lead routing: send to agency webhook ──
async function routeLeadToAgency(agency, leadData) {
  if (!agency?.lead_webhook_url) return;

  try {
    await fetch(agency.lead_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "new_lead",
        agency: { name: agency.name, slug: agency.slug },
        lead: leadData,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error(`Lead webhook failed for ${agency.slug}:`, e.message);
  }
}

// ── Build agency config for createServer ──
function buildAgencyConfig(agency) {
  if (!agency) return { ...DEFAULT_AGENCY };

  return {
    id: agency.id,
    name: agency.name,
    slug: agency.slug,
    tier: agency.tier,
    scans_used: agency.scans_used,
    scans_limit: agency.scans_limit,
    brand_name: agency.brand_name || DEFAULT_AGENCY.brand_name,
    logo_url: agency.logo_url,
    accent_color: agency.accent_color || DEFAULT_AGENCY.accent_color,
    cta_text: agency.cta_text || DEFAULT_AGENCY.cta_text,
    powered_by: agency.powered_by || DEFAULT_AGENCY.powered_by,
    lead_webhook_url: agency.lead_webhook_url,
    pricing_overrides: agency.pricing_overrides,
    active: agency.active,
  };
}

module.exports = {
  DEFAULT_AGENCY,
  TIER_LIMITS,
  getAgencyBySlug,
  validateApiKey,
  agencyAuth,
  brandDashboard,
  getTierPricing,
  recordScanEvent,
  routeLeadToAgency,
  buildAgencyConfig,
};
