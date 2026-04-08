function getGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B-';
  if (score >= 60) return 'C+';
  if (score >= 55) return 'C';
  if (score >= 50) return 'C-';
  if (score >= 45) return 'D+';
  if (score >= 40) return 'D';
  if (score >= 35) return 'D-';
  return 'F';
}

function computeScores(checks) {
  // ── GEO Score (0-100) ──
  let geo = 0;
  if (checks.schema.has_organization) geo += 15;
  if (checks.schema.has_service || checks.schema.has_product) geo += 10;
  if (checks.schema.has_faq) geo += 10;
  if (checks.schema.has_person) geo += 5;
  if (checks.schema.has_breadcrumb) geo += 5;
  if (checks.schema.has_howto) geo += 5;
  if (checks.robots.exists) geo += 5;
  if (checks.robots.ai_crawlers_mentioned) geo += 10;
  if (checks.sitemap.exists) geo += 10;
  if (checks.llms_txt.exists) geo += 15;
  if (checks.meta.has_canonical) geo += 5;
  if (checks.schema.has_speakable) geo += 5;
  geo = Math.min(100, geo);

  // ── Multimodal Score (0-100) ──
  let multimodal = 0;
  if (checks.media.has_og_image) multimodal += 15;
  if (checks.media.has_twitter_card) multimodal += 10;
  if (checks.media.images_with_alt_pct >= 80) multimodal += 15;
  else if (checks.media.images_with_alt_pct >= 50) multimodal += 8;
  if (checks.media.has_video) multimodal += 15;
  if (checks.schema.has_image_object) multimodal += 10;
  if (checks.schema.has_video_object) multimodal += 10;
  if (checks.media.has_webp_avif) multimodal += 10;
  if (checks.media.has_srcset) multimodal += 10;
  if (checks.media.has_infographic) multimodal += 5;
  if (checks.digital_assets.has_digital_assets && checks.digital_assets.has_digital_asset_schema) multimodal += 10;
  if (checks.digital_assets.has_transcripts) multimodal += 5;
  multimodal = Math.min(100, multimodal);

  // ── Agent-Ready Score (0-100) ──
  // Core protocol stack (9 protocols)
  let agentReady = 0;
  if (checks.llms_txt.exists) agentReady += 8;
  if (checks.llms_full_txt.exists) agentReady += 4;
  if (checks.agent_card.exists) agentReady += 8;
  if (checks.ucp.exists) agentReady += 4;
  if (checks.aeo.has_declarative_webmcp) agentReady += 10;
  // New protocols (A2UI, AG-UI, ACP, ANP)
  const a2uiDetected = checks.a2ui?.exists || checks.protocol_signals?.a2ui?.detected;
  const agUiDetected = checks.ag_ui?.exists || checks.protocol_signals?.ag_ui?.detected;
  const acpDetected = checks.acp?.exists || checks.protocol_signals?.acp?.detected;
  const anpDetected = checks.anp?.exists || checks.protocol_signals?.anp?.detected;
  if (a2uiDetected) agentReady += 8;
  if (agUiDetected) agentReady += 6;
  if (acpDetected) agentReady += 6;
  if (anpDetected) agentReady += 4;
  // WebMCP navigator.modelContext registration
  if (checks.protocol_signals?.webmcp_registration?.detected) agentReady += 4;
  // Infrastructure signals
  if (checks.aeo.semantic_score >= 5) agentReady += 8;
  else if (checks.aeo.semantic_score >= 3) agentReady += 4;
  if (checks.aeo.aria_count >= 5) agentReady += 4;
  if (checks.sitemap.exists) agentReady += 4;
  if (!checks.media.is_spa) agentReady += 8;
  if (checks.schema.schema_count >= 3) agentReady += 4;
  if (checks.meta.has_structured_contact) agentReady += 4;
  if (checks.digital_assets.has_digital_assets && checks.digital_assets.has_digital_asset_schema) agentReady += 4;
  agentReady = Math.min(100, agentReady);

  const overall = Math.round(((geo + multimodal + agentReady) / 3) * 10) / 10;

  return { geo, multimodal, agentReady, overall, grade: getGrade(overall) };
}

/**
 * Generate all findings from scan checks — matches the Python pipeline's 15+ finding types.
 */
function generateFindings(checks) {
  const p0 = [];
  const p1 = [];
  const p2 = [];

  // ── P0: Critical ──

  if (!checks.llms_txt.exists) {
    p0.push({
      action: 'Deploy llms.txt file',
      detail: 'The fundamental GEO anchor file is missing. LLMs have zero context about your business.',
      impact: 'high', source: 'ai_visibility', effort: 'low',
      revenue_impact: { monthly_estimate_low: 500, monthly_estimate_mid: 1500, monthly_estimate_high: 2500 }
    });
  }

  if (!checks.schema.has_organization) {
    p0.push({
      action: 'Add Organization schema markup',
      detail: 'AI engines cannot identify your business entity without Organization JSON-LD.',
      impact: 'high', source: 'ai_visibility', effort: 'low',
      revenue_impact: { monthly_estimate_low: 300, monthly_estimate_mid: 1000, monthly_estimate_high: 2000 }
    });
  }

  if (!checks.sitemap.exists) {
    p0.push({
      action: 'Create and submit XML sitemap',
      detail: 'Without a sitemap, AI crawlers must discover pages by following links — many will be missed.',
      impact: 'high', source: 'ai_visibility', effort: 'low',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 800, monthly_estimate_high: 1500 }
    });
  }

  if (checks.media.is_spa) {
    p0.push({
      action: 'Move from SPA to SSR/SSG for crawlability',
      detail: 'Single-page apps render content only via JavaScript. AI crawlers and LLMs see an empty shell.',
      impact: 'high', source: 'ai_visibility', effort: 'high',
      revenue_impact: { monthly_estimate_low: 1000, monthly_estimate_mid: 3000, monthly_estimate_high: 5000 }
    });
  }

  if (checks.aeo.form_count > 0 && !checks.aeo.has_declarative_webmcp) {
    p0.push({
      action: 'Add WebMCP Declarative attributes (toolname, tooldescription) to all forms',
      detail: `${checks.aeo.forms_without_webmcp} form(s) exist but AI agents cannot determine what they do or how to submit them.`,
      impact: 'high', source: 'aeo', effort: 'low',
      revenue_impact: { monthly_estimate_low: 500, monthly_estimate_mid: 1500, monthly_estimate_high: 3000 }
    });
  }

  if (checks.digital_assets.has_digital_assets && !checks.digital_assets.has_digital_asset_schema) {
    p0.push({
      action: 'Wrap downloadable files in Schema.org markup (SoftwareApplication, DataDownload, or DigitalDocument)',
      detail: 'Digital assets exist but have no schema — AI agents cannot discover or describe them.',
      impact: 'high', source: 'digital_assets', effort: 'medium',
    });
  }

  // ── P1: Important (fix within 30 days) ──

  if (!checks.robots.ai_crawlers_mentioned) {
    p1.push({
      action: 'Configure robots.txt with AI crawler policies',
      detail: 'Explicitly allow or configure GPTBot, ClaudeBot, PerplexityBot, and other AI crawlers.',
      impact: 'high', source: 'ai_visibility', effort: 'low',
      revenue_impact: { monthly_estimate_low: 100, monthly_estimate_mid: 400, monthly_estimate_high: 800 }
    });
  }

  if (!checks.media.has_og_image) {
    p1.push({
      action: 'Add OG image meta tags for social/AI sharing',
      detail: 'Missing og:image means no visual preview when AI platforms or social media link to your site.',
      impact: 'medium', source: 'ai_visibility', effort: 'low',
    });
  }

  if (!checks.media.has_video) {
    p1.push({
      action: 'Add video content (explainer/demo)',
      detail: 'AI models increasingly prioritize multimodal content. Zero video content detected.',
      impact: 'medium', source: 'ai_visibility', effort: 'medium',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 600, monthly_estimate_high: 1200 }
    });
  }

  if (!checks.schema.has_faq) {
    p1.push({
      action: 'Add FAQ section with FAQPage schema',
      detail: 'FAQ schema enables direct answer extraction by AI engines and voice assistants.',
      impact: 'medium', source: 'ai_visibility', effort: 'low',
    });
  }

  if (!checks.agent_card.exists) {
    p1.push({
      action: 'Deploy .well-known/agent-card.json for A2A agent discovery',
      detail: 'Without an agent card, your business is invisible to the A2A agent economy.',
      impact: 'high', source: 'aeo', effort: 'low',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 800, monthly_estimate_high: 1500 }
    });
  }

  if (!checks.llms_full_txt.exists) {
    p1.push({
      action: 'Create llms-full.txt (comprehensive LLM context file)',
      detail: 'The extended context file gives LLMs full business details — services, methodology, pricing rationale.',
      impact: 'medium', source: 'geo', effort: 'low',
      revenue_impact: { monthly_estimate_low: 100, monthly_estimate_mid: 500, monthly_estimate_high: 1000 }
    });
  }

  // ── New Protocol Findings (A2UI, AG-UI, ACP, ANP) ──

  if (!checks.a2ui?.exists && !checks.protocol_signals?.a2ui?.detected) {
    p1.push({
      action: 'Deploy A2UI configuration for agent-driven UI rendering',
      detail: 'Google\'s A2UI protocol lets AI agents render and interact with your UI components directly. Without it, agents must scrape and guess.',
      impact: 'high', source: 'aeo', effort: 'medium',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 800, monthly_estimate_high: 1500 }
    });
  }

  if (!checks.ag_ui?.exists && !checks.protocol_signals?.ag_ui?.detected) {
    p1.push({
      action: 'Add AG-UI streaming endpoint for real-time agent interaction',
      detail: 'AG-UI (CopilotKit) enables agents to stream responses and co-pilot experiences in your app. Growing ecosystem with CopilotKit adoption.',
      impact: 'medium', source: 'aeo', effort: 'medium',
      revenue_impact: { monthly_estimate_low: 150, monthly_estimate_mid: 600, monthly_estimate_high: 1200 }
    });
  }

  if (!checks.acp?.exists && !checks.protocol_signals?.acp?.detected) {
    p1.push({
      action: 'Expose ACP endpoint for agent-to-agent communication',
      detail: 'The Agent Communication Protocol enables RESTful agent messaging. Required for multi-agent workflows that include your services.',
      impact: 'medium', source: 'aeo', effort: 'medium',
      revenue_impact: { monthly_estimate_low: 100, monthly_estimate_mid: 500, monthly_estimate_high: 1000 }
    });
  }

  if (!checks.aeo.has_main) {
    p1.push({
      action: 'Add <main> tag for primary content region',
      detail: 'Semantic HTML helps AI parsers distinguish content from navigation and chrome.',
      impact: 'medium', source: 'semantic_html', effort: 'low',
    });
  }

  if (!checks.aeo.has_article && !checks.aeo.has_section) {
    p1.push({
      action: 'Use <article>/<section> tags for content structure',
      detail: 'Content hierarchy is invisible to AI without semantic markup.',
      impact: 'medium', source: 'semantic_html', effort: 'low',
    });
  }

  if (checks.aeo.aria_count === 0) {
    p1.push({
      action: 'Add ARIA labels to interactive elements (buttons, forms, menus)',
      detail: 'Zero ARIA attributes detected. AI agents and assistive tech cannot identify interactive elements.',
      impact: 'medium', source: 'accessibility', effort: 'medium',
    });
  }

  if (checks.media.has_video && !checks.digital_assets.has_transcripts) {
    p1.push({
      action: 'Expose video/audio transcripts in DOM or link from llms.txt',
      detail: 'Video content exists but transcripts are not accessible to AI agents.',
      impact: 'high', source: 'digital_assets', effort: 'medium',
    });
  }

  if (checks.digital_assets.has_digital_assets && !checks.ucp.exists) {
    p1.push({
      action: 'Deploy UCP endpoint for autonomous digital asset purchasing',
      detail: 'AI agents cannot click download buttons — they need structured commerce endpoints.',
      impact: 'high', source: 'digital_assets', effort: 'high',
    });
  }

  // ── P2: Nice-to-have (within 90 days) ──

  if (!checks.anp?.exists && !checks.protocol_signals?.anp?.detected) {
    p2.push({
      action: 'Publish W3C DID document for decentralized agent identity',
      detail: 'The Agent Network Protocol uses W3C DIDs for verifiable agent identity. Early adopters gain trust signals in the emerging decentralized agent economy.',
      impact: 'low', source: 'aeo', effort: 'high',
    });
  }

  if (!checks.ucp.exists && !checks.digital_assets.has_digital_assets) {
    p2.push({
      action: 'Deploy .well-known/ucp manifest for agentic commerce',
      detail: 'UCP enables AI procurement agents to discover your services and pricing programmatically.',
      impact: 'low', source: 'aeo', effort: 'medium',
    });
  }

  if (!checks.schema.has_speakable) {
    p2.push({
      action: 'Add Speakable schema for voice assistants',
      detail: 'Speakable markup tells voice assistants which content is suitable for text-to-speech.',
      impact: 'low', source: 'ai_visibility', effort: 'low',
    });
  }

  if (!checks.aeo.has_nav) {
    p2.push({
      action: 'Wrap navigation in <nav> tag',
      detail: 'Helps AI parsers distinguish navigation from content.',
      impact: 'low', source: 'semantic_html', effort: 'low',
    });
  }

  if (checks.aeo.interactive_without_aria > 3) {
    p2.push({
      action: `Fix ${checks.aeo.interactive_without_aria} interactive elements missing accessible names`,
      detail: 'Buttons, inputs, and links without aria-label are invisible to AI assistive agents.',
      impact: 'medium', source: 'accessibility', effort: 'medium',
    });
  }

  if (!checks.media.has_srcset) {
    p2.push({
      action: 'Add responsive images with srcset for multimodal optimization',
      detail: 'srcset provides resolution-appropriate images for different contexts including AI image analysis.',
      impact: 'low', source: 'ai_visibility', effort: 'low',
    });
  }

  if (!checks.media.has_webp_avif) {
    p2.push({
      action: 'Serve images in WebP/AVIF format for modern multimodal indexing',
      detail: 'Next-gen image formats signal modern infrastructure to AI crawlers.',
      impact: 'low', source: 'ai_visibility', effort: 'low',
    });
  }

  return { p0, p1, p2 };
}

/**
 * Calculate 6-dimension marketing health score from per-page scores.
 */
function calculateMarketingHealth(pagesAnalyzed, checks) {
  // Average per-page scores
  const count = pagesAnalyzed.length || 1;
  const avgSeo = pagesAnalyzed.reduce((s, p) => s + (p.scores?.seo || 0), 0) / count;
  const avgCta = pagesAnalyzed.reduce((s, p) => s + (p.scores?.cta || 0), 0) / count;
  const avgTrust = pagesAnalyzed.reduce((s, p) => s + (p.scores?.trust || 0), 0) / count;
  const avgTracking = pagesAnalyzed.reduce((s, p) => s + (p.scores?.tracking || 0), 0) / count;

  // 6 dimensions (0-100 each)
  const contentMessaging = Math.min(100, Math.round(avgSeo * 10 + (checks.schema.has_faq ? 5 : 0) + (checks.llms_txt.exists ? 5 : 0)));
  const conversionCro = Math.min(100, Math.round(avgCta * 12 + (checks.aeo.form_count > 0 ? 10 : 0) + (checks.aeo.has_declarative_webmcp ? 10 : 0)));
  const seoDiscoverability = Math.min(100, Math.round(avgSeo * 8 + (checks.sitemap.exists ? 10 : 0) + (checks.robots.exists ? 5 : 0) + (checks.meta.has_canonical ? 5 : 0)));
  const competitivePosition = 50; // Default — updated when competitors are scanned
  const brandTrust = Math.min(100, Math.round(avgTrust * 10 + (checks.meta.has_structured_contact ? 10 : 0)));
  const growthSignals = Math.min(100, Math.round(avgTracking * 8 + (checks.media.has_og_image ? 10 : 0) + (checks.media.has_twitter_card ? 10 : 0)));

  const dimensions = {
    content_messaging: { score: contentMessaging, weight: 0.25, label: 'Content & Messaging' },
    conversion_cro: { score: conversionCro, weight: 0.20, label: 'Conversion/CRO' },
    seo_discoverability: { score: seoDiscoverability, weight: 0.20, label: 'SEO & Discoverability' },
    competitive_position: { score: competitivePosition, weight: 0.15, label: 'Competitive Position' },
    brand_trust: { score: brandTrust, weight: 0.10, label: 'Brand & Trust' },
    growth_signals: { score: growthSignals, weight: 0.10, label: 'Growth Signals' },
  };

  // Weighted overall
  let overall = 0;
  for (const dim of Object.values(dimensions)) {
    overall += dim.score * dim.weight;
  }
  overall = Math.round(overall * 10) / 10;

  return {
    overall,
    seo: Math.round(avgSeo * 10) / 10,
    cta_conversion: Math.round(avgCta * 10) / 10,
    trust_signals: Math.round(avgTrust * 10) / 10,
    analytics_tracking: Math.round(avgTracking * 10) / 10,
    competitor_position: competitivePosition,
    cro: conversionCro,
    grade: getGrade(overall),
    dimensions,
  };
}

/**
 * Generate marketing-specific findings from page scores.
 */
function generateMarketingFindings(marketingHealth, checks) {
  const findings = [];

  if (marketingHealth.analytics_tracking <= 2) {
    findings.push({
      action: 'Install analytics tracking',
      detail: 'No analytics tools detected. Without tracking, you can\'t measure what\'s working or optimize campaigns.',
      category: 'Marketing', effort: 'low', impact: 'high', source: 'marketing_health',
      priority: 'high',
      revenue_impact: { monthly_estimate_low: 500, monthly_estimate_mid: 1500, monthly_estimate_high: 3000 }
    });
  }

  if (marketingHealth.cta_conversion <= 5) {
    findings.push({
      action: 'Add secondary CTAs',
      detail: 'Best practice is 2-4 CTAs on a landing page for different scroll depths.',
      category: 'Marketing', effort: 'low', impact: 'medium', source: 'marketing_health',
      priority: 'medium',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 750, monthly_estimate_high: 1500 }
    });
  }

  if (!checks.media.has_twitter_card && !checks.media.has_og_image) {
    findings.push({
      action: 'Add social media links',
      detail: 'No social media links found. Social presence signals legitimacy to both visitors and AI platforms.',
      category: 'Marketing', effort: 'low', impact: 'medium', source: 'marketing_health',
      priority: 'medium',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 750, monthly_estimate_high: 1500 }
    });
  }

  return findings;
}

// ── Data-driven score breakdown for drill-down UI ──

const SCORE_RULES = {
  geo: [
    { name: 'Organization Schema', check: (c) => c.schema.has_organization, points: 15, desc: 'JSON-LD Organization markup identifies your business entity' },
    { name: 'Service/Product Schema', check: (c) => c.schema.has_service || c.schema.has_product, points: 10, desc: 'Schema markup for your services or products' },
    { name: 'FAQ Schema', check: (c) => c.schema.has_faq, points: 10, desc: 'Enables direct answer extraction by AI engines' },
    { name: 'Person Schema', check: (c) => c.schema.has_person, points: 5, desc: 'Team/founder schema for E-E-A-T signals' },
    { name: 'Breadcrumb Schema', check: (c) => c.schema.has_breadcrumb, points: 5, desc: 'Navigation path schema for site structure' },
    { name: 'HowTo Schema', check: (c) => c.schema.has_howto, points: 5, desc: 'Step-by-step instruction markup' },
    { name: 'robots.txt Present', check: (c) => c.robots.exists, points: 5, desc: 'Crawler directive file exists' },
    { name: 'AI Crawlers Configured', check: (c) => c.robots.ai_crawlers_mentioned, points: 10, desc: 'Explicit rules for GPTBot, ClaudeBot, PerplexityBot' },
    { name: 'XML Sitemap', check: (c) => c.sitemap.exists, points: 10, desc: 'URL index for crawler discovery' },
    { name: 'llms.txt', check: (c) => c.llms_txt.exists, points: 15, desc: 'The fundamental AI context file for your business' },
    { name: 'Canonical Tags', check: (c) => c.meta.has_canonical, points: 5, desc: 'Prevents duplicate content in AI training data' },
    { name: 'Speakable Schema', check: (c) => c.schema.has_speakable, points: 5, desc: 'Voice assistant optimization markup' },
  ],
  multimodal: [
    { name: 'OG Image', check: (c) => c.media.has_og_image, points: 15, desc: 'Visual preview for AI platforms and social sharing' },
    { name: 'Twitter Card', check: (c) => c.media.has_twitter_card, points: 10, desc: 'X/Twitter card meta tags for rich previews' },
    { name: 'Alt Text Coverage', check: (c) => c.media.images_with_alt_pct >= 80, points: 15, altCheck: (c) => c.media.images_with_alt_pct >= 50, altPoints: 8, desc: 'Image descriptions for multimodal AI understanding' },
    { name: 'Video Content', check: (c) => c.media.has_video, points: 15, desc: 'Video signals rich, multimodal content' },
    { name: 'ImageObject Schema', check: (c) => c.schema.has_image_object, points: 10, desc: 'Structured image metadata for AI indexing' },
    { name: 'VideoObject Schema', check: (c) => c.schema.has_video_object, points: 10, desc: 'Structured video metadata for AI indexing' },
    { name: 'WebP/AVIF Format', check: (c) => c.media.has_webp_avif, points: 10, desc: 'Modern image formats signal infrastructure quality' },
    { name: 'Responsive Images (srcset)', check: (c) => c.media.has_srcset, points: 10, desc: 'Resolution-appropriate images for different contexts' },
    { name: 'Infographic Detection', check: (c) => c.media.has_infographic, points: 5, desc: 'Visual data representation for AI analysis' },
    { name: 'Digital Asset Schema', check: (c) => c.digital_assets.has_digital_assets && c.digital_assets.has_digital_asset_schema, points: 10, desc: 'Downloadable content with structured metadata' },
    { name: 'Transcripts Available', check: (c) => c.digital_assets.has_transcripts, points: 5, desc: 'Text versions of audio/video for AI processing' },
  ],
  agent_ready: [
    { name: 'llms.txt', check: (c) => c.llms_txt.exists, points: 8, desc: 'AI context file for agent discovery' },
    { name: 'llms-full.txt', check: (c) => c.llms_full_txt.exists, points: 4, desc: 'Extended context with full business details' },
    { name: 'Agent Card (A2A)', check: (c) => c.agent_card.exists, points: 8, desc: 'Agent-to-agent discovery endpoint' },
    { name: 'UCP Endpoint', check: (c) => c.ucp.exists, points: 4, desc: 'Universal Commerce Protocol for AI purchasing' },
    { name: 'WebMCP Forms', check: (c) => c.aeo.has_declarative_webmcp, points: 10, desc: 'Declarative form attributes AI agents can execute' },
    { name: 'A2UI Config', check: (c) => c.a2ui?.exists || c.protocol_signals?.a2ui?.detected, points: 8, desc: 'Google Agent-to-UI protocol — agent-driven UI rendering' },
    { name: 'AG-UI (CopilotKit)', check: (c) => c.ag_ui?.exists || c.protocol_signals?.ag_ui?.detected, points: 6, desc: 'Agent-User Interaction — real-time streaming UI' },
    { name: 'ACP Endpoint', check: (c) => c.acp?.exists || c.protocol_signals?.acp?.detected, points: 6, desc: 'Agent Communication Protocol — RESTful agent messaging' },
    { name: 'ANP / DID', check: (c) => c.anp?.exists || c.protocol_signals?.anp?.detected, points: 4, desc: 'Agent Network Protocol — decentralized identity (W3C DIDs)' },
    { name: 'WebMCP Registration', check: (c) => c.protocol_signals?.webmcp_registration?.detected, points: 4, desc: 'navigator.modelContext API registration for in-page tools' },
    { name: 'Semantic HTML (5+)', check: (c) => c.aeo.semantic_score >= 5, points: 8, altCheck: (c) => c.aeo.semantic_score >= 3, altPoints: 4, desc: 'Rich semantic tags for AI content parsing' },
    { name: 'ARIA Labels (5+)', check: (c) => c.aeo.aria_count >= 5, points: 4, desc: 'Accessible labels for interactive elements' },
    { name: 'XML Sitemap', check: (c) => c.sitemap.exists, points: 4, desc: 'URL discovery for agent crawling' },
    { name: 'Not SPA-Only', check: (c) => !c.media.is_spa, points: 8, desc: 'Server-rendered content AI can read without JS' },
    { name: 'Schema Count (3+)', check: (c) => c.schema.schema_count >= 3, points: 4, desc: 'Rich structured data coverage' },
    { name: 'Structured Contact', check: (c) => c.meta.has_structured_contact, points: 4, desc: 'Machine-readable contact information' },
    { name: 'Digital Asset Schema', check: (c) => c.digital_assets.has_digital_assets && c.digital_assets.has_digital_asset_schema, points: 4, desc: 'Downloadable content with structured metadata' },
  ],
};

function getScoreBreakdown(dimension, checks) {
  const rules = SCORE_RULES[dimension];
  if (!rules) return [];

  return rules.map(rule => {
    let passed = false;
    let awarded = 0;
    try {
      if (rule.check(checks)) {
        passed = true;
        awarded = rule.points;
      } else if (rule.altCheck && rule.altCheck(checks)) {
        passed = true;
        awarded = rule.altPoints;
      }
    } catch { /* check failed — field missing */ }
    return {
      name: rule.name,
      description: rule.desc,
      points: awarded,
      maxPoints: rule.points,
      passed,
    };
  });
}

// ── SEO Health Score (0-100) ──
// 4 sub-scores: Core Web Vitals (30%), Technical SEO (25%), On-Page SEO (25%), Mobile & Performance (20%)

function calculateSeoHealth(pagesAnalyzed, checks, pageSpeedData) {
  // ── Sub-score 1: Core Web Vitals (0-100, weight 0.30) ──
  let cwv = 50; // default if PageSpeed unavailable
  if (pageSpeedData?.core_web_vitals) {
    const v = pageSpeedData.core_web_vitals;
    let pts = 0;
    // LCP (40 points)
    if (v.lcp_ms != null) {
      pts += v.lcp_ms <= 2500 ? 40 : v.lcp_ms <= 4000 ? 20 : 0;
    } else { pts += 20; } // neutral if missing
    // CLS (30 points)
    if (v.cls != null) {
      pts += v.cls <= 0.1 ? 30 : v.cls <= 0.25 ? 15 : 0;
    } else { pts += 15; }
    // INP (30 points)
    if (v.inp_ms != null) {
      pts += v.inp_ms <= 200 ? 30 : v.inp_ms <= 500 ? 15 : 0;
    } else { pts += 15; }
    cwv = Math.min(100, pts);
  }

  // ── Sub-score 2: Technical SEO (0-100, weight 0.25) ──
  let technical = 0;
  if (checks.sitemap?.exists) technical += 15;
  if (checks.robots?.exists) technical += 10;
  if (checks.robots?.ai_crawlers_mentioned) technical += 5; // robots references sitemap
  const hasCanonical = pagesAnalyzed.some(p => p.seo_details?.canonical);
  if (hasCanonical) technical += 10;
  // Broken links
  const brokenCount = (pagesAnalyzed || []).reduce((sum, p) => sum + (p._broken_links?.length || 0), 0);
  technical += brokenCount === 0 ? 20 : brokenCount <= 5 ? 10 : 0;
  // HTTPS
  const homepageUrl = pagesAnalyzed[0]?.url || '';
  if (homepageUrl.startsWith('https://')) technical += 10;
  // Response time
  const avgResponseTime = pagesAnalyzed.reduce((s, p) => s + (p.response_time_ms || 0), 0) / (pagesAnalyzed.length || 1);
  if (avgResponseTime < 2000) technical += 10;
  else if (avgResponseTime < 4000) technical += 5;
  // Sitemap URL count
  if (checks.sitemap?.url_count > 10) technical += 5;
  // Redirect check (homepage should not redirect excessively)
  technical += 15; // Base points — deducted if redirect chains found in future
  technical = Math.min(100, technical);

  // ── Sub-score 3: On-Page SEO (0-100, weight 0.25) ──
  const pageScores = pagesAnalyzed.map(p => {
    const d = p.seo_details;
    if (!d) return 50; // neutral if no data
    let s = 0;
    // Title (20 pts)
    s += d.title.quality === 'good' ? 20 : d.title.quality === 'missing' ? 0 : 10;
    // Description (20 pts)
    s += d.description.quality === 'good' ? 20 : d.description.quality === 'missing' ? 0 : 10;
    // H1 (10 pts)
    s += d.h1.count === 1 ? 10 : d.h1.count > 1 ? 3 : 0;
    // Heading hierarchy (10 pts)
    s += d.heading_hierarchy_valid ? 10 : 0;
    // Alt text (15 pts)
    s += d.images.alt_coverage_pct >= 80 ? 15 : d.images.alt_coverage_pct >= 50 ? 8 : 0;
    // Structured data (10 pts)
    s += d.schema_count >= 1 ? 10 : 0;
    // OG tags (10 pts)
    s += d.og_complete >= 4 ? 10 : d.og_complete >= 2 ? 5 : 0;
    // Duplicate detection bonus (5 pts) — checked at aggregate level below
    return Math.min(100, s);
  });
  let onPage = pageScores.reduce((a, b) => a + b, 0) / (pageScores.length || 1);
  // Duplicate title check
  const titles = pagesAnalyzed.map(p => p.seo_details?.title?.text).filter(Boolean);
  const uniqueTitles = new Set(titles);
  if (titles.length > 1 && uniqueTitles.size === titles.length) onPage = Math.min(100, onPage + 5);
  onPage = Math.round(onPage * 10) / 10;

  // ── Sub-score 4: Mobile & Performance (0-100, weight 0.20) ──
  let mobilePerf = 50; // default
  if (pageSpeedData?.lighthouse) {
    const lh = pageSpeedData.lighthouse;
    mobilePerf = Math.round(
      (lh.performance || 0) * 0.40 +
      (lh.seo || 0) * 0.30 +
      (lh.accessibility || 0) * 0.15 +
      (lh.best_practices || 0) * 0.15
    );
  } else {
    // Fallback: viewport + responsive images
    const hasViewport = pagesAnalyzed.some(p => p.seo_details?.has_viewport);
    mobilePerf = hasViewport ? 60 : 30;
  }

  // ── Overall SEO Health ──
  const overall = Math.round(((cwv * 0.30) + (technical * 0.25) + (onPage * 0.25) + (mobilePerf * 0.20)) * 10) / 10;

  return {
    overall,
    grade: getGrade(overall),
    sub_scores: {
      cwv: Math.round(cwv),
      technical: Math.round(technical),
      on_page: Math.round(onPage),
      mobile_perf: Math.round(mobilePerf),
    },
    core_web_vitals: pageSpeedData?.core_web_vitals || null,
    lighthouse: pageSpeedData?.lighthouse || null,
    broken_link_count: brokenCount,
    pagespeed_available: !!pageSpeedData,
  };
}

// ── Forge Score (proprietary composite) ──

function calculateForgeScore(aiVisibilityOverall, seoHealthOverall, marketingHealthOverall) {
  return Math.round(((aiVisibilityOverall * 0.45) + (marketingHealthOverall * 0.30) + (seoHealthOverall * 0.25)) * 10) / 10;
}

// ── SEO Findings ──

function generateSeoFindings(seoHealth, pagesAnalyzed, pageSpeedData) {
  const findings = { p0: [], p1: [], p2: [] };
  const cwv = pageSpeedData?.core_web_vitals || {};
  const lh = pageSpeedData?.lighthouse || {};

  // ── P0: Critical ──
  if (cwv.lcp_ms && cwv.lcp_ms > 4000) {
    findings.p0.push({
      action: "Fix critically slow page load (LCP > 4 seconds)",
      detail: `Largest Contentful Paint is ${(cwv.lcp_ms / 1000).toFixed(1)}s. Google recommends under 2.5s. This directly impacts rankings, AI crawlability, and user experience.`,
      impact: "high", effort: "high", source: "seo_health",
      revenue_impact: { monthly_estimate_low: 500, monthly_estimate_mid: 2000, monthly_estimate_high: 5000 },
    });
  }

  const pagesNoDesc = pagesAnalyzed.filter(p => p.seo_details?.description?.quality === 'missing');
  if (pagesNoDesc.length > 0) {
    findings.p0.push({
      action: "Add meta descriptions to all pages",
      detail: `${pagesNoDesc.length} page(s) have no meta description. Search engines and AI systems use this as the primary summary of your page content.`,
      impact: "high", effort: "low", source: "seo_health",
      revenue_impact: { monthly_estimate_low: 300, monthly_estimate_mid: 1000, monthly_estimate_high: 2500 },
    });
  }

  if (seoHealth.broken_link_count > 5) {
    findings.p0.push({
      action: "Fix broken links across your site",
      detail: `${seoHealth.broken_link_count} broken link(s) detected. Broken links damage crawlability, user experience, and reduce trust signals for both search engines and AI systems.`,
      impact: "high", effort: "medium", source: "seo_health",
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 800, monthly_estimate_high: 2000 },
    });
  }

  if (lh.performance && lh.performance < 30) {
    findings.p0.push({
      action: "Address critical performance issues",
      detail: `Lighthouse performance score is ${lh.performance}/100. Scores below 30 indicate severe issues affecting page load, interactivity, and visual stability.`,
      impact: "high", effort: "high", source: "seo_health",
    });
  }

  // ── P1: Important ──
  const badTitles = pagesAnalyzed.filter(p => {
    const q = p.seo_details?.title?.quality;
    return q === 'short' || q === 'long' || q === 'missing';
  });
  if (badTitles.length > 0) {
    const issues = badTitles.map(p => `${p.seo_details.title.quality} (${p.seo_details.title.length} chars)`);
    findings.p1.push({
      action: "Optimize title tag length (50-60 characters)",
      detail: `${badTitles.length} page(s) have suboptimal title tags: ${issues.slice(0, 3).join(', ')}${badTitles.length > 3 ? '...' : ''}. Ideal length is 50-60 characters for maximum visibility.`,
      impact: "medium", effort: "low", source: "seo_health",
    });
  }

  const multiH1 = pagesAnalyzed.filter(p => (p.seo_details?.h1?.count || 0) > 1);
  if (multiH1.length > 0) {
    findings.p1.push({
      action: "Use exactly one H1 tag per page",
      detail: `${multiH1.length} page(s) have multiple H1 tags. Each page should have a single H1 that clearly describes its content.`,
      impact: "medium", effort: "low", source: "seo_health",
    });
  }

  const noH1 = pagesAnalyzed.filter(p => (p.seo_details?.h1?.count || 0) === 0);
  if (noH1.length > 0) {
    findings.p1.push({
      action: "Add H1 heading to all pages",
      detail: `${noH1.length} page(s) are missing an H1 tag. The H1 is the primary heading signal for both search engines and AI systems.`,
      impact: "medium", effort: "low", source: "seo_health",
    });
  }

  if (cwv.cls != null && cwv.cls > 0.25) {
    findings.p1.push({
      action: "Reduce Cumulative Layout Shift (CLS > 0.25)",
      detail: `CLS is ${cwv.cls.toFixed(3)}. Elements are shifting unexpectedly during page load, degrading user experience. Common fixes: set image dimensions, avoid dynamically injected content above the fold.`,
      impact: "medium", effort: "medium", source: "seo_health",
    });
  }

  if (cwv.inp_ms && cwv.inp_ms > 500) {
    findings.p1.push({
      action: "Improve Interaction to Next Paint (INP > 500ms)",
      detail: `INP is ${cwv.inp_ms}ms. User interactions feel sluggish. Optimize JavaScript execution and reduce main thread blocking.`,
      impact: "medium", effort: "high", source: "seo_health",
    });
  }

  // Duplicate titles
  const titles = pagesAnalyzed.map(p => p.seo_details?.title?.text).filter(Boolean);
  const titleCounts = {};
  titles.forEach(t => { titleCounts[t] = (titleCounts[t] || 0) + 1; });
  const dupes = Object.entries(titleCounts).filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    findings.p1.push({
      action: "Fix duplicate title tags across pages",
      detail: `${dupes.length} title(s) are used on multiple pages. Each page should have a unique title to avoid confusing search engines and AI systems.`,
      impact: "medium", effort: "low", source: "seo_health",
    });
  }

  if (seoHealth.broken_link_count > 0 && seoHealth.broken_link_count <= 5) {
    findings.p1.push({
      action: "Fix broken links on your site",
      detail: `${seoHealth.broken_link_count} broken link(s) detected. Fix or remove these to improve crawlability.`,
      impact: "medium", effort: "low", source: "seo_health",
    });
  }

  // ── P2: Nice-to-have ──
  const lowAlt = pagesAnalyzed.filter(p => {
    const cov = p.seo_details?.images?.alt_coverage_pct;
    return cov != null && cov < 80 && p.seo_details?.images?.total > 0;
  });
  if (lowAlt.length > 0) {
    findings.p2.push({
      action: "Add alt text to all images",
      detail: `${lowAlt.length} page(s) have less than 80% image alt text coverage. Alt text improves accessibility and provides context to search engines and AI systems.`,
      impact: "low", effort: "low", source: "seo_health",
    });
  }

  const noLazy = pagesAnalyzed.filter(p => {
    const d = p.seo_details?.images;
    return d && d.total > 3 && d.lazy_loaded === 0;
  });
  if (noLazy.length > 0) {
    findings.p2.push({
      action: "Add lazy loading to below-fold images",
      detail: `${noLazy.length} page(s) have images without lazy loading. Add loading=\"lazy\" to improve initial page load speed.`,
      impact: "low", effort: "low", source: "seo_health",
    });
  }

  const noDimensions = pagesAnalyzed.filter(p => {
    const d = p.seo_details?.images;
    return d && d.total > 0 && d.with_dimensions < d.total;
  });
  if (noDimensions.length > 0) {
    findings.p2.push({
      action: "Add width and height attributes to images",
      detail: `Images without explicit dimensions cause layout shifts (CLS). Add width and height attributes or use CSS aspect-ratio.`,
      impact: "low", effort: "low", source: "seo_health",
    });
  }

  const badHierarchy = pagesAnalyzed.filter(p => p.seo_details && !p.seo_details.heading_hierarchy_valid);
  if (badHierarchy.length > 0) {
    findings.p2.push({
      action: "Fix heading hierarchy (H1 > H2 > H3)",
      detail: `${badHierarchy.length} page(s) skip heading levels (e.g., H1 to H3 without H2). Proper hierarchy helps both accessibility and content structure signaling.`,
      impact: "low", effort: "low", source: "seo_health",
    });
  }

  return findings;
}

// ── SEO Score Breakdown Rules (for drill-down UI) ──

const SEO_SCORE_RULES = {
  cwv: [
    { name: "LCP ≤ 2.5s", desc: "Largest Contentful Paint under 2.5 seconds", points: 40, check: (d) => d?.core_web_vitals?.lcp_ms <= 2500, altCheck: (d) => d?.core_web_vitals?.lcp_ms <= 4000, altPoints: 20 },
    { name: "CLS ≤ 0.1", desc: "Cumulative Layout Shift under 0.1", points: 30, check: (d) => d?.core_web_vitals?.cls <= 0.1, altCheck: (d) => d?.core_web_vitals?.cls <= 0.25, altPoints: 15 },
    { name: "INP ≤ 200ms", desc: "Interaction to Next Paint under 200ms", points: 30, check: (d) => d?.core_web_vitals?.inp_ms <= 200, altCheck: (d) => d?.core_web_vitals?.inp_ms <= 500, altPoints: 15 },
  ],
  technical_seo: [
    { name: "sitemap.xml", desc: "XML sitemap exists and is accessible", points: 15, check: (d) => d?.sitemap?.exists },
    { name: "robots.txt", desc: "robots.txt file exists", points: 10, check: (d) => d?.robots?.exists },
    { name: "Canonical tags", desc: "Canonical link tags present", points: 10, check: (d) => d?._has_canonical },
    { name: "No broken links", desc: "No 4xx/5xx links detected", points: 20, check: (d) => (d?._broken_count || 0) === 0, altCheck: (d) => (d?._broken_count || 0) <= 5, altPoints: 10 },
    { name: "HTTPS", desc: "Site uses HTTPS", points: 10, check: (d) => d?._is_https },
    { name: "Fast response", desc: "Average response time under 2 seconds", points: 10, check: (d) => (d?._avg_response_ms || 9999) < 2000 },
  ],
  on_page_seo: [
    { name: "Title tags", desc: "Title tags present with good length (50-60 chars)", points: 20, check: (d) => d?._title_quality === 'good' },
    { name: "Meta descriptions", desc: "Meta descriptions present with good length", points: 20, check: (d) => d?._desc_quality === 'good' },
    { name: "Single H1", desc: "Exactly one H1 per page", points: 10, check: (d) => d?._h1_count === 1 },
    { name: "Alt text ≥80%", desc: "Image alt text coverage at least 80%", points: 15, check: (d) => (d?._alt_coverage || 0) >= 80 },
    { name: "Structured data", desc: "JSON-LD structured data present", points: 10, check: (d) => (d?._schema_count || 0) >= 1 },
    { name: "OG tags", desc: "OpenGraph meta tags complete", points: 10, check: (d) => (d?._og_complete || 0) >= 4 },
  ],
  mobile_perf: [
    { name: "Performance ≥ 50", desc: "Lighthouse performance score at least 50", points: 40, check: (d) => (d?.lighthouse?.performance || 0) >= 50 },
    { name: "SEO ≥ 80", desc: "Lighthouse SEO score at least 80", points: 30, check: (d) => (d?.lighthouse?.seo || 0) >= 80 },
    { name: "Accessibility ≥ 70", desc: "Lighthouse accessibility score at least 70", points: 15, check: (d) => (d?.lighthouse?.accessibility || 0) >= 70 },
    { name: "Best Practices ≥ 70", desc: "Lighthouse best practices score at least 70", points: 15, check: (d) => (d?.lighthouse?.best_practices || 0) >= 70 },
  ],
};

function getSeoScoreBreakdown(dimension, seoHealth) {
  const rules = SEO_SCORE_RULES[dimension];
  if (!rules) return null;

  const breakdown = rules.map(rule => {
    let passed = false;
    let awarded = 0;
    try {
      if (rule.check(seoHealth)) { passed = true; awarded = rule.points; }
      else if (rule.altCheck && rule.altCheck(seoHealth)) { passed = true; awarded = rule.altPoints; }
    } catch {}
    return { name: rule.name, description: rule.desc, points: awarded, maxPoints: rule.points, passed };
  });

  const passed = breakdown.filter(b => b.passed).length;
  const total = breakdown.length;
  const max = breakdown.reduce((s, b) => s + b.maxPoints, 0);
  const score = breakdown.reduce((s, b) => s + b.points, 0);

  return { dimension, score, max, passed, failed: total - passed, total, breakdown };
}

// ── Protocol Security Score (0-100) ──
// 7 attack vectors: MCP poisoning, supply chain, config injection, rug pulls,
// AgentCard spoofing, A2UI catalog poisoning, cross-layer attacks.

function calculateProtocolSecurity(checks) {
  const sec = checks.security_signals || {};
  const headers = sec.headers || {};
  const mcpSafety = sec.mcp_safety || {};
  const agentCard = sec.agent_card || {};
  const scriptSafety = sec.script_safety || {};

  let score = 0;

  // ── Transport Security (20 pts) ──
  if (headers.has_hsts) score += 10;
  if (headers.hsts_max_age >= 31536000) score += 5; // 1 year minimum
  else if (headers.hsts_max_age >= 2592000) score += 2; // 30 days
  if (headers.has_x_content_type_options) score += 5;

  // ── Content Security Policy (20 pts) ──
  if (headers.has_csp) score += 8;
  if (headers.csp_has_default_src) score += 4;
  if (headers.has_csp && !headers.csp_allows_unsafe_inline) score += 4;
  if (headers.has_csp && !headers.csp_allows_unsafe_eval) score += 4;

  // ── MCP Tool Safety (20 pts) ──
  if (mcpSafety.tool_count > 0) {
    // Has MCP tools — check for poisoning signals
    if (!mcpSafety.has_unicode_obfuscation) score += 10;
    if (!mcpSafety.has_suspicious_descriptions) score += 10;
  } else {
    // No MCP tools — no attack surface, full points
    score += 20;
  }

  // ── Agent Card Verification (15 pts) ──
  if (checks.agent_card?.exists) {
    if (agentCard.has_signed_card) score += 15;
    else score += 5; // Card exists but unsigned
  } else {
    score += 10; // No card = no spoofing surface (partial credit)
  }

  // ── Script Integrity (15 pts) ──
  if (headers.has_x_frame_options) score += 5;
  if (scriptSafety.sri_coverage_pct >= 80) score += 5;
  else if (scriptSafety.sri_coverage_pct >= 40) score += 2;
  if (!headers.is_wildcard_cors) score += 5;

  // ── Cross-Layer Defense (10 pts) ──
  if (headers.has_permissions_policy) score += 5;
  if (headers.has_csp && headers.has_hsts && headers.has_x_frame_options) score += 5; // Defense-in-depth bonus

  return {
    overall: Math.min(100, score),
    grade: getGrade(Math.min(100, score)),
    sub_scores: {
      transport_security: Math.min(20, (headers.has_hsts ? 10 : 0) + (headers.hsts_max_age >= 31536000 ? 5 : headers.hsts_max_age >= 2592000 ? 2 : 0) + (headers.has_x_content_type_options ? 5 : 0)),
      content_security_policy: Math.min(20, (headers.has_csp ? 8 : 0) + (headers.csp_has_default_src ? 4 : 0) + (headers.has_csp && !headers.csp_allows_unsafe_inline ? 4 : 0) + (headers.has_csp && !headers.csp_allows_unsafe_eval ? 4 : 0)),
      mcp_tool_safety: Math.min(20, mcpSafety.tool_count > 0 ? ((!mcpSafety.has_unicode_obfuscation ? 10 : 0) + (!mcpSafety.has_suspicious_descriptions ? 10 : 0)) : 20),
      agent_card_verification: Math.min(15, checks.agent_card?.exists ? (agentCard.has_signed_card ? 15 : 5) : 10),
      script_integrity: Math.min(15, (headers.has_x_frame_options ? 5 : 0) + (scriptSafety.sri_coverage_pct >= 80 ? 5 : scriptSafety.sri_coverage_pct >= 40 ? 2 : 0) + (!headers.is_wildcard_cors ? 5 : 0)),
      cross_layer_defense: Math.min(10, (headers.has_permissions_policy ? 5 : 0) + (headers.has_csp && headers.has_hsts && headers.has_x_frame_options ? 5 : 0)),
    },
    signals: sec,
  };
}

// ── Protocol Security Findings ──

function generateSecurityFindings(protocolSecurity, checks) {
  const findings = { p0: [], p1: [], p2: [] };
  const sec = checks.security_signals || {};
  const headers = sec.headers || {};
  const mcpSafety = sec.mcp_safety || {};
  const agentCard = sec.agent_card || {};
  const scriptSafety = sec.script_safety || {};

  // ── P0: Critical Security Issues ──

  if (mcpSafety.has_unicode_obfuscation) {
    findings.p0.push({
      action: 'CRITICAL: MCP tool poisoning detected — Unicode obfuscation in tool descriptions',
      detail: 'Hidden Unicode characters found in WebMCP tool descriptions. This is the #1 MCP attack vector — malicious invisible text can manipulate agent behavior. Remove all zero-width and directional override characters.',
      impact: 'high', effort: 'low', source: 'protocol_security',
      revenue_impact: { monthly_estimate_low: 1000, monthly_estimate_mid: 5000, monthly_estimate_high: 10000 },
    });
  }

  if (mcpSafety.has_suspicious_descriptions) {
    findings.p0.push({
      action: 'CRITICAL: MCP tool descriptions contain executable patterns',
      detail: 'Tool descriptions include eval(), function(), <script>, or javascript: patterns. AI agents may execute these as instructions. Sanitize all tool descriptions to contain only plain text.',
      impact: 'high', effort: 'low', source: 'protocol_security',
      revenue_impact: { monthly_estimate_low: 1000, monthly_estimate_mid: 5000, monthly_estimate_high: 10000 },
    });
  }

  if (!headers.has_hsts) {
    findings.p0.push({
      action: 'Enable HSTS (Strict-Transport-Security) header',
      detail: 'Without HSTS, agent-to-site communication can be intercepted via TLS downgrade attacks. AI agents making API calls to your site are especially vulnerable. Add: Strict-Transport-Security: max-age=31536000; includeSubDomains',
      impact: 'high', effort: 'low', source: 'protocol_security',
      revenue_impact: { monthly_estimate_low: 500, monthly_estimate_mid: 2000, monthly_estimate_high: 5000 },
    });
  }

  // ── P1: Important Security Issues ──

  if (!headers.has_csp) {
    findings.p1.push({
      action: 'Deploy Content Security Policy (CSP) header',
      detail: 'No CSP detected. Without CSP, injected scripts can intercept MCP tool calls, exfiltrate agent-card data, and poison A2UI components. This is the primary defense against cross-layer attacks.',
      impact: 'high', effort: 'medium', source: 'protocol_security',
      revenue_impact: { monthly_estimate_low: 300, monthly_estimate_mid: 1500, monthly_estimate_high: 3000 },
    });
  } else {
    if (headers.csp_allows_unsafe_inline) {
      findings.p1.push({
        action: 'Remove unsafe-inline from CSP',
        detail: "CSP allows 'unsafe-inline' which defeats XSS protection. Inline scripts can intercept WebMCP tool registrations and poison navigator.modelContext. Use nonces or hashes instead.",
        impact: 'high', effort: 'medium', source: 'protocol_security',
      });
    }
    if (headers.csp_allows_unsafe_eval) {
      findings.p1.push({
        action: 'Remove unsafe-eval from CSP',
        detail: "CSP allows 'unsafe-eval' which enables code injection attacks. Attackers can dynamically generate malicious MCP tool definitions at runtime.",
        impact: 'high', effort: 'medium', source: 'protocol_security',
      });
    }
  }

  if (checks.agent_card?.exists && !agentCard.has_signed_card) {
    findings.p1.push({
      action: 'Sign your agent-card.json with a verifiable cryptographic signature',
      detail: 'Your agent card is unsigned — any MITM or DNS hijack can replace it with a malicious version. Signed cards let other agents verify authenticity before trusting your capabilities.',
      impact: 'high', effort: 'medium', source: 'protocol_security',
      revenue_impact: { monthly_estimate_low: 200, monthly_estimate_mid: 800, monthly_estimate_high: 2000 },
    });
  }

  if (headers.is_wildcard_cors) {
    findings.p1.push({
      action: 'Replace wildcard CORS (*) with explicit origin allowlist',
      detail: 'Access-Control-Allow-Origin: * allows any origin to make authenticated requests. Malicious sites can call your agent endpoints and exfiltrate data.',
      impact: 'high', effort: 'low', source: 'protocol_security',
    });
  }

  if (!headers.has_x_frame_options) {
    findings.p1.push({
      action: 'Add X-Frame-Options header to prevent clickjacking',
      detail: 'Without X-Frame-Options, your site can be embedded in a malicious iframe. Attackers can overlay fake A2UI components to trick agents into executing unintended actions.',
      impact: 'medium', effort: 'low', source: 'protocol_security',
    });
  }

  // ── P2: Security Hardening ──

  if (!headers.has_x_content_type_options) {
    findings.p2.push({
      action: 'Add X-Content-Type-Options: nosniff header',
      detail: 'Prevents MIME-type sniffing that can lead to script execution from mistyped content. Agents parsing your responses may be tricked into executing non-script content as code.',
      impact: 'low', effort: 'low', source: 'protocol_security',
    });
  }

  if (!headers.has_permissions_policy) {
    findings.p2.push({
      action: 'Deploy Permissions-Policy header',
      detail: 'Restrict browser feature access (camera, microphone, geolocation) to prevent malicious iframes from accessing sensitive capabilities through embedded A2UI components.',
      impact: 'low', effort: 'low', source: 'protocol_security',
    });
  }

  if (scriptSafety.total_external_scripts > 0 && scriptSafety.sri_coverage_pct < 50) {
    findings.p2.push({
      action: `Add Subresource Integrity (SRI) to external scripts (${scriptSafety.sri_coverage_pct}% coverage)`,
      detail: `${scriptSafety.total_external_scripts - scriptSafety.external_scripts_with_sri} external script(s) lack integrity hashes. Compromised CDNs can inject malicious code that intercepts MCP tool registrations — this is the supply chain attack vector.`,
      impact: 'medium', effort: 'medium', source: 'protocol_security',
    });
  }

  return findings;
}

// ── Protocol Security Score Rules (for drill-down UI) ──

const SECURITY_SCORE_RULES = {
  transport_security: [
    { name: 'HSTS Enabled', check: (s) => s.headers?.has_hsts, points: 10, desc: 'Strict-Transport-Security header prevents TLS downgrade attacks' },
    { name: 'HSTS 1yr+', check: (s) => s.headers?.hsts_max_age >= 31536000, points: 5, altCheck: (s) => s.headers?.hsts_max_age >= 2592000, altPoints: 2, desc: 'HSTS max-age at least 1 year for HSTS preload eligibility' },
    { name: 'X-Content-Type-Options', check: (s) => s.headers?.has_x_content_type_options, points: 5, desc: 'Prevents MIME-type sniffing attacks' },
  ],
  content_security_policy: [
    { name: 'CSP Present', check: (s) => s.headers?.has_csp, points: 8, desc: 'Content Security Policy header deployed' },
    { name: 'default-src Defined', check: (s) => s.headers?.csp_has_default_src, points: 4, desc: 'Fallback directive for unspecified resource types' },
    { name: 'No unsafe-inline', check: (s) => s.headers?.has_csp && !s.headers?.csp_allows_unsafe_inline, points: 4, desc: 'Inline scripts blocked (use nonces/hashes instead)' },
    { name: 'No unsafe-eval', check: (s) => s.headers?.has_csp && !s.headers?.csp_allows_unsafe_eval, points: 4, desc: 'Dynamic code execution blocked' },
  ],
  mcp_tool_safety: [
    { name: 'No Unicode Obfuscation', check: (s) => !s.mcp_safety?.has_unicode_obfuscation, points: 10, desc: 'Tool descriptions free of hidden Unicode manipulation characters' },
    { name: 'No Executable Patterns', check: (s) => !s.mcp_safety?.has_suspicious_descriptions, points: 10, desc: 'Tool descriptions contain only safe plain text' },
  ],
  agent_card_verification: [
    { name: 'Signed Agent Card', check: (s, c) => !c.agent_card?.exists || s.agent_card?.has_signed_card, points: 15, desc: 'Agent card cryptographically signed for authenticity verification' },
  ],
  script_integrity: [
    { name: 'X-Frame-Options', check: (s) => s.headers?.has_x_frame_options, points: 5, desc: 'Prevents clickjacking via iframe embedding' },
    { name: 'SRI Coverage ≥80%', check: (s) => s.script_safety?.sri_coverage_pct >= 80, points: 5, altCheck: (s) => s.script_safety?.sri_coverage_pct >= 40, altPoints: 2, desc: 'External scripts verified with integrity hashes' },
    { name: 'No Wildcard CORS', check: (s) => !s.headers?.is_wildcard_cors, points: 5, desc: 'CORS restricted to explicit origins' },
  ],
  cross_layer_defense: [
    { name: 'Permissions-Policy', check: (s) => s.headers?.has_permissions_policy, points: 5, desc: 'Browser feature access restricted' },
    { name: 'Defense-in-Depth', check: (s) => s.headers?.has_csp && s.headers?.has_hsts && s.headers?.has_x_frame_options, points: 5, desc: 'All three core security headers deployed together' },
  ],
};

function getSecurityScoreBreakdown(dimension, securitySignals, checks) {
  const rules = SECURITY_SCORE_RULES[dimension];
  if (!rules) return null;

  const breakdown = rules.map(rule => {
    let passed = false;
    let awarded = 0;
    try {
      if (rule.check(securitySignals, checks)) { passed = true; awarded = rule.points; }
      else if (rule.altCheck && rule.altCheck(securitySignals, checks)) { passed = true; awarded = rule.altPoints; }
    } catch {}
    return { name: rule.name, description: rule.desc, points: awarded, maxPoints: rule.points, passed };
  });

  const passed = breakdown.filter(b => b.passed).length;
  const total = breakdown.length;

  return { dimension, passed, failed: total - passed, total, breakdown };
}

module.exports = {
  computeScores, getGrade, generateFindings,
  calculateMarketingHealth, generateMarketingFindings, getScoreBreakdown,
  calculateSeoHealth, calculateForgeScore, generateSeoFindings, getSeoScoreBreakdown,
  calculateProtocolSecurity, generateSecurityFindings, getSecurityScoreBreakdown,
};
