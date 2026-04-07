// Build API — generate deployable artifacts from scan data + client config
// Endpoints: POST /api/v1/build/geo/*, /api/v1/build/protocol/*, /api/v1/build/webmcp/*
// All endpoints accept JSON input and return generated file content

const { Router } = require("express");
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

function createBuildApiRouter() {
  const router = Router();

  // Shared validation
  function requireFields(body, fields) {
    const missing = fields.filter(f => !body[f]);
    if (missing.length) return `Missing required fields: ${missing.join(", ")}`;
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // GEO LAYER
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/geo/llms-txt", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateLlmsTxt(req.body));
  });

  router.post("/api/v1/build/geo/llms-full-txt", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateLlmsFullTxt(req.body));
  });

  router.post("/api/v1/build/geo/robots-txt", (req, res) => {
    const err = requireFields(req.body, ["url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateRobotsTxt(req.body));
  });

  router.post("/api/v1/build/geo/sitemap", (req, res) => {
    const err = requireFields(req.body, ["domain"]);
    if (err) return res.status(400).json({ error: err });
    if (!req.body.pages?.length) {
      return res.status(400).json({ error: "pages[] is required (array of {path, priority?, changefreq?})" });
    }
    res.json(generateSitemapXml(req.body));
  });

  router.post("/api/v1/build/geo/schema", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateSchemaOrg(req.body));
  });

  router.post("/api/v1/build/geo/semantic-audit", (req, res) => {
    // Return semantic findings from scan results
    const { scan_results } = req.body;
    if (!scan_results?.checks?.aeo) {
      return res.status(400).json({ error: "scan_results with checks.aeo data required" });
    }
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
    const { scan_results } = req.body;
    if (!scan_results?.checks?.aeo) {
      return res.status(400).json({ error: "scan_results with checks.aeo data required" });
    }
    const aeo = scan_results.checks.aeo;
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
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateAgentCard(req.body));
  });

  router.post("/api/v1/build/protocol/ucp-manifest", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateUcpManifest(req.body));
  });

  router.post("/api/v1/build/protocol/ap2", (req, res) => {
    // AP2 authorization scaffolding — generates OAuth2 config skeleton
    const { company_name, url, scopes } = req.body;
    if (!company_name || !url) {
      return res.status(400).json({ error: "company_name and url required" });
    }
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
    if (!req.body.forms?.length) {
      return res.status(400).json({
        error: "forms[] required",
        example: { forms: [{ name: "contact", fields: [{ name: "email", type: "email", required: true }] }] },
      });
    }
    res.json(generateWebmcpForms(req.body));
  });

  router.post("/api/v1/build/webmcp/tools", (req, res) => {
    const err = requireFields(req.body, ["company_name"]);
    if (err) return res.status(400).json({ error: err });
    if (!req.body.tools?.length) {
      return res.status(400).json({
        error: "tools[] required",
        example: { tools: [{ name: "get_info", description: "Get business info", endpoint: "/api/info" }] },
      });
    }
    res.json(generateWebmcpTools(req.body));
  });

  router.post("/api/v1/build/webmcp/meta", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generateWebmcpMeta(req.body));
  });

  // ═══════════════════════════════════════════════════════════════════
  // PACKAGE — Bundle all artifacts
  // ═══════════════════════════════════════════════════════════════════

  router.post("/api/v1/build/package", (req, res) => {
    const err = requireFields(req.body, ["company_name", "url"]);
    if (err) return res.status(400).json({ error: err });
    res.json(generatePackage(req.body));
  });

  return router;
}

module.exports = { createBuildApiRouter };
