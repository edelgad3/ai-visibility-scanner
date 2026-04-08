// Build API — generate deployable artifacts from scan data + client config
// Endpoints: POST /api/v1/build/geo/*, /api/v1/build/protocol/*, /api/v1/build/webmcp/*
// All endpoints accept JSON input and return generated file content

const { Router } = require("express");
const { z } = require("zod");
const {
  generateLlmsTxt,
  generateLlmsFullTxt,
  generateRobotsTxt,
  generateSitemapXml,
  generateSchemaOrg,
  generateAgentCard,
  generateUcpManifest,
  generateWebmcpForms,
  generateWebmcpTools,
  generateWebmcpMeta,
  generatePackage,
} = require("./generators.js");

// ── Zod schemas for Build API ──
const CompanyUrlSchema = z.object({
  company_name: z.string().min(1, "company_name is required").max(500),
  url: z.string().url("url must be a valid URL"),
}).passthrough(); // allow additional fields through

const UrlOnlySchema = z.object({
  url: z.string().url("url must be a valid URL"),
}).passthrough();

const DomainPagesSchema = z.object({
  domain: z.string().min(1, "domain is required").max(500),
  pages: z.array(z.object({
    path: z.string(),
    priority: z.number().optional(),
    changefreq: z.string().optional(),
  })).min(1, "pages[] is required (array of {path, priority?, changefreq?})"),
}).passthrough();

const ScanResultsSchema = z.object({
  scan_results: z.object({
    checks: z.object({
      aeo: z.record(z.any()),
    }),
  }),
});

const WebmcpFormsSchema = z.object({
  forms: z.array(z.object({
    name: z.string(),
    fields: z.array(z.any()).optional(),
  })).min(1, "forms[] required"),
}).passthrough();

const WebmcpToolsSchema = z.object({
  company_name: z.string().min(1, "company_name is required"),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    endpoint: z.string().optional(),
  })).min(1, "tools[] required"),
}).passthrough();

const Ap2Schema = z.object({
  company_name: z.string().min(1, "company_name is required"),
  url: z.string().url("url must be a valid URL"),
  scopes: z.array(z.string()).optional(),
});

// Helper to run Zod validation and return 400 on failure
function zodValidate(schema, req, res) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    return null;
  }
  return parsed.data;
}

function createBuildApiRouter() {
  const router = Router();

  // ═══════════════════════════════════════════════════════════════════
  // GEO LAYER
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/geo/llms-txt", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateLlmsTxt(data));
  });

  router.post("/api/v1/build/geo/llms-full-txt", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateLlmsFullTxt(data));
  });

  router.post("/api/v1/build/geo/robots-txt", (req, res) => {
    const data = zodValidate(UrlOnlySchema, req, res);
    if (!data) return;
    res.json(generateRobotsTxt(data));
  });

  router.post("/api/v1/build/geo/sitemap", (req, res) => {
    const data = zodValidate(DomainPagesSchema, req, res);
    if (!data) return;
    res.json(generateSitemapXml(data));
  });

  router.post("/api/v1/build/geo/schema", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateSchemaOrg(data));
  });

  router.post("/api/v1/build/geo/semantic-audit", (req, res) => {
    const data = zodValidate(ScanResultsSchema, req, res);
    if (!data) return;
    const { scan_results } = data;
    const aeo = scan_results.checks.aeo;
    const issues = [];
    if (!aeo.has_main) issues.push({ element: "<main>", severity: "high", fix: "Wrap primary content in a <main> tag" });
    if (!aeo.has_article && !aeo.has_section) issues.push({ element: "<article>/<section>", severity: "high", fix: "Use <article> or <section> tags for content blocks" });
    if (!aeo.has_nav) issues.push({ element: "<nav>", severity: "medium", fix: "Wrap navigation in a <nav> tag" });
    if (!aeo.has_header) issues.push({ element: "<header>", severity: "medium", fix: "Add a <header> tag for page header" });
    if (!aeo.has_footer) issues.push({ element: "<footer>", severity: "medium", fix: "Add a <footer> tag for page footer" });
    if (aeo.semantic_score < 3) issues.push({ element: "general", severity: "high", fix: "Semantic HTML score is very low — restructure page with proper landmark tags" });
    if (aeo.aria_count === 0) issues.push({ element: "aria-*", severity: "high", fix: "Add ARIA labels to interactive elements (buttons, forms, menus)" });
    if (aeo.interactive_without_aria > 3) issues.push({ element: "aria-label", severity: "medium", fix: `${aeo.interactive_without_aria} interactive elements missing accessible names` });

    res.json({
      semantic_score: aeo.semantic_score,
      aria_count: aeo.aria_count,
      issues,
      issue_count: issues.length,
    });
  });

  router.post("/api/v1/build/geo/aria-audit", (req, res) => {
    const data = zodValidate(ScanResultsSchema, req, res);
    if (!data) return;
    const aeo = data.scan_results.checks.aeo;
    const recommendations = [];

    if (aeo.aria_count === 0) {
      recommendations.push({ priority: "critical", action: "Add aria-label to all interactive elements", detail: "No ARIA attributes detected" });
    }
    if (aeo.interactive_without_aria > 0) {
      recommendations.push({ priority: "high", action: `Add aria-label to ${aeo.interactive_without_aria} unlabeled elements`, detail: "Buttons, links, and inputs need accessible names for AI agents" });
    }
    if (!aeo.has_declarative_webmcp && aeo.form_count > 0) {
      recommendations.push({ priority: "critical", action: "Add WebMCP form attributes", detail: `${aeo.form_count} forms without toolname/tooldescription — AI agents can't use them` });
    }

    res.json({
      aria_count: aeo.aria_count,
      interactive_without_aria: aeo.interactive_without_aria,
      form_count: aeo.form_count,
      has_webmcp: aeo.has_declarative_webmcp,
      recommendations,
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PROTOCOL LAYER
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/protocol/agent-card", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateAgentCard(data));
  });

  router.post("/api/v1/build/protocol/ucp-manifest", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateUcpManifest(data));
  });

  router.post("/api/v1/build/protocol/ap2", (req, res) => {
    const data = zodValidate(Ap2Schema, req, res);
    if (!data) return;
    const { company_name, url, scopes } = data;
    const config = {
      issuer: url,
      authorization_endpoint: `${url.replace(/\/$/, "")}/auth/authorize`,
      token_endpoint: `${url.replace(/\/$/, "")}/auth/token`,
      scopes_supported: scopes || ["read", "write", "agent"],
      response_types_supported: ["code", "token"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      registration_endpoint: `${url.replace(/\/$/, "")}/auth/register`,
    };

    res.json({
      content: JSON.stringify(config, null, 2),
      filename: ".well-known/oauth-authorization-server",
      content_type: "application/json",
      note: "This is a scaffold — implement the actual OAuth2 endpoints to match this config",
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // WEBMCP LAYER
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/webmcp/forms", (req, res) => {
    const data = zodValidate(WebmcpFormsSchema, req, res);
    if (!data) return;
    res.json(generateWebmcpForms(data));
  });

  router.post("/api/v1/build/webmcp/tools", (req, res) => {
    const data = zodValidate(WebmcpToolsSchema, req, res);
    if (!data) return;
    res.json(generateWebmcpTools(data));
  });

  router.post("/api/v1/build/webmcp/meta", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generateWebmcpMeta(data));
  });

  // ═══════════════════════════════════════════════════════════════════
  // PACKAGE — Bundle all artifacts
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/package", (req, res) => {
    const data = zodValidate(CompanyUrlSchema, req, res);
    if (!data) return;
    res.json(generatePackage(data));
  });

  return router;
}

module.exports = { createBuildApiRouter };
