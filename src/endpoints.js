const axios = require('axios');

async function checkEndpoint(baseUrl, path) {
  try {
    const url = new URL(path, baseUrl).href;
    const response = await axios.get(url, { timeout: 10000, validateStatus: () => true });

    if (response.status === 200) {
      return {
        exists: true,
        content: typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      };
    }
    return { exists: false, content: null };
  } catch (error) {
    return { exists: false, content: null };
  }
}

module.exports = { probeEndpoints };

async function probeEndpoints(baseUrl) {
  const results = {
    robots: { exists: false, has_sitemap_reference: false, ai_crawler_rules: [], ai_crawlers_mentioned: false, content_preview: "" },
    sitemap: { exists: false, url_count: 0 },
    llms_txt: { exists: false, length: 0, preview: "" },
    llms_full_txt: { exists: false, length: 0, preview: "" },
    agent_card: { exists: false, declares_ap2: false, declares_mcp: false, capabilities: [] },
    ucp: { exists: false },
    ap2: { exists: false, source: null, version: null },
    a2ui: { exists: false, version: null },
    ag_ui: { exists: false, version: null },
    acp: { exists: false, version: null },
    anp: { exists: false, has_did: false }
  };

  // Launch all requests concurrently.
  // Per Client-Install-Components spec (2026-04): UCP lives at
  // /.well-known/ucp-manifest.json (not /.well-known/ucp) and AP2 mandates
  // live at /.well-known/ap2-mandates.json. AP2 may additionally be declared
  // as a capability in agent-card.json, which we detect below.
  const [
    robotsRes,
    sitemapRes,
    llmsRes,
    llmsFullRes,
    agentCardRes,
    ucpRes,
    ucpLegacyRes,
    ap2Res,
    a2uiRes,
    agUiRes,
    acpRes,
    anpRes,
    didRes
  ] = await Promise.all([
    checkEndpoint(baseUrl, '/robots.txt'),
    checkEndpoint(baseUrl, '/sitemap.xml'),
    checkEndpoint(baseUrl, '/llms.txt'),
    checkEndpoint(baseUrl, '/llms-full.txt'),
    checkEndpoint(baseUrl, '/.well-known/agent-card.json'),
    checkEndpoint(baseUrl, '/.well-known/ucp-manifest.json'),
    checkEndpoint(baseUrl, '/.well-known/ucp'),
    checkEndpoint(baseUrl, '/.well-known/ap2-mandates.json'),
    checkEndpoint(baseUrl, '/.well-known/a2ui-config.json'),
    checkEndpoint(baseUrl, '/.well-known/agui-manifest.json'),
    checkEndpoint(baseUrl, '/.well-known/acp.json'),
    checkEndpoint(baseUrl, '/.well-known/anp.json'),
    checkEndpoint(baseUrl, '/.well-known/did.json')
  ]);

  // 1. Process robots.txt
  if (robotsRes.exists) {
    results.robots.exists = true;
    results.robots.content_preview = robotsRes.content.substring(0, 500);
    results.robots.has_sitemap_reference = /sitemap:/i.test(robotsRes.content);

    const lines = robotsRes.content.split('\n');
    for (const line of lines) {
      if (/user-agent:.*(gptbot|chatgpt-user|claudebot|perplexitybot|oai-searchbot|google-extended)/i.test(line)) {
        results.robots.ai_crawler_rules.push(line.trim());
      }
    }
    results.robots.ai_crawlers_mentioned = results.robots.ai_crawler_rules.length > 0;
  }

  // 2. Process sitemap.xml
  if (sitemapRes.exists) {
    results.sitemap.exists = true;
    const matches = sitemapRes.content.match(/<url>|<loc>/gi);
    results.sitemap.url_count = matches ? matches.length : 0;
  }

  // 3. Process llms.txt
  if (llmsRes.exists) {
    results.llms_txt.exists = true;
    results.llms_txt.length = llmsRes.content.length;
    results.llms_txt.preview = llmsRes.content.substring(0, 300);
  }

  // 4. Process llms-full.txt
  if (llmsFullRes.exists) {
    results.llms_full_txt.exists = true;
    results.llms_full_txt.length = llmsFullRes.content.length;
    results.llms_full_txt.preview = llmsFullRes.content.substring(0, 300);
  }

  // 5. Agent Card — primary A2A discovery, and also the canonical place to
  // declare AP2/MCP/UCP capabilities when the client is using the bundled
  // approach instead of separate /.well-known files.
  if (agentCardRes.exists) {
    results.agent_card.exists = true;
    try {
      const parsed = JSON.parse(agentCardRes.content);

      // Capabilities can appear in two shapes:
      //   1. A2A spec:  { capabilities: { tools: [{name, description, ...}], ... } }
      //   2. Flat form: { capabilities: ["ap2.payment", "mcp", ...] }
      // Collect names from both.
      const names = [];
      if (Array.isArray(parsed.capabilities)) {
        for (const c of parsed.capabilities) {
          if (typeof c === 'string') names.push(c.toLowerCase());
          else if (c && c.name) names.push(String(c.name).toLowerCase());
        }
      } else if (parsed.capabilities && typeof parsed.capabilities === 'object') {
        const tools = parsed.capabilities.tools;
        if (Array.isArray(tools)) {
          for (const t of tools) {
            if (t && t.name) names.push(String(t.name).toLowerCase());
          }
        }
      }
      // Also accept top-level tools[] (seen in some agent-card dialects).
      if (Array.isArray(parsed.tools)) {
        for (const t of parsed.tools) {
          if (t && t.name) names.push(String(t.name).toLowerCase());
        }
      }

      results.agent_card.capabilities = names;

      const allText = JSON.stringify(parsed).toLowerCase();
      const hasAp2 =
        names.some((c) => c.includes('ap2') || c.includes('payment') || c.includes('mandate')) ||
        !!(parsed.ap2 || parsed.mandates || (parsed.endpoints && (parsed.endpoints.ap2 || parsed.endpoints.payments))) ||
        /\bap2\b/.test(allText);
      const hasMcp =
        names.some((c) => c === 'mcp' || c.startsWith('mcp.') || c.startsWith('mcp_')) ||
        !!(parsed.mcp || (parsed.endpoints && parsed.endpoints.mcp));
      results.agent_card.declares_ap2 = hasAp2;
      results.agent_card.declares_mcp = hasMcp;
    } catch {
      // Non-JSON agent-card — leave capability flags false.
    }
  }

  // 6. UCP Manifest — try the spec path first, fall back to the legacy path.
  if (ucpRes.exists) {
    results.ucp.exists = true;
    results.ucp.source = 'ucp-manifest.json';
  } else if (ucpLegacyRes.exists) {
    results.ucp.exists = true;
    results.ucp.source = 'ucp';
  }

  // 7. AP2 Mandates — endpoint OR agent-card capability declaration.
  if (ap2Res.exists) {
    results.ap2.exists = true;
    results.ap2.source = 'ap2-mandates.json';
    try {
      const parsed = JSON.parse(ap2Res.content);
      results.ap2.version = parsed.version || parsed.ap2_version || null;
    } catch {}
  } else if (results.agent_card.declares_ap2) {
    results.ap2.exists = true;
    results.ap2.source = 'agent-card-capability';
  }

  // 8. A2UI (Google Agent-to-UI Protocol)
  if (a2uiRes.exists) {
    results.a2ui.exists = true;
    try {
      const parsed = JSON.parse(a2uiRes.content);
      results.a2ui.version = parsed.version || parsed.a2ui_version || null;
    } catch {}
  }

  // 9. AG-UI (CopilotKit Agent-User Interaction Protocol)
  if (agUiRes.exists) {
    results.ag_ui.exists = true;
    try {
      const parsed = JSON.parse(agUiRes.content);
      results.ag_ui.version = parsed.version || null;
    } catch {}
  }

  // 10. ACP (Agent Communication Protocol — RESTful)
  if (acpRes.exists) {
    results.acp.exists = true;
    try {
      const parsed = JSON.parse(acpRes.content);
      results.acp.version = parsed.version || null;
    } catch {}
  }

  // 11. ANP (Agent Network Protocol — W3C DIDs)
  if (anpRes.exists) {
    results.anp.exists = true;
  }
  if (didRes.exists) {
    results.anp.has_did = true;
    if (!results.anp.exists) results.anp.exists = true; // DID document implies ANP readiness
  }

  return results;
}
