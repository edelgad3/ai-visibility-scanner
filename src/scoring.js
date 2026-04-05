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
  let agentReady = 0;
  if (checks.llms_txt.exists) agentReady += 10;
  if (checks.llms_full_txt.exists) agentReady += 5;
  if (checks.agent_card.exists) agentReady += 10;
  if (checks.ucp.exists) agentReady += 5;
  if (checks.aeo.has_declarative_webmcp) agentReady += 15;
  if (checks.aeo.semantic_score >= 5) agentReady += 10;
  else if (checks.aeo.semantic_score >= 3) agentReady += 5;
  if (checks.aeo.aria_count >= 5) agentReady += 5;
  if (checks.sitemap.exists) agentReady += 5;
  if (!checks.media.is_spa) agentReady += 10;
  if (checks.schema.schema_count >= 3) agentReady += 5;
  if (checks.meta.has_structured_contact) agentReady += 5;
  if (checks.digital_assets.has_digital_assets && checks.digital_assets.has_digital_asset_schema) agentReady += 5;
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

module.exports = { computeScores, getGrade, generateFindings, calculateMarketingHealth, generateMarketingFindings };
