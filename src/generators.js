// Artifact generators — produce deployable files from scan data + client info
// Each generator takes structured input and returns { content, filename, content_type }

// ═══════════════════════════════════════════════════════════════════════
// GEO LAYER
// ═══════════════════════════════════════════════════════════════════════

function generateLlmsTxt({ company_name, url, industry, description, services, differentiators, email, phone, locations }) {
  const lines = [
    `# ${company_name}`,
    "",
    `> ${description || `${company_name} provides professional ${industry} services.`}`,
    "",
    "## About",
    "",
    `${company_name} is a ${industry} company${services?.length ? ` specializing in ${services.slice(0, 3).map(s => typeof s === "string" ? s : s.name).join(", ")}` : ""}. ${differentiators?.length ? `Key differentiators include ${differentiators.slice(0, 3).join(", ")}.` : ""}`,
    "",
  ];

  if (services?.length) {
    lines.push("## Services", "");
    for (const svc of services) {
      if (typeof svc === "string") {
        lines.push(`- ${svc}`);
      } else {
        lines.push(`### ${svc.name}`);
        if (svc.description) lines.push(svc.description);
        if (svc.price) lines.push(`Price: ${svc.price}`);
        lines.push("");
      }
    }
    lines.push("");
  }

  if (differentiators?.length) {
    lines.push("## Key Differentiators", "");
    for (const d of differentiators) lines.push(`- ${d}`);
    lines.push("");
  }

  lines.push("## Contact", "");
  if (email) lines.push(`Email: ${email}`);
  if (phone) lines.push(`Phone: ${phone}`);
  lines.push(`Website: ${url}`);

  if (locations?.length) {
    lines.push("", "## Locations", "");
    for (const loc of locations) lines.push(`- ${loc}`);
  }

  lines.push("");
  return { content: lines.join("\n"), filename: "llms.txt", content_type: "text/plain" };
}

function generateLlmsFullTxt({ company_name, url, industry, description, services, differentiators, email, phone, faqs, blog_posts, case_studies, tech_stack }) {
  const lines = [
    `# ${company_name} — Complete Business Context`,
    "",
    `> ${description || `${company_name} provides professional ${industry} services.`}`,
    "",
    "## About",
    "",
    `${company_name} is a ${industry} company. ${differentiators?.length ? `What sets them apart: ${differentiators.join("; ")}.` : ""}`,
    "",
  ];

  if (services?.length) {
    lines.push("## Services", "");
    for (const svc of services) {
      if (typeof svc === "string") {
        lines.push(`- ${svc}`);
      } else {
        lines.push(`### ${svc.name}`);
        if (svc.description) lines.push(svc.description);
        if (svc.price) lines.push(`- **Price:** ${svc.price}`);
        if (svc.features?.length) {
          lines.push("- **Includes:**");
          for (const f of svc.features) lines.push(`  - ${f}`);
        }
        lines.push("");
      }
    }
  }

  if (faqs?.length) {
    lines.push("## Frequently Asked Questions", "");
    for (const faq of faqs) {
      lines.push(`### ${faq.question}`);
      lines.push(faq.answer);
      lines.push("");
    }
  }

  if (blog_posts?.length) {
    lines.push("## Recent Articles", "");
    for (const post of blog_posts) {
      lines.push(`- [${post.title}](${post.url || "#"})${post.summary ? ` — ${post.summary}` : ""}`);
    }
    lines.push("");
  }

  if (case_studies?.length) {
    lines.push("## Case Studies", "");
    for (const cs of case_studies) {
      lines.push(`### ${cs.title}`);
      if (cs.summary) lines.push(cs.summary);
      if (cs.result) lines.push(`**Result:** ${cs.result}`);
      lines.push("");
    }
  }

  if (tech_stack?.length) {
    lines.push("## Technical Infrastructure", "");
    for (const t of tech_stack) lines.push(`- ${t}`);
    lines.push("");
  }

  lines.push("## Contact", "");
  if (email) lines.push(`- Email: ${email}`);
  if (phone) lines.push(`- Phone: ${phone}`);
  lines.push(`- Website: ${url}`);
  lines.push("");

  return { content: lines.join("\n"), filename: "llms-full.txt", content_type: "text/plain" };
}

function generateRobotsTxt({ url, allow_ai = true, sitemap = true, disallow_paths = [] }) {
  const domain = url.replace(/\/$/, "");
  const lines = ["# robots.txt", `# Generated for ${domain}`, ""];

  // Default rules
  lines.push("User-agent: *", "Allow: /");
  if (disallow_paths.length) {
    for (const p of disallow_paths) lines.push(`Disallow: ${p}`);
  } else {
    lines.push("Disallow: /admin", "Disallow: /staging", "Disallow: /api/");
  }
  lines.push("");

  // AI crawler rules
  if (allow_ai) {
    const crawlers = [
      "GPTBot", "ChatGPT-User", "ClaudeBot", "Claude-Web",
      "PerplexityBot", "Google-Extended", "CCBot",
      "Amazonbot", "OAI-SearchBot"
    ];
    for (const bot of crawlers) {
      lines.push(`User-agent: ${bot}`, "Allow: /", "");
    }
  }

  // Sitemap + llms.txt references
  if (sitemap) {
    lines.push(`Sitemap: ${domain}/sitemap.xml`);
  }
  lines.push(`# AI Context: ${domain}/llms.txt`);
  lines.push(`# Extended Context: ${domain}/llms-full.txt`);
  lines.push("");

  return { content: lines.join("\n"), filename: "robots.txt", content_type: "text/plain" };
}

function generateSitemapXml({ domain, pages }) {
  const d = domain.replace(/\/$/, "");
  const now = new Date().toISOString().split("T")[0];

  const urls = pages.map(p => {
    const loc = p.url || `${d}${p.path || "/"}`;
    const priority = p.priority || (p.path === "/" || p.path === "" ? "1.0" : "0.8");
    const changefreq = p.changefreq || "weekly";
    return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${p.lastmod || now}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
  ].join("\n");

  return { content: xml, filename: "sitemap.xml", content_type: "application/xml" };
}

function generateSchemaOrg({ company_name, url, industry, description, services, email, phone, address, faqs }) {
  const schemas = {};

  // Organization / LocalBusiness
  const orgType = address ? "LocalBusiness" : "Organization";
  const org = {
    "@context": "https://schema.org",
    "@type": orgType,
    name: company_name,
    url,
    description: description || `${company_name} — ${industry} services`,
  };
  if (email) {
    org.email = email;
    org.contactPoint = { "@type": "ContactPoint", email, contactType: "sales", availableLanguage: "English" };
  }
  if (phone) org.telephone = phone;
  if (address) org.address = { "@type": "PostalAddress", ...address };
  schemas.Organization = org;

  // Service schemas
  if (services?.length) {
    for (const svc of services) {
      const name = typeof svc === "string" ? svc : svc.name;
      const desc = typeof svc === "string" ? "" : svc.description || "";
      const s = {
        "@context": "https://schema.org",
        "@type": "Service",
        serviceType: name,
        name,
        description: desc,
        provider: { "@type": "Organization", name: company_name, url },
      };
      if (svc.price) {
        s.offers = { "@type": "Offer", price: String(svc.price), priceCurrency: "USD" };
      }
      schemas[`Service_${name.replace(/\s+/g, "_")}`] = s;
    }
  }

  // WebPage with speakable
  schemas.WebPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: company_name,
    url,
    description: description || `${company_name} — ${industry} services`,
    speakable: { "@type": "SpeakableSpecification", cssSelector: ["h1", "h2", ".hero-sub"] },
  };

  // FAQPage
  if (faqs?.length) {
    schemas.FAQPage = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map(q => ({
        "@type": "Question",
        name: q.question,
        acceptedAnswer: { "@type": "Answer", text: q.answer },
      })),
    };
  }

  // Format as HTML script tags
  const htmlBlocks = Object.entries(schemas)
    .map(([name, schema]) => `<!-- Schema.org: ${name} -->\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`)
    .join("\n\n");

  return {
    content: htmlBlocks,
    filename: "schema.jsonld.html",
    content_type: "text/html",
    schemas,
    schema_count: Object.keys(schemas).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PROTOCOL LAYER
// ═══════════════════════════════════════════════════════════════════════

function generateAgentCard({ company_name, url, description, services, email, version = "1.0.0" }) {
  // Generate tools from services
  const tools = [];

  // Default tools every business should have
  tools.push({
    name: "get_business_info",
    description: `Get information about ${company_name} including services, hours, and contact details`,
    inputSchema: { type: "object", properties: {}, required: [] },
  });

  tools.push({
    name: "get_services",
    description: `List all services offered by ${company_name}`,
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "Filter by service category" } },
    },
  });

  // Generate tools from services
  if (services?.length) {
    tools.push({
      name: "get_service_details",
      description: "Get detailed information about a specific service including pricing and features",
      inputSchema: {
        type: "object",
        properties: {
          service_name: {
            type: "string",
            description: "Name of the service",
            enum: services.map(s => typeof s === "string" ? s : s.name),
          },
        },
        required: ["service_name"],
      },
    });
  }

  tools.push({
    name: "contact_request",
    description: `Submit a contact request or inquiry to ${company_name}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
        email: { type: "string", description: "Your email" },
        message: { type: "string", description: "Your message or inquiry" },
        service_interest: { type: "string", description: "Service you're interested in" },
      },
      required: ["name", "email", "message"],
    },
  });

  tools.push({
    name: "check_availability",
    description: "Check availability for a consultation or service appointment",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        preferred_date: { type: "string", description: "Preferred date (YYYY-MM-DD)" },
      },
    },
  });

  const card = {
    name: company_name,
    description: description || `${company_name} — AI-ready business agent`,
    url,
    version,
    capabilities: { tools },
    provider: { organization: company_name, url },
    authentication: { type: "none", description: "Public agent — no authentication required" },
    documentation: `${url.replace(/\/$/, "")}/llms-full.txt`,
  };

  return {
    content: JSON.stringify(card, null, 2),
    filename: ".well-known/agent-card.json",
    content_type: "application/json",
    tool_count: tools.length,
  };
}

function generateUcpManifest({ company_name, url, services, currency = "USD" }) {
  const offerings = (services || []).filter(s => s.price).map(svc => ({
    id: (svc.name || "service").toLowerCase().replace(/\s+/g, "-"),
    name: svc.name,
    description: svc.description || "",
    price: { amount: svc.price, currency },
    type: "service",
    fulfillment: "manual",
    endpoint: `${url.replace(/\/$/, "")}/api/purchase`,
  }));

  const manifest = {
    name: company_name,
    url,
    version: "1.0.0",
    protocol: "ucp",
    capabilities: { purchase: offerings.length > 0, quote: true, inquiry: true },
    offerings,
    contact: { url: `${url.replace(/\/$/, "")}/contact`, method: "form" },
  };

  return {
    content: JSON.stringify(manifest, null, 2),
    filename: ".well-known/ucp-manifest.json",
    content_type: "application/json",
    offering_count: offerings.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// WEBMCP LAYER
// ═══════════════════════════════════════════════════════════════════════

function generateWebmcpForms({ forms }) {
  // Takes existing form definitions and adds WebMCP declarative attributes
  if (!forms?.length) {
    return {
      content: "<!-- No forms provided to enhance -->",
      filename: "webmcp-forms.html",
      content_type: "text/html",
      forms_enhanced: 0,
    };
  }

  const enhanced = forms.map(form => {
    const toolname = form.toolname || form.action?.replace(/[^a-z0-9_]/gi, "_") || "form_submit";
    const tooldesc = form.tooldescription || `Submit the ${form.name || "contact"} form`;

    let html = `<form`;
    html += ` toolname="${escapeAttr(toolname)}"`;
    html += ` tooldescription="${escapeAttr(tooldesc)}"`;
    if (form.action) html += ` action="${escapeAttr(form.action)}"`;
    html += ` method="${form.method || "POST"}"`;
    html += ` role="form"`;
    html += ` aria-label="${escapeAttr(tooldesc)}"`;
    html += `>\n`;

    for (const field of form.fields || []) {
      const paramDesc = field.description || `Enter your ${field.name}`;
      html += `  <label for="${escapeAttr(field.name)}">${field.label || field.name}</label>\n`;
      html += `  <input`;
      html += ` type="${field.type || "text"}"`;
      html += ` name="${escapeAttr(field.name)}"`;
      html += ` id="${escapeAttr(field.name)}"`;
      html += ` toolparamdescription="${escapeAttr(paramDesc)}"`;
      if (field.required) html += ` required`;
      if (field.placeholder) html += ` placeholder="${escapeAttr(field.placeholder)}"`;
      html += ` />\n`;
    }

    html += `  <button type="submit">Submit</button>\n`;
    html += `</form>`;
    return { toolname, html };
  });

  return {
    content: enhanced.map(e => e.html).join("\n\n"),
    filename: "webmcp-forms.html",
    content_type: "text/html",
    forms_enhanced: enhanced.length,
    tools: enhanced.map(e => e.toolname),
  };
}

function generateWebmcpTools({ company_name, tools }) {
  // Generate imperative tool registration JavaScript
  const registrations = (tools || []).map(tool => {
    const schema = tool.inputSchema || { type: "object", properties: {} };
    return `navigator.modelContext.registerTool({
  name: "${tool.name}",
  description: "${(tool.description || "").replace(/"/g, '\\"')}",
  inputSchema: ${JSON.stringify(schema, null, 4).replace(/\n/g, "\n  ")},
  handler: async (params) => {
    const response = await fetch("${tool.endpoint || "/api/" + tool.name}", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    return await response.json();
  }
});`;
  });

  const script = [
    `// WebMCP Tool Registration for ${company_name}`,
    `// Add this script to your site to register tools with AI agents`,
    "",
    `if (typeof navigator !== "undefined" && navigator.modelContext) {`,
    ...registrations.map(r => "  " + r.replace(/\n/g, "\n  ")),
    `} else {`,
    `  console.log("WebMCP not available — tools not registered");`,
    `}`,
    "",
  ].join("\n");

  return {
    content: script,
    filename: "webmcp-tools.js",
    content_type: "application/javascript",
    tool_count: registrations.length,
  };
}

function generateWebmcpMeta({ company_name, url, description, capabilities }) {
  const tags = [
    `<!-- WebMCP Meta Tags for ${company_name} -->`,
    `<meta name="model-context" content="supported" />`,
    `<meta name="model-context:name" content="${escapeAttr(company_name)}" />`,
    `<meta name="model-context:description" content="${escapeAttr(description || company_name)}" />`,
    `<meta name="model-context:url" content="${escapeAttr(url)}" />`,
    `<meta name="model-context:llms-txt" content="${url.replace(/\/$/, "")}/llms.txt" />`,
    `<meta name="model-context:agent-card" content="${url.replace(/\/$/, "")}/.well-known/agent-card.json" />`,
  ];

  if (capabilities?.length) {
    tags.push(`<meta name="model-context:capabilities" content="${escapeAttr(capabilities.join(","))}" />`);
  }

  return {
    content: tags.join("\n"),
    filename: "webmcp-meta.html",
    content_type: "text/html",
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE — Generate all artifacts at once
// ═══════════════════════════════════════════════════════════════════════

function generatePackage(input) {
  const artifacts = {};
  const { tier = "forge" } = input;

  // GEO layer (all tiers)
  artifacts.llms_txt = generateLlmsTxt(input);
  artifacts.robots_txt = generateRobotsTxt(input);
  artifacts.schema_org = generateSchemaOrg(input);

  if (input.pages?.length) {
    artifacts.sitemap_xml = generateSitemapXml({ domain: input.url, pages: input.pages });
  }

  // Protocol layer (forge+)
  if (tier === "forge" || tier === "diagnostic" || tier === "agent_access") {
    artifacts.agent_card = generateAgentCard(input);
    artifacts.llms_full_txt = generateLlmsFullTxt(input);
  }

  // WebMCP layer (diagnostic / agent_access)
  if (tier === "diagnostic" || tier === "agent_access") {
    if (input.services?.length) {
      artifacts.ucp_manifest = generateUcpManifest(input);
    }
    artifacts.webmcp_meta = generateWebmcpMeta(input);
    if (input.forms?.length) {
      artifacts.webmcp_forms = generateWebmcpForms(input);
    }
  }

  return {
    tier,
    artifact_count: Object.keys(artifacts).length,
    artifacts,
    generated_at: new Date().toISOString(),
  };
}

// ── Helpers ──

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
  // GEO
  generateLlmsTxt,
  generateLlmsFullTxt,
  generateRobotsTxt,
  generateSitemapXml,
  generateSchemaOrg,
  // Protocol
  generateAgentCard,
  generateUcpManifest,
  // WebMCP
  generateWebmcpForms,
  generateWebmcpTools,
  generateWebmcpMeta,
  // Bundle
  generatePackage,
};
