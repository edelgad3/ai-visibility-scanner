// Deploy API — package build artifacts for delivery to client sites
// Methods: Edge injection, Automated PR, CMS Plugin
// Also: outbound webhooks, analytics, PDF reports

const { Router } = require("express");
const { z } = require("zod");
const { generatePackage } = require("./generators.js");

// ── Zod schemas for Deploy API ──
const DeployEdgeSchema = z.object({
  company_name: z.string().min(1, "company_name is required"),
  url: z.string().url("url must be a valid URL"),
  platform: z.enum(["cloudflare", "vercel"]).default("cloudflare"),
  tier: z.string().optional(),
}).passthrough();

const DeployPrSchema = z.object({
  company_name: z.string().min(1, "company_name is required"),
  url: z.string().url("url must be a valid URL"),
  repo_structure: z.enum(["nextjs", "static", "react"]).default("nextjs"),
  tier: z.string().optional(),
}).passthrough();

const DeployPluginSchema = z.object({
  company_name: z.string().min(1, "company_name is required"),
  url: z.string().url("url must be a valid URL"),
  cms: z.enum(["wordpress", "shopify"]).default("wordpress"),
  tier: z.string().optional(),
}).passthrough();

const RegisterWebhookSchema = z.object({
  url: z.string().url("url must be a valid URL"),
  events: z.array(z.enum(["scan.completed", "scan.failed", "build.ready", "usage.threshold"])).min(1, "events[] required"),
  secret: z.string().max(500).optional(),
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function createDeployApiRouter() {
  const router = Router();

  // ═══════════════════════════════════════════════════════════════════
  // DEPLOY ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════

  // POST /api/v1/build/deploy/edge — Generate Cloudflare/Vercel Edge Worker
  router.post("/api/v1/build/deploy/edge", (req, res) => {
    const parsed = DeployEdgeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { company_name, url, platform } = parsed.data;

    // Generate the artifacts first
    const pkg = generatePackage({ ...req.body, tier: req.body.tier || "forge" });

    // Build edge worker script
    let workerCode;
    if (platform === "cloudflare") {
      workerCode = generateCloudflareWorker(company_name, url, pkg.artifacts);
    } else if (platform === "vercel") {
      workerCode = generateVercelMiddleware(company_name, url, pkg.artifacts);
    } else {
      return res.status(400).json({ error: `Unsupported platform: ${platform}. Use: cloudflare, vercel` });
    }

    res.json({
      platform,
      worker: workerCode,
      artifacts: Object.fromEntries(
        Object.entries(pkg.artifacts).map(([k, v]) => [k, { filename: v.filename, size: v.content.length }])
      ),
      instructions: platform === "cloudflare"
        ? [
            "1. Go to Cloudflare Dashboard > Workers & Pages",
            "2. Create a new Worker",
            "3. Paste the worker code",
            "4. Add a route: client-domain.com/*",
            "5. Deploy and test",
          ]
        : [
            "1. Save as middleware.ts in the project root",
            "2. Add matcher config to next.config.js",
            "3. Deploy to Vercel",
          ],
    });
  });

  // POST /api/v1/build/deploy/pr — Generate files for a GitHub PR
  router.post("/api/v1/build/deploy/pr", (req, res) => {
    const parsed = DeployPrSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { company_name, url, repo_structure } = parsed.data;

    const pkg = generatePackage({ ...req.body, tier: req.body.tier || "forge" });
    const files = [];

    // Map artifacts to file paths based on repo structure
    const pathMap = {
      nextjs: { public: "public/", src: "src/", well_known: "public/.well-known/" },
      static: { public: "", src: "", well_known: ".well-known/" },
      react: { public: "public/", src: "src/", well_known: "public/.well-known/" },
    };
    const paths = pathMap[repo_structure] || pathMap.static;

    for (const [key, artifact] of Object.entries(pkg.artifacts)) {
      let filePath;
      if (artifact.filename.startsWith(".well-known/")) {
        filePath = paths.well_known + artifact.filename.replace(".well-known/", "");
      } else if (artifact.filename.endsWith(".html") && key !== "schema_org") {
        filePath = paths.src + artifact.filename;
      } else {
        filePath = paths.public + artifact.filename;
      }

      files.push({
        path: filePath,
        content: artifact.content,
        content_type: artifact.content_type,
        artifact_key: key,
      });
    }

    res.json({
      repo_structure,
      file_count: files.length,
      files,
      pr_title: `Add AI Visibility artifacts for ${company_name}`,
      pr_body: [
        `## AI Visibility Retrofit — ${company_name}`,
        "",
        "### Files Added",
        ...files.map(f => `- \`${f.path}\` (${f.artifact_key})`),
        "",
        "### What This Does",
        "- Makes your site discoverable by AI agents and LLMs",
        "- Adds structured data (Schema.org) for rich AI understanding",
        "- Registers agent capabilities via .well-known endpoints",
        "- Configures robots.txt for AI crawler access",
        "",
        `Generated by [Ethereal Forge](https://etherealmedia.ai)`,
      ].join("\n"),
      instructions: [
        "1. Create a feature branch: git checkout -b feat/ai-visibility",
        "2. Add each file to the paths listed above",
        "3. Commit and push",
        "4. Open PR with the provided title and body",
        "5. Review and merge",
      ],
    });
  });

  // POST /api/v1/build/deploy/plugin — Generate CMS plugin package
  router.post("/api/v1/build/deploy/plugin", (req, res) => {
    const parsed = DeployPluginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    }
    const { company_name, url, cms } = parsed.data;

    const pkg = generatePackage({ ...req.body, tier: req.body.tier || "forge" });

    let plugin;
    if (cms === "wordpress") {
      plugin = generateWordPressPlugin(company_name, url, pkg.artifacts);
    } else if (cms === "shopify") {
      plugin = generateShopifySnippet(company_name, url, pkg.artifacts);
    } else {
      return res.status(400).json({ error: `Unsupported CMS: ${cms}. Use: wordpress, shopify` });
    }

    res.json({
      cms,
      plugin,
      artifact_count: Object.keys(pkg.artifacts).length,
      instructions: cms === "wordpress"
        ? [
            "1. Save the PHP file as ethereal-forge-ai.php",
            "2. Upload via Plugins > Add New > Upload",
            "3. Activate the plugin",
            "4. Verify: visit /llms.txt and /.well-known/agent-card.json",
          ]
        : [
            "1. Go to Online Store > Themes > Edit Code",
            "2. Add the snippet to theme.liquid before </head>",
            "3. Save and preview",
          ],
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // OUTBOUND WEBHOOKS
  // ═══════════════════════════════════════════════════════════════════

  // POST /api/v1/webhooks — Register a webhook URL
  router.post("/api/v1/webhooks", async (req, res) => {
    const parsed = RegisterWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues.map(i => i.message).join("; "),
        available_events: ["scan.completed", "scan.failed", "build.ready", "usage.threshold"],
      });
    }
    const { url, events, secret } = parsed.data;

    const crypto = require("crypto");
    const webhookId = crypto.randomUUID();
    const webhookSecret = secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;

    // Store in Supabase if available, otherwise return for manual tracking
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/webhooks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ id: webhookId, url, events, secret_hash: crypto.createHash("sha256").update(webhookSecret).digest("hex") }),
        });
      } catch (e) {
        // Table may not exist yet — return config anyway
      }
    }

    res.status(201).json({
      id: webhookId,
      url,
      events,
      secret: webhookSecret,
      note: "Save this secret — webhook payloads include X-Signature (HMAC-SHA256) for verification",
    });
  });

  // GET /api/v1/webhooks — List registered webhooks (placeholder)
  router.get("/api/v1/webhooks", (_req, res) => {
    res.json({ webhooks: [], note: "Webhook management via API coming soon. Use POST to register." });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════

  // GET /api/v1/analytics/:scanId/overview — Agent vs human traffic summary
  router.get("/api/v1/analytics/:scanId/overview", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Analytics not configured" });
    }

    try {
      const scan = await fetchScan(req.params.scanId);
      if (!scan) return res.status(404).json({ error: "Scan not found" });

      // Pull agent events for this domain
      const domain = new URL(scan.url).hostname;
      const events = await fetchEvents(domain);

      const agentEvents = events.filter(e => e.source === "agent");
      const humanEvents = events.filter(e => e.source !== "agent");

      res.json({
        domain,
        scan_id: req.params.scanId,
        period: "last_30_days",
        traffic: {
          agent: agentEvents.length,
          human: humanEvents.length,
          total: events.length,
          agent_pct: events.length ? Math.round((agentEvents.length / events.length) * 100) : 0,
        },
        top_tools: aggregateTools(agentEvents),
        scan_grade: scan.grade,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/analytics/:scanId/conversions — Attribution
  router.get("/api/v1/analytics/:scanId/conversions", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Analytics not configured" });
    }

    try {
      const scan = await fetchScan(req.params.scanId);
      if (!scan) return res.status(404).json({ error: "Scan not found" });

      const domain = new URL(scan.url).hostname;
      const events = await fetchEvents(domain);

      const conversions = events.filter(e => e.event_type === "form_submit" || e.event_type === "purchase");
      const agentConversions = conversions.filter(e => e.source === "agent");

      res.json({
        domain,
        period: "last_30_days",
        conversions: {
          total: conversions.length,
          agent_attributed: agentConversions.length,
          human: conversions.length - agentConversions.length,
          agent_attribution_pct: conversions.length ? Math.round((agentConversions.length / conversions.length) * 100) : 0,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // REPORTS
  // ═══════════════════════════════════════════════════════════════════

  // GET /api/v1/scan/:id/report?format=pdf — PDF report
  // Note: Overrides the existing JSON-only report route in api.js when format=pdf
  router.get("/api/v1/reports/:scanId/pdf", async (req, res) => {
    // Generate a styled HTML report that can be printed as PDF
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      const scan = await fetchScan(req.params.scanId);
      if (!scan) return res.status(404).json({ error: "Scan not found" });
      if (scan.status !== "complete") return res.status(409).json({ error: "Scan not complete" });

      const results = typeof scan.results === "string" ? JSON.parse(scan.results) : scan.results;
      const html = generateReportHtml(scan, results);

      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Disposition", `inline; filename="scan-report-${req.params.scanId}.html"`);
      res.send(html);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/reports/:scanId/competitive — Competitive comparison
  router.get("/api/v1/reports/:scanId/competitive", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      const scan = await fetchScan(req.params.scanId);
      if (!scan) return res.status(404).json({ error: "Scan not found" });

      const results = typeof scan.results === "string" ? JSON.parse(scan.results) : scan.results;

      res.json({
        scan_id: req.params.scanId,
        client: results.client,
        scores: results.scores,
        competitors: results.competitors || [],
        note: results.competitors?.length
          ? "Competitive data included"
          : "No competitor data — submit competitor URLs via POST /api/v1/scan with compare_urls[]",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ═══════════════════════════════════════════════════════════════════
// EDGE WORKER GENERATORS
// ═══════════════════════════════════════════════════════════════════

function generateCloudflareWorker(companyName, siteUrl, artifacts) {
  const llmsTxt = artifacts.llms_txt?.content || "";
  const agentCard = artifacts.agent_card?.content || "{}";
  const ucpManifest = artifacts.ucp_manifest?.content || "{}";
  const schemaHtml = artifacts.schema_org?.content || "";
  const metaTags = artifacts.webmcp_meta?.content || "";

  return {
    filename: "ethereal-forge-worker.js",
    content: `// Ethereal Forge — AI Visibility Worker for ${companyName}
// Deploy as Cloudflare Worker on ${siteUrl}

const LLMS_TXT = ${JSON.stringify(llmsTxt)};
const AGENT_CARD = ${JSON.stringify(agentCard)};
const UCP_MANIFEST = ${JSON.stringify(ucpManifest)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve static AI files
    if (url.pathname === "/llms.txt") {
      return new Response(LLMS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/.well-known/agent-card.json") {
      return new Response(AGENT_CARD, { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/.well-known/ucp-manifest.json") {
      return new Response(UCP_MANIFEST, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Pass through to origin
    const response = await fetch(request);

    // Only modify HTML responses
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("text/html")) return response;

    // Inject Schema.org + WebMCP meta into HTML
    return new HTMLRewriter()
      .on("head", {
        element(el) {
          el.append(${JSON.stringify(metaTags + "\n" + schemaHtml)}, { html: true });
        }
      })
      .transform(response);
  }
};`,
    content_type: "application/javascript",
  };
}

function generateVercelMiddleware(companyName, siteUrl, artifacts) {
  const llmsTxt = artifacts.llms_txt?.content || "";
  const agentCard = artifacts.agent_card?.content || "{}";
  const ucpManifest = artifacts.ucp_manifest?.content || "{}";

  return {
    filename: "middleware.ts",
    content: `// Ethereal Forge — Vercel Edge Middleware for ${companyName}
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const LLMS_TXT = ${JSON.stringify(llmsTxt)};
const AGENT_CARD = ${JSON.stringify(agentCard)};
const UCP_MANIFEST = ${JSON.stringify(ucpManifest)};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/llms.txt") {
    return new NextResponse(LLMS_TXT, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/.well-known/agent-card.json") {
    return new NextResponse(AGENT_CARD, {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pathname === "/.well-known/ucp-manifest.json") {
    return new NextResponse(UCP_MANIFEST, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/llms.txt", "/.well-known/:path*"],
};`,
    content_type: "text/typescript",
  };
}

// ═══════════════════════════════════════════════════════════════════
// CMS PLUGIN GENERATORS
// ═══════════════════════════════════════════════════════════════════

function generateWordPressPlugin(companyName, siteUrl, artifacts) {
  const llmsTxt = (artifacts.llms_txt?.content || "").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const schemaHtml = (artifacts.schema_org?.content || "").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const agentCard = (artifacts.agent_card?.content || "{}").replace(/'/g, "\\'");

  return {
    filename: "ethereal-forge-ai.php",
    content: `<?php
/**
 * Plugin Name: Ethereal Forge AI Visibility
 * Description: AI Visibility artifacts for ${companyName} — llms.txt, Schema.org, agent-card.json
 * Version: 1.0.0
 * Author: Ethereal Media
 * Author URI: https://etherealmedia.ai
 */

defined('ABSPATH') or die('No direct access.');

// Serve llms.txt
add_action('init', function() {
  if ($_SERVER['REQUEST_URI'] === '/llms.txt') {
    header('Content-Type: text/plain; charset=utf-8');
    echo '${llmsTxt}';
    exit;
  }
  if ($_SERVER['REQUEST_URI'] === '/.well-known/agent-card.json') {
    header('Content-Type: application/json');
    echo '${agentCard}';
    exit;
  }
});

// Inject Schema.org JSON-LD into <head>
add_action('wp_head', function() {
  echo '${schemaHtml}';
});

// Add rewrite rules for .well-known
add_action('init', function() {
  add_rewrite_rule('^.well-known/agent-card.json$', 'index.php?ethereal_agent_card=1', 'top');
  add_rewrite_rule('^llms.txt$', 'index.php?ethereal_llms_txt=1', 'top');
});
?>`,
    content_type: "application/x-php",
  };
}

function generateShopifySnippet(companyName, siteUrl, artifacts) {
  const schemaHtml = artifacts.schema_org?.content || "";
  const metaTags = artifacts.webmcp_meta?.content || "";

  return {
    filename: "ethereal-forge-snippet.liquid",
    content: `{% comment %}
  Ethereal Forge AI Visibility — ${companyName}
  Add to theme.liquid before </head>
{% endcomment %}

${metaTags}

${schemaHtml}`,
    content_type: "text/plain",
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

async function fetchScan(scanId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/scans?id=eq.${scanId}&select=*&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await resp.json();
  return rows?.[0] || null;
}

async function fetchEvents(domain) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_events?domain=eq.${encodeURIComponent(domain)}&order=created_at.desc&limit=1000`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return await resp.json();
  } catch { return []; }
}

function aggregateTools(events) {
  const tools = {};
  for (const e of events) {
    const name = e.tool_name || "unknown";
    tools[name] = (tools[name] || 0) + 1;
  }
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, invocations: count }));
}

function generateReportHtml(scan, results) {
  const grade = results.scores?.combined?.grade || "?";
  const overall = results.scores?.combined?.overall || 0;
  const geo = results.scores?.ai_visibility?.geo || 0;
  const multi = results.scores?.ai_visibility?.multimodal || 0;
  const agent = results.scores?.ai_visibility?.agent_ready || 0;
  const mh = results.scores?.marketing_health?.overall || 0;

  const gradeColor = overall >= 80 ? "#22c55e" : overall >= 60 ? "#eab308" : overall >= 40 ? "#f97316" : "#ef4444";

  const findingsHtml = (results.findings?.p0 || []).map(f =>
    `<tr><td class="critical">P0</td><td>${esc(f.action)}</td><td>${esc(f.detail || "")}</td></tr>`
  ).concat((results.findings?.p1 || []).map(f =>
    `<tr><td class="important">P1</td><td>${esc(f.action)}</td><td>${esc(f.detail || "")}</td></tr>`
  )).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>AI Visibility Report — ${esc(results.client?.name || scan.url)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; }
  h1 { color: #6366f1; margin-bottom: 4px; }
  .grade { display: inline-block; font-size: 48px; font-weight: bold; color: ${gradeColor}; border: 3px solid ${gradeColor}; border-radius: 12px; padding: 8px 24px; margin: 16px 0; }
  .scores { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 24px 0; }
  .score-card { background: #f8f8fc; border: 1px solid #e2e2f0; border-radius: 8px; padding: 16px; text-align: center; }
  .score-card .value { font-size: 28px; font-weight: bold; color: #6366f1; }
  .score-card .label { font-size: 13px; color: #666; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px; }
  th { background: #f8f8fc; font-weight: 600; }
  .critical { color: #ef4444; font-weight: bold; }
  .important { color: #f97316; font-weight: bold; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 13px; text-align: center; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1>AI Visibility Report</h1>
<p>${esc(results.client?.name || "")} — ${esc(results.client?.url || scan.url)}</p>
<p>Scanned: ${scan.completed_at ? new Date(scan.completed_at).toLocaleDateString() : "N/A"} | Tier: ${esc(scan.tier)} | Pages: ${results.metadata?.pages_scanned || "?"}</p>

<div class="grade">${esc(grade)}</div>
<span style="font-size:24px; margin-left:12px">${overall}/100</span>

<div class="scores">
  <div class="score-card"><div class="value">${geo}</div><div class="label">GEO Score</div></div>
  <div class="score-card"><div class="value">${multi}</div><div class="label">Multimodal</div></div>
  <div class="score-card"><div class="value">${agent}</div><div class="label">Agent-Ready</div></div>
  <div class="score-card"><div class="value">${mh}</div><div class="label">Marketing Health</div></div>
</div>

<h2>Findings</h2>
<table>
<tr><th>Priority</th><th>Action</th><th>Detail</th></tr>
${findingsHtml || "<tr><td colspan='3'>No critical findings</td></tr>"}
</table>

<div class="footer">
  Generated by <strong>Ethereal Forge</strong> — <a href="https://etherealmedia.ai">etherealmedia.ai</a>
</div>
</body></html>`;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = { createDeployApiRouter };
