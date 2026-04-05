import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import express from "express";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import existing scanning modules (CommonJS)
const { probeEndpoints } = require("./src/endpoints.js");
const { analyzePage, closeBrowser, discoverSubpages } = require("./src/dom-analyzer.js");
const {
  computeScores,
  getGrade,
  generateFindings,
  calculateMarketingHealth,
  generateMarketingFindings,
  getScoreBreakdown,
} = require("./src/scoring.js");

// Agency multi-tenant module
const {
  DEFAULT_AGENCY,
  agencyAuth,
  brandDashboard,
  getTierPricing,
  recordScanEvent,
  routeLeadToAgency,
  buildAgencyConfig,
} = require("./src/agency.js");

// Load bundled dashboard HTML (built by Vite)
let DASHBOARD_HTML;
try {
  DASHBOARD_HTML = readFileSync(path.join(__dirname, "dist/dashboard.html"), "utf-8");
} catch {
  DASHBOARD_HTML = "<html><body><p>Dashboard not built. Run: npm run build:ui</p></body></html>";
}

const RESOURCE_URI = "ui://ethereal/scanner-dashboard.html";

// ── Core scan logic (extracted from CLI) ──
async function performScan(url, maxPages = 5, industry = "general") {
  const startTime = Date.now();

  const rawEndpoints = await probeEndpoints(url);
  const homepageAnalysis = await analyzePage(url, "homepage", true);

  const subpageCandidates = discoverSubpages(homepageAnalysis._internalLinks || [], maxPages);
  const subpageResults = [];
  for (const candidate of subpageCandidates) {
    try {
      const result = await analyzePage(candidate.url, "subpage", false);
      if (result.status_code === 200) subpageResults.push(result);
    } catch {
      // Skip failed subpages
    }
  }
  await closeBrowser();

  const checks = {
    robots: rawEndpoints.robots,
    sitemap: rawEndpoints.sitemap,
    llms_txt: rawEndpoints.llms_txt,
    llms_full_txt: rawEndpoints.llms_full_txt,
    agent_card: rawEndpoints.agent_card,
    ucp: rawEndpoints.ucp,
    schema: homepageAnalysis.extracted.schema,
    meta: homepageAnalysis.extracted.meta,
    media: homepageAnalysis.extracted.media,
    aeo: homepageAnalysis.extracted.aeo,
    digital_assets: homepageAnalysis.extracted.digital_assets,
  };

  const aiScores = computeScores(checks);

  const allPages = [homepageAnalysis, ...subpageResults].map((p) => ({
    url: p.url,
    type: p.type,
    status_code: p.status_code,
    response_time_ms: p.response_time_ms,
    scores: p.scores,
    overall: p.overall,
    js_diff: p.js_diff,
  }));

  const marketingHealth = calculateMarketingHealth(allPages, checks);
  const aiFindings = generateFindings(checks);
  const marketingFindings = generateMarketingFindings(marketingHealth, checks);

  for (const mf of marketingFindings) {
    const entry = {
      action: mf.action,
      detail: mf.detail || "",
      category: mf.category || "Marketing",
      effort: mf.effort || "medium",
      impact: mf.impact || "medium",
      source: "marketing_health",
      revenue_impact: mf.revenue_impact || {},
    };
    if (mf.priority === "critical") aiFindings.p0.push(entry);
    else if (mf.priority === "high") aiFindings.p1.push(entry);
    else aiFindings.p2.push(entry);
  }

  const recommendations = [];
  for (const priority of ["p0", "p1", "p2"]) {
    for (const finding of aiFindings[priority]) {
      recommendations.push({ priority: priority.toUpperCase(), ...finding });
    }
  }

  const combinedOverall = Math.round(((aiScores.overall * 0.5) + (marketingHealth.overall * 0.5)) * 10) / 10;

  const revenueImpact = {
    monthly_low: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_low || 0), 0),
    monthly_mid: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_mid || 0), 0),
    monthly_high: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_high || 0), 0),
  };

  let clientName = "";
  try { clientName = new URL(url).hostname.replace("www.", ""); } catch { clientName = url; }

  return {
    client: { name: clientName, url, industry, audit_date: new Date().toISOString().split("T")[0] },
    scores: {
      ai_visibility: {
        overall: aiScores.overall,
        geo: aiScores.geo,
        multimodal: aiScores.multimodal,
        agent_ready: aiScores.agentReady,
        grade: aiScores.grade,
      },
      marketing_health: marketingHealth,
      combined: { overall: combinedOverall, grade: getGrade(combinedOverall) },
    },
    findings: aiFindings,
    pages_analyzed: allPages,
    recommendations,
    revenue_impact: revenueImpact,
    checks,
    metadata: {
      scanner: "forge-scanner-mcp-app",
      scan_duration_ms: Date.now() - startTime,
      pages_scanned: allPages.length,
    },
  };
}

// Helper to build scan result payload
function buildScanResponse(results) {
  return {
    content: [{
      type: "text",
      text: [
        `Scanned ${results.client.name} (${results.client.url})`,
        `AI Visibility: ${results.scores.ai_visibility.overall}/100 (${results.scores.ai_visibility.grade})`,
        `  GEO: ${results.scores.ai_visibility.geo} | Multimodal: ${results.scores.ai_visibility.multimodal} | Agent-Ready: ${results.scores.ai_visibility.agent_ready}`,
        `Marketing Health: ${results.scores.marketing_health.overall}/100 (${results.scores.marketing_health.grade})`,
        `Combined: ${results.scores.combined.overall}/100 (${results.scores.combined.grade})`,
        `Findings: ${results.findings.p0.length} critical, ${results.findings.p1.length} important, ${results.findings.p2.length} nice-to-have`,
        `Revenue Impact: $${results.revenue_impact.monthly_low.toLocaleString()}-$${results.revenue_impact.monthly_high.toLocaleString()}/mo`,
        `Pages scanned: ${results.metadata.pages_scanned} in ${(results.metadata.scan_duration_ms / 1000).toFixed(1)}s`,
      ].join("\n"),
    }],
    structuredContent: {
      client: results.client,
      scores: results.scores,
      findings_summary: {
        p0: results.findings.p0.length,
        p1: results.findings.p1.length,
        p2: results.findings.p2.length,
      },
      revenue_impact: results.revenue_impact,
      metadata: results.metadata,
    },
    _meta: {
      ui: { resourceUri: RESOURCE_URI },
      findings: results.findings,
      pages_analyzed: results.pages_analyzed,
      recommendations: results.recommendations,
      checks: results.checks,
    },
  };
}

// ── MCP Server Factory (agency-aware) ──
function createServer(agencyConfig = DEFAULT_AGENCY) {
  const serverName = agencyConfig.brand_name || "AI Visibility Scanner";

  const server = new McpServer({
    name: serverName,
    version: "1.0.0",
  });

  // Brand the dashboard HTML for this agency
  const dashboardHTML = brandDashboard(DASHBOARD_HTML, agencyConfig);

  // Register UI resource
  registerAppResource(
    server,
    "Scanner Dashboard",
    RESOURCE_URI,
    { description: `${serverName} interactive dashboard` },
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dashboardHTML,
      }],
    })
  );

  // Wrap scan to add metering
  async function scanWithMetering(url, maxPages, industry) {
    const results = await performScan(url, maxPages, industry);
    // Fire-and-forget metering
    recordScanEvent(agencyConfig.id, results);
    return results;
  }

  // Main tool: scan_website
  registerAppTool(
    server,
    "scan_website",
    {
      description: `Scan any website for AI visibility and marketing health. Returns scores for GEO (Generative Engine Optimization), Multimodal readiness, Agent-Ready infrastructure, and 6-dimension Marketing Health. Identifies critical findings with prioritized fix recommendations and revenue impact estimates.`,
      inputSchema: {
        url: z.string().url().describe("The website URL to scan (e.g. https://example.com)"),
        max_pages: z.number().min(1).max(20).default(5).describe("Maximum subpages to scan (default: 5)"),
        industry: z.string().default("general").describe("Industry vertical for context"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
      },
    },
    async ({ url, max_pages, industry }) => {
      const results = await scanWithMetering(url, max_pages, industry);
      return buildScanResponse(results);
    }
  );

  // App-only tool: refresh_scan
  registerAppTool(
    server,
    "refresh_scan",
    {
      description: "Re-scan with updated parameters",
      inputSchema: {
        url: z.string().url(),
        max_pages: z.number().min(1).max(20).default(5),
      },
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ url, max_pages }) => {
      const results = await scanWithMetering(url, max_pages);
      return buildScanResponse(results);
    }
  );

  // App-only tool: compare_scan
  registerAppTool(
    server,
    "compare_scan",
    {
      description: "Scan a competitor and return side-by-side comparison",
      inputSchema: {
        url: z.string().url(),
        competitor_url: z.string().url(),
        max_pages: z.number().min(1).max(10).default(3),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ url, competitor_url, max_pages }) => {
      const [primary, competitor] = await Promise.all([
        scanWithMetering(url, max_pages),
        scanWithMetering(competitor_url, max_pages),
      ]);
      const delta = {
        ai_visibility: Math.round((primary.scores.ai_visibility.overall - competitor.scores.ai_visibility.overall) * 10) / 10,
        marketing_health: Math.round((primary.scores.marketing_health.overall - competitor.scores.marketing_health.overall) * 10) / 10,
        combined: Math.round((primary.scores.combined.overall - competitor.scores.combined.overall) * 10) / 10,
        geo: primary.scores.ai_visibility.geo - competitor.scores.ai_visibility.geo,
        multimodal: primary.scores.ai_visibility.multimodal - competitor.scores.ai_visibility.multimodal,
        agent_ready: primary.scores.ai_visibility.agent_ready - competitor.scores.ai_visibility.agent_ready,
      };
      return {
        structuredContent: { primary: primary.scores, competitor: competitor.scores, delta, primary_url: url, competitor_url },
        _meta: {
          ui: { resourceUri: RESOURCE_URI },
          primary_findings: primary.findings,
          competitor_findings: competitor.findings,
          primary_checks: primary.checks,
          competitor_checks: competitor.checks,
        },
      };
    }
  );

  // App-only tool: get_score_breakdown
  registerAppTool(
    server,
    "get_score_breakdown",
    {
      description: "Get detailed line-item breakdown for a score dimension",
      inputSchema: {
        dimension: z.enum(["geo", "multimodal", "agent_ready"]),
        checks: z.any(),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ dimension, checks }) => {
      const breakdown = getScoreBreakdown(dimension, checks);
      const total = breakdown.reduce((s, r) => s + r.points, 0);
      const max = breakdown.reduce((s, r) => s + r.maxPoints, 0);
      return {
        structuredContent: { dimension, breakdown, total, max, passed: breakdown.filter(r => r.passed).length, failed: breakdown.filter(r => !r.passed).length },
      };
    }
  );

  // App-only tool: submit_lead (agency-aware)
  registerAppTool(
    server,
    "submit_lead",
    {
      description: "Submit a lead for service booking",
      inputSchema: {
        name: z.string(),
        email: z.string(),
        company: z.string().optional(),
        tier: z.enum(["quick_fix", "full_audit", "agent_access"]),
        scan_url: z.string().url(),
        findings_count: z.number().optional(),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async (args) => {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

      // Supabase lead capture (with agency_id)
      if (supabaseUrl && supabaseKey) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/leads`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              name: args.name,
              email: args.email,
              company_name: args.company || "",
              website_url: args.scan_url,
              lead_score: args.findings_count || 0,
              source: agencyConfig.slug === "ethereal" ? "mcp_app_scanner" : `agency_${agencyConfig.slug}`,
              agency_id: agencyConfig.id || null,
              notes: `Tier: ${args.tier}, Findings: ${args.findings_count || 0}`,
              created_at: new Date().toISOString(),
            }),
          });
        } catch (e) {
          console.error("Supabase lead insert failed:", e.message);
        }
      }

      // Route lead to agency webhook
      routeLeadToAgency(agencyConfig, {
        name: args.name,
        email: args.email,
        company: args.company,
        tier: args.tier,
        scan_url: args.scan_url,
        findings_count: args.findings_count,
      });

      // Slack notification (Ethereal Media always gets notified)
      const slackWebhook = process.env.SLACK_WEBHOOK_URL;
      if (slackWebhook) {
        try {
          const pricing = getTierPricing(agencyConfig);
          const tierLabel = pricing[args.tier]?.name || args.tier;
          const tierPrice = pricing[args.tier]?.price || "";
          const agencyLabel = agencyConfig.slug === "ethereal" ? "" : ` [via ${agencyConfig.name}]`;
          await fetch(slackWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: `New lead from AI Visibility Scanner${agencyLabel}:\n*${args.name}* (${args.email})\nCompany: ${args.company || "N/A"}\nTier: ${tierLabel} (${tierPrice})\nSite: ${args.scan_url}\nFindings: ${args.findings_count || 0}`,
            }),
          });
        } catch (e) {
          console.error("Slack notification failed:", e.message);
        }
      }

      return {
        structuredContent: { success: true, tier: args.tier, message: "We'll be in touch within 24 hours." },
      };
    }
  );

  return server;
}

// ── Express Server with Multi-Tenant Routing ──
const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "AI Visibility Scanner",
    version: "1.1.0",
    description: "Multi-tenant AI Visibility Scanner — scan websites for AI readiness and marketing health",
    endpoints: {
      default_mcp: "/mcp",
      agency_mcp: "/a/:slug/mcp?key=xxx",
    },
  });
});

// Session stores (keyed by transport session ID)
const defaultSessions = new Map();
const agencySessions = new Map();

// ── Default MCP endpoint (Ethereal Media branding) ──

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && defaultSessions.has(sessionId)) {
    const transport = defaultSessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const mcpServer = createServer(DEFAULT_AGENCY);
  await mcpServer.connect(transport);

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    defaultSessions.set(transport.sessionId, transport);
    transport.onclose = () => defaultSessions.delete(transport.sessionId);
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && defaultSessions.has(sessionId)) {
    const transport = defaultSessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No active session" });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && defaultSessions.has(sessionId)) {
    const transport = defaultSessions.get(sessionId);
    await transport.close();
    defaultSessions.delete(sessionId);
  }
  res.status(200).end();
});

// ── Agency MCP endpoint: /a/:slug/mcp ──

app.post("/a/:slug/mcp", agencyAuth(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const agency = req.agency;
  const sessionKey = `${agency.slug}:${sessionId}`;

  if (sessionId && agencySessions.has(sessionKey)) {
    const transport = agencySessions.get(sessionKey);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const agencyConfig = buildAgencyConfig(agency);
  const mcpServer = createServer(agencyConfig);
  await mcpServer.connect(transport);

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    const key = `${agency.slug}:${transport.sessionId}`;
    agencySessions.set(key, transport);
    transport.onclose = () => agencySessions.delete(key);
  }
});

app.get("/a/:slug/mcp", agencyAuth(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const agency = req.agency;
  const sessionKey = `${agency.slug}:${sessionId}`;

  if (sessionId && agencySessions.has(sessionKey)) {
    const transport = agencySessions.get(sessionKey);
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No active session" });
});

app.delete("/a/:slug/mcp", agencyAuth(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const agency = req.agency;
  const sessionKey = `${agency.slug}:${sessionId}`;

  if (sessionId && agencySessions.has(sessionKey)) {
    const transport = agencySessions.get(sessionKey);
    await transport.close();
    agencySessions.delete(sessionKey);
  }
  res.status(200).end();
});

// ── Agency management endpoints (admin) ──

app.get("/api/agencies/:slug/usage", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/agencies?slug=eq.${encodeURIComponent(req.params.slug)}&select=name,slug,tier,scans_used,scans_limit,active`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const rows = await resp.json();
    if (!rows?.[0]) return res.status(404).json({ error: "Agency not found" });

    const agency = rows[0];
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/scan_events?agency_id=eq.${agency.id}&select=created_at,url,combined_score,grade&order=created_at.desc&limit=20`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const events = await eventsResp.json();

    res.json({
      agency: { ...agency, usage_pct: Math.round((agency.scans_used / agency.scans_limit) * 100) },
      recent_scans: events,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AI Visibility Scanner MCP App running on :${PORT}`);
  console.log(`Default MCP: http://localhost:${PORT}/mcp`);
  console.log(`Agency MCP:  http://localhost:${PORT}/a/:slug/mcp?key=xxx`);
});
