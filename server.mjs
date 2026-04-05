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
} = require("./src/scoring.js");

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

// ── MCP Server Factory (new instance per session) ──
function createServer() {
  const server = new McpServer({
    name: "ai-visibility-scanner",
    version: "1.0.0",
  });

  // Register UI resource
  registerAppResource(
    server,
    "Scanner Dashboard",
    RESOURCE_URI,
    { description: "Interactive AI Visibility Scanner dashboard" },
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: DASHBOARD_HTML,
      }],
    })
  );

  // Main tool: scan_website (visible to model + app)
  registerAppTool(
    server,
    "scan_website",
    {
      description: "Scan any website for AI visibility and marketing health. Returns scores for GEO (Generative Engine Optimization), Multimodal readiness, Agent-Ready infrastructure, and 6-dimension Marketing Health. Identifies critical findings with prioritized fix recommendations and revenue impact estimates.",
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
      const results = await performScan(url, max_pages, industry);
      return buildScanResponse(results);
    }
  );

  // App-only tool: refresh_scan (hidden from model, callable from UI)
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
      const results = await performScan(url, max_pages);
      return buildScanResponse(results);
    }
  );

  return server;
}

// ── Express Server with Streamable HTTP Transport ──
const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "AI Visibility Scanner",
    version: "1.0.0",
    description: "Scan websites for AI visibility and marketing health",
    mcp_endpoint: "/mcp",
  });
});

// MCP endpoint — session management
const sessions = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions.has(sessionId)) {
    // Existing session: reuse transport
    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session: create server + transport, handle request, then store session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const mcpServer = createServer();
  await mcpServer.connect(transport);

  // Store session after transport generates its ID during handleRequest
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
    transport.onclose = () => sessions.delete(transport.sessionId);
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No active session" });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AI Visibility Scanner MCP App running on :${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
