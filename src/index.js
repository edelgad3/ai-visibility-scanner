#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const { probeEndpoints } = require('./endpoints');
const { analyzePage, closeBrowser, discoverSubpages } = require('./dom-analyzer');
const { computeScores, getGrade, generateFindings, calculateMarketingHealth, generateMarketingFindings } = require('./scoring');

program
  .requiredOption('--url <url>', 'Target URL')
  .requiredOption('--slug <slug>', 'Client Slug')
  .option('--industry <industry>', 'Industry vertical', 'general')
  .option('--competitors <competitors>', 'Comma-separated competitor URLs', '')
  .option('--max-pages <n>', 'Max subpages to scan', '5')
  .parse(process.argv);

const options = program.opts();
const MAX_SUBPAGES = parseInt(options.maxPages, 10);

async function run() {
  const startTime = Date.now();

  console.log('============================================================');
  console.log('  FORGE SCANNER (Node.js + Puppeteer)');
  console.log(`  URL:      ${options.url}`);
  console.log(`  Slug:     ${options.slug}`);
  console.log(`  Industry: ${options.industry}`);
  console.log('============================================================');

  try {
    // ── Step 1: Probe infrastructure endpoints ──
    console.log('\n[1/4] Probing infrastructure endpoints...');
    const rawEndpoints = await probeEndpoints(options.url);
    console.log(`  robots.txt: ${rawEndpoints.robots.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  sitemap.xml: ${rawEndpoints.sitemap.exists ? `FOUND (${rawEndpoints.sitemap.url_count} URLs)` : 'MISSING'}`);
    console.log(`  llms.txt: ${rawEndpoints.llms_txt.exists ? `FOUND (${rawEndpoints.llms_txt.length} chars)` : 'MISSING'}`);
    console.log(`  llms-full.txt: ${rawEndpoints.llms_full_txt.exists ? `FOUND (${rawEndpoints.llms_full_txt.length} chars)` : 'MISSING'}`);
    console.log(`  agent-card.json: ${rawEndpoints.agent_card.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  ucp: ${rawEndpoints.ucp.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  a2ui-config: ${rawEndpoints.a2ui.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  ag-ui manifest: ${rawEndpoints.ag_ui.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  acp: ${rawEndpoints.acp.exists ? 'FOUND' : 'MISSING'}`);
    console.log(`  anp/did: ${rawEndpoints.anp.exists ? 'FOUND' : 'MISSING'}${rawEndpoints.anp.has_did ? ' (DID doc)' : ''}`);

    // ── Step 2: Analyze homepage (with full signal extraction) ──
    console.log('\n[2/4] Analyzing homepage (raw HTTP + Puppeteer JS)...');
    const homepageAnalysis = await analyzePage(options.url, 'homepage', true);
    console.log(`  Status: ${homepageAnalysis.status_code}`);
    console.log(`  Response: ${homepageAnalysis.response_time_ms}ms`);
    console.log(`  JS Diff: ${homepageAnalysis.js_diff.elements_added} elements added by JS`);
    console.log(`  Schemas: ${homepageAnalysis.extracted.schema.schema_count} JSON-LD blocks`);
    console.log(`  Forms: ${homepageAnalysis.extracted.aeo.form_count} (${homepageAnalysis.extracted.aeo.declarative_form_count} WebMCP)`);
    console.log(`  ARIA: ${homepageAnalysis.extracted.aeo.aria_count} attributes`);
    console.log(`  Scores: SEO=${homepageAnalysis.scores.seo} CTA=${homepageAnalysis.scores.cta} Trust=${homepageAnalysis.scores.trust} Track=${homepageAnalysis.scores.tracking}`);

    // ── Step 3: Discover and scan subpages ──
    console.log(`\n[3/4] Scanning subpages (max ${MAX_SUBPAGES})...`);
    const subpageCandidates = discoverSubpages(homepageAnalysis._internalLinks || [], MAX_SUBPAGES);
    const subpageResults = [];

    for (const candidate of subpageCandidates) {
      console.log(`  Scanning: ${candidate.url}`);
      try {
        const result = await analyzePage(candidate.url, 'subpage', false);
        if (result.status_code === 200) {
          subpageResults.push(result);
          console.log(`    OK — SEO=${result.scores.seo} CTA=${result.scores.cta} Trust=${result.scores.trust} Track=${result.scores.tracking}`);
        } else {
          console.log(`    SKIP — Status ${result.status_code}`);
        }
      } catch (e) {
        console.log(`    FAIL — ${e.message}`);
      }
    }

    // Close shared browser
    await closeBrowser();

    // ── Step 4: Assemble unified output ──
    console.log('\n[4/4] Assembling unified audit data...');

    // Build checks object from endpoints + homepage extraction
    const checks = {
      robots: rawEndpoints.robots,
      sitemap: rawEndpoints.sitemap,
      llms_txt: rawEndpoints.llms_txt,
      llms_full_txt: rawEndpoints.llms_full_txt,
      agent_card: rawEndpoints.agent_card,
      ucp: rawEndpoints.ucp,
      a2ui: rawEndpoints.a2ui,
      ag_ui: rawEndpoints.ag_ui,
      acp: rawEndpoints.acp,
      anp: rawEndpoints.anp,
      schema: homepageAnalysis.extracted.schema,
      meta: homepageAnalysis.extracted.meta,
      media: homepageAnalysis.extracted.media,
      aeo: homepageAnalysis.extracted.aeo,
      digital_assets: homepageAnalysis.extracted.digital_assets,
      protocol_signals: homepageAnalysis.extracted.protocol_signals,
    };

    // AI Visibility scores
    const aiScores = computeScores(checks);

    // All pages for marketing scoring
    const allPages = [homepageAnalysis, ...subpageResults].map(p => ({
      url: p.url,
      type: p.type,
      status_code: p.status_code,
      response_time_ms: p.response_time_ms,
      scores: p.scores,
      overall: p.overall,
      js_diff: p.js_diff,
    }));

    // Marketing Health (6-dimension scoring from all pages)
    const marketingHealth = calculateMarketingHealth(allPages, checks);

    // Findings
    const aiFindings = generateFindings(checks);
    const marketingFindings = generateMarketingFindings(marketingHealth, checks);

    // Merge marketing findings into priority buckets
    for (const mf of marketingFindings) {
      const entry = {
        action: mf.action,
        detail: mf.detail || '',
        category: mf.category || 'Marketing',
        effort: mf.effort || 'medium',
        impact: mf.impact || 'medium',
        source: 'marketing_health',
        revenue_impact: mf.revenue_impact || {},
      };
      if (mf.priority === 'critical') aiFindings.p0.push(entry);
      else if (mf.priority === 'high') aiFindings.p1.push(entry);
      else aiFindings.p2.push(entry);
    }

    // Unified recommendations (sorted P0 → P1 → P2)
    const recommendations = [];
    for (const priority of ['p0', 'p1', 'p2']) {
      for (const finding of aiFindings[priority]) {
        recommendations.push({ priority: priority.toUpperCase(), ...finding });
      }
    }

    // Combined score
    const combinedOverall = Math.round(((aiScores.overall * 0.5) + (marketingHealth.overall * 0.5)) * 10) / 10;

    // Revenue impact aggregation
    const revenueImpact = {
      monthly_low: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_low || 0), 0),
      monthly_mid: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_mid || 0), 0),
      monthly_high: recommendations.reduce((s, r) => s + (r.revenue_impact?.monthly_estimate_high || 0), 0),
    };

    // Extract client name from homepage
    let clientName = '';
    try {
      clientName = new URL(options.url).hostname.replace('www.', '');
    } catch (e) {
      clientName = options.slug;
    }

    // Final output
    const outData = {
      client: {
        name: clientName,
        url: options.url,
        slug: options.slug,
        industry: options.industry,
        audit_date: new Date().toISOString().split('T')[0],
        business_type: { type: 'unknown', confidence: 50, focus: 'General analysis' },
      },
      scores: {
        ai_visibility: {
          overall: aiScores.overall,
          geo: aiScores.geo,
          multimodal: aiScores.multimodal,
          agent_ready: aiScores.agentReady,
          grade: aiScores.grade,
          checks,
        },
        marketing_health: marketingHealth,
        combined: {
          overall: combinedOverall,
          grade: getGrade(combinedOverall),
        },
      },
      findings: aiFindings,
      pages_analyzed: allPages,
      competitors: [],
      recommendations,
      revenue_impact: revenueImpact,
      brand: {
        colors: { all_colors: [] },
        typography: { heading_font: 'sans-serif', body_font: 'sans-serif' },
        content_inventory: { services: [], testimonials: [], team: [], contact: {} },
        profile: { vibe: '', tagline: '', value_proposition: '', theme_direction: '' },
      },
      metadata: {
        pipeline_version: '2.0.0',
        scanner: 'puppeteer-forge-scanner',
        scan_duration_ms: Date.now() - startTime,
        pages_scanned: allPages.length,
        js_rendering_enabled: true,
        generated_at: new Date().toISOString(),
      },
    };

    // Write output
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const outDir = path.join(projectRoot, 'clients', options.slug, 'audit');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const outPath = path.join(outDir, 'unified-audit-data.json');
    fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf-8');

    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n============================================================');
    console.log('  SCAN COMPLETE');
    console.log('============================================================');
    console.log(`  Client:         ${clientName}`);
    console.log(`  URL:            ${options.url}`);
    console.log(`  Pages scanned:  ${allPages.length}`);
    console.log(`  Duration:       ${duration}s`);
    console.log('');
    console.log(`  AI Visibility:  ${aiScores.overall}/100 (${aiScores.grade})`);
    console.log(`    GEO:          ${aiScores.geo}`);
    console.log(`    Multimodal:   ${aiScores.multimodal}`);
    console.log(`    Agent-Ready:  ${aiScores.agentReady}`);
    console.log('');
    console.log(`  Marketing:      ${marketingHealth.overall}/100 (${marketingHealth.grade})`);
    console.log(`  Combined:       ${combinedOverall}/100 (${getGrade(combinedOverall)})`);
    console.log('');
    console.log(`  Findings:       P0=${aiFindings.p0.length}  P1=${aiFindings.p1.length}  P2=${aiFindings.p2.length}`);
    console.log(`  Revenue:        $${revenueImpact.monthly_low.toLocaleString()} - $${revenueImpact.monthly_high.toLocaleString()}/mo`);
    console.log('');
    console.log(`  Output:         ${outPath}`);
    console.log('============================================================');

  } catch (e) {
    console.error('Scanner failed:', e);
    await closeBrowser();
    process.exit(1);
  }
}

run();
