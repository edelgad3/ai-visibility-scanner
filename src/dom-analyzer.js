const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

// Browser pool: each scan gets its own browser instance to prevent race conditions.
// Active browsers tracked by a ref-counted pool for cleanup.
const _activeBrowsers = new Set();

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  _activeBrowsers.add(browser);
  return browser;
}

async function releaseBrowser(browser) {
  if (browser) {
    _activeBrowsers.delete(browser);
    try { await browser.close(); } catch {}
  }
}

// Close all browsers (used during graceful shutdown)
async function closeBrowser() {
  for (const b of _activeBrowsers) {
    try { await b.close(); } catch {}
  }
  _activeBrowsers.clear();
}

/**
 * Analyze a single page with dual-fetch (raw HTTP + Puppeteer JS).
 * Returns structured page data matching the unified-audit-data.json schema.
 *
 * @param {string} url - Page URL to analyze
 * @param {string} pageType - "homepage" or "subpage"
 * @param {boolean} extractSignals - If true, extract schema/meta/media/aeo signals (homepage only)
 */
async function analyzePage(url, pageType = 'homepage', extractSignals = true, browser = null) {
  // If no browser provided, create one (caller should manage lifecycle for batches)
  const ownsBrowser = !browser;
  if (!browser) browser = await createBrowser();

  // 1. Raw HTML Fetch (No JS — what crawlers/LLMs see)
  const noJsStart = Date.now();
  let rawHtml = '';
  let rawStatus = 0;
  try {
    const rawRes = await axios.get(url, {
      validateStatus: () => true,
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeScanner/2.0)' }
    });
    rawStatus = rawRes.status;
    rawHtml = typeof rawRes.data === 'string' ? rawRes.data : '';
  } catch (e) {
    console.error(`  Raw fetch failed for ${url}: ${e.message}`);
  }
  const responseTime = Date.now() - noJsStart;
  const $raw = cheerio.load(rawHtml);

  // 2. Puppeteer Fetch (JS Rendered — what users see)
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (compatible; ForgeScanner/2.0; Puppeteer)');

  let jsHtml = '';
  let statusCode = rawStatus;
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (response) statusCode = response.status();
    // Wait a bit for animations/hydration
    await new Promise(r => setTimeout(r, 1500));
    jsHtml = await page.content();
  } catch (err) {
    console.error(`  Puppeteer failed for ${url}: ${err.message}`);
    jsHtml = rawHtml; // Fallback to raw
  }
  await page.close();

  const $js = cheerio.load(jsHtml);

  // 3. Marketing Page Scores (0-10 each)
  const scores = scoreMarketingPage($js, jsHtml);
  const overall = Math.round(((scores.seo + scores.cta + scores.trust + scores.tracking) / 4) * 10) / 10;

  // 3b. SEO Details (quality/length data for SEO Health scoring)
  const seoDetails = extractSeoDetails($js, jsHtml, url);

  // 4. JS Diff (Puppeteer-exclusive evidence)
  const jsDiff = computeJsDiff($raw, $js, rawHtml, jsHtml);

  // 5. Extract AI signals (schema, meta, media, aeo) — typically from homepage
  let extracted = null;
  if (extractSignals) {
    extracted = extractAISignals($js, jsHtml, rawHtml, $raw);
  }

  // 6. Discover internal links (for subpage crawling)
  const internalLinks = [];
  if (pageType === 'homepage') {
    const baseUrl = new URL(url);
    $js('a[href]').each((i, el) => {
      const href = $js(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      try {
        const resolved = new URL(href, url);
        if (resolved.hostname === baseUrl.hostname && resolved.pathname !== '/' && resolved.pathname !== '') {
          const clean = resolved.origin + resolved.pathname.replace(/\/$/, '');
          if (!internalLinks.includes(clean)) {
            internalLinks.push(clean);
          }
        }
      } catch (e) {}
    });
  }

  // If we created the browser ourselves, release it
  if (ownsBrowser) await releaseBrowser(browser);

  return {
    url,
    type: pageType,
    status_code: statusCode,
    response_time_ms: responseTime,
    scores,
    overall,
    seo_details: seoDetails,
    js_diff: jsDiff,
    extracted,
    _internalLinks: internalLinks, // Used by index.js for subpage discovery, stripped from output
  };
}


/**
 * Score a page on 4 marketing dimensions (0-10 each).
 */
function scoreMarketingPage($, html) {
  const htmlLower = html.toLowerCase();

  // SEO (0-10)
  let seo = 0;
  if ($('title').length > 0 && $('title').text().trim().length > 0) seo += 2;
  if ($('meta[name="description"]').attr('content')?.trim().length > 0) seo += 2;
  if ($('h1').length > 0) seo += 1;
  if ($('link[rel="canonical"]').length > 0) seo += 1;
  if ($('meta[property="og:title"]').length > 0) seo += 1;
  if ($('meta[name="viewport"]').length > 0) seo += 1;
  if ($('script[type="application/ld+json"]').length > 0) seo += 1;
  if ($('img[alt]').length > 0) seo += 1;
  seo = Math.min(10, seo);

  // CTA (0-10)
  let cta = 0;
  const ctaTexts = ['get started', 'contact', 'book', 'schedule', 'free', 'demo', 'try', 'sign up', 'start', 'request', 'learn more'];
  const buttons = $('button, a.btn, a.button, [role="button"], input[type="submit"]');
  const ctaCount = buttons.length;
  if (ctaCount >= 1) cta += 2;
  if (ctaCount >= 3) cta += 2;
  if (ctaCount >= 5) cta += 1;
  // Check for CTA text matches
  let ctaTextMatches = 0;
  buttons.each((i, el) => {
    const text = $(el).text().toLowerCase();
    if (ctaTexts.some(t => text.includes(t))) ctaTextMatches++;
  });
  if (ctaTextMatches >= 1) cta += 2;
  if (ctaTextMatches >= 2) cta += 1;
  if ($('form').length > 0) cta += 2;
  cta = Math.min(10, cta);

  // Trust (0-10)
  let trust = 0;
  if (htmlLower.includes('https://') || htmlLower.includes('ssl')) trust += 1;
  if ($('a[href^="mailto:"]').length > 0) trust += 1;
  if ($('a[href^="tel:"]').length > 0) trust += 1;
  const trustWords = ['testimonial', 'review', 'client', 'case study', 'partner', 'trusted', 'featured'];
  const bodyText = $('body').text().toLowerCase();
  trustWords.forEach(w => { if (bodyText.includes(w)) trust += 1; });
  if ($('a[href*="privacy"]').length > 0 || bodyText.includes('privacy policy')) trust += 1;
  if ($('a[href*="linkedin"], a[href*="twitter"], a[href*="facebook"]').length > 0) trust += 1;
  trust = Math.min(10, trust);

  // Tracking (0-10)
  let tracking = 0;
  const trackingPatterns = [
    { pattern: 'googletagmanager', points: 3 },
    { pattern: 'google-analytics', points: 3 },
    { pattern: 'gtag(', points: 3 },
    { pattern: 'ga(', points: 2 },
    { pattern: 'plausible', points: 3 },
    { pattern: 'mixpanel', points: 2 },
    { pattern: 'hotjar', points: 2 },
    { pattern: 'fbq(', points: 2 },
    { pattern: 'analytics', points: 1 },
    { pattern: 'segment', points: 2 },
    { pattern: 'posthog', points: 2 },
  ];
  trackingPatterns.forEach(({ pattern, points }) => {
    if (htmlLower.includes(pattern)) tracking += points;
  });
  tracking = Math.min(10, tracking);

  return { seo, cta, trust, tracking };
}


/**
 * Extract detailed SEO signals for the SEO Health score.
 * Runs alongside scoreMarketingPage — provides quality/length data, not just presence.
 */
function extractSeoDetails($, html, url) {
  // Title tag
  const titleText = $('title').text().trim();
  const titleLength = titleText.length;
  const titleQuality = !titleText ? 'missing' : titleLength < 30 ? 'short' : titleLength > 60 ? 'long' : 'good';

  // Meta description
  const descText = ($('meta[name="description"]').attr('content') || '').trim();
  const descLength = descText.length;
  const descQuality = !descText ? 'missing' : descLength < 120 ? 'short' : descLength > 160 ? 'long' : 'good';

  // H1 analysis
  const h1Elements = $('h1');
  const h1Count = h1Elements.length;
  const h1Text = h1Elements.first().text().trim();

  // Heading hierarchy (H1 > H2 > H3 in proper order)
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push(parseInt($(el).prop('tagName').replace('H', ''), 10));
  });
  let hierarchyValid = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) { hierarchyValid = false; break; }
  }

  // Image analysis
  const totalImages = $('img').length;
  const imagesWithAlt = $('img[alt]').filter((_, el) => $(el).attr('alt').trim().length > 0).length;
  const altCoverage = totalImages > 0 ? Math.round((imagesWithAlt / totalImages) * 100) : 100;
  const imagesWithDimensions = $('img[width][height]').length;
  const imagesLazyLoaded = $('img[loading="lazy"]').length;

  // Structured data count
  const schemaCount = $('script[type="application/ld+json"]').length;

  // OG tag completeness
  const ogTags = {
    title: !!$('meta[property="og:title"]').attr('content'),
    description: !!$('meta[property="og:description"]').attr('content'),
    image: !!$('meta[property="og:image"]').attr('content'),
    url: !!$('meta[property="og:url"]').attr('content'),
    type: !!$('meta[property="og:type"]').attr('content'),
  };
  const ogComplete = Object.values(ogTags).filter(Boolean).length;

  // Canonical
  const canonical = $('link[rel="canonical"]').attr('href') || null;

  // Viewport
  const hasViewport = $('meta[name="viewport"]').length > 0;

  // Internal links on this page
  const internalLinkUrls = [];
  try {
    const baseUrl = new URL(url);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      try {
        const resolved = new URL(href, url);
        if (resolved.hostname === baseUrl.hostname) {
          internalLinkUrls.push(resolved.href);
        }
      } catch {}
    });
  } catch {}

  return {
    title: { text: titleText, length: titleLength, quality: titleQuality },
    description: { text: descText, length: descLength, quality: descQuality },
    h1: { count: h1Count, text: h1Text },
    heading_hierarchy_valid: hierarchyValid,
    images: {
      total: totalImages,
      with_alt: imagesWithAlt,
      alt_coverage_pct: altCoverage,
      with_dimensions: imagesWithDimensions,
      lazy_loaded: imagesLazyLoaded,
    },
    schema_count: schemaCount,
    og_tags: ogTags,
    og_complete: ogComplete,
    canonical,
    has_viewport: hasViewport,
    internal_link_count: internalLinkUrls.length,
    _internal_link_urls: internalLinkUrls, // Used for broken link checking, stripped from output
  };
}


/**
 * Check for broken links on a page (HEAD requests, max 50 links, 3s timeout each).
 * Returns array of { url, status_code } for non-200 responses.
 */
async function checkBrokenLinks(linkUrls, maxLinks = 50) {
  const unique = [...new Set(linkUrls)].slice(0, maxLinks);
  if (unique.length === 0) return [];

  const broken = [];
  const results = await Promise.allSettled(
    unique.map(async (linkUrl) => {
      try {
        const resp = await axios.head(linkUrl, {
          timeout: 3000,
          validateStatus: () => true,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeScanner/2.0)' },
          maxRedirects: 5,
        });
        if (resp.status >= 400) {
          broken.push({ url: linkUrl, status_code: resp.status });
        }
        return { url: linkUrl, status: resp.status };
      } catch {
        // Timeout or connection error — count as potentially broken
        broken.push({ url: linkUrl, status_code: 0 });
        return { url: linkUrl, status: 0 };
      }
    })
  );

  return broken;
}


/**
 * Compute the JS diff between raw HTML and Puppeteer-rendered HTML.
 */
function computeJsDiff($raw, $js, rawHtml, jsHtml) {
  const rawNodes = $raw('*').length;
  const jsNodes = $js('*').length;
  const rawSchemas = $raw('script[type="application/ld+json"]').length;
  const jsSchemas = $js('script[type="application/ld+json"]').length;
  const rawForms = $raw('form').length;
  const jsForms = $js('form').length;

  // Detect text content that changes between raw and JS-rendered
  const textContentChanged = [];

  // Look for counter/stat patterns: numbers that are 0 in raw but populated in JS
  const counterSelectors = ['.counter', '.stat', '.number', '[data-count]', '[data-value]'];
  counterSelectors.forEach(sel => {
    $js(sel).each((i, el) => {
      const jsText = $js(el).text().trim();
      // Find matching element in raw HTML
      const rawEl = $raw(sel).eq(i);
      const rawText = rawEl.length ? rawEl.text().trim() : '';
      if (rawText !== jsText && rawText.length > 0 && jsText.length > 0) {
        textContentChanged.push({
          selector: sel,
          no_js_text: rawText,
          js_text: jsText,
          description: 'Content differs between raw HTML and JS-rendered DOM'
        });
      }
    });
  });

  // Check for 0% / 0 patterns in raw that become real values in JS
  const rawZeros = (rawHtml.match(/>\s*0\s*%\s*</g) || []).length;
  const jsZeros = (jsHtml.match(/>\s*0\s*%\s*</g) || []).length;
  if (rawZeros > jsZeros && rawZeros > 0) {
    textContentChanged.push({
      selector: 'body',
      no_js_text: '0%',
      js_text: '(populated by JS animation)',
      description: `${rawZeros - jsZeros} animated counter(s) show 0% to crawlers`
    });
  }

  return {
    elements_added: jsNodes - rawNodes,
    schemas_injected_by_js: jsSchemas - rawSchemas,
    forms_added_by_js: jsForms - rawForms,
    text_content_changed: textContentChanged
  };
}


/**
 * Extract AI visibility signals from the rendered DOM.
 * Returns schema, meta, media, and aeo data matching the unified schema.
 */
function extractAISignals($js, jsHtml, rawHtml, $raw) {
  const htmlLower = jsHtml.toLowerCase();

  // Parse JSON-LD schemas
  const schemas = [];
  $js('script[type="application/ld+json"]').each((i, el) => {
    try {
      const parsed = JSON.parse($js(el).html());
      if (Array.isArray(parsed)) schemas.push(...parsed);
      else schemas.push(parsed);
    } catch (e) {}
  });
  const schemaStr = JSON.stringify(schemas).toLowerCase();

  const schema = {
    has_organization: schemaStr.includes('"organization"'),
    has_service: schemaStr.includes('"service"'),
    has_product: schemaStr.includes('"product"'),
    has_faq: schemaStr.includes('"faqpage"'),
    has_person: schemaStr.includes('"person"'),
    has_breadcrumb: schemaStr.includes('"breadcrumblist"'),
    has_howto: schemaStr.includes('"howto"'),
    has_speakable: schemaStr.includes('"speakable"'),
    has_image_object: schemaStr.includes('"imageobject"'),
    has_video_object: schemaStr.includes('"videoobject"'),
    has_machine_catalog: false,
    schema_count: schemas.length,
    has_software_app: schemaStr.includes('"softwareapplication"'),
    has_data_download: schemaStr.includes('"datadownload"'),
    has_digital_document: schemaStr.includes('"digitaldocument"'),
    has_media_object: schemaStr.includes('"mediaobject"'),
    has_creative_work: schemaStr.includes('"creativework"'),
  };

  const meta = {
    has_canonical: $js('link[rel="canonical"]').length > 0,
    has_structured_contact: $js('a[href^="mailto:"], a[href^="tel:"]').length > 0,
  };

  const imgTotal = $js('img').length;
  const imgWithAlt = $js('img[alt]').filter((i, el) => ($js(el).attr('alt') || '').trim().length > 0).length;
  const media = {
    has_og_image: $js('meta[property="og:image"]').length > 0,
    has_twitter_card: $js('meta[name="twitter:card"]').length > 0,
    images_total: imgTotal,
    images_with_alt: imgWithAlt,
    images_with_alt_pct: imgTotal > 0 ? Math.round((imgWithAlt / imgTotal) * 1000) / 10 : 0,
    has_video: $js('video, iframe[src*="youtube.com"], iframe[src*="vimeo.com"]').length > 0,
    has_webp_avif: $js('img[src*=".webp"], img[src*=".avif"], source[type="image/webp"], source[type="image/avif"]').length > 0,
    has_srcset: $js('img[srcset]').length > 0,
    has_infographic: false,
    is_spa: $raw('a').length < 5 && $raw('#root, #app, #__next').length > 0,
  };

  // AEO: WebMCP, semantic HTML, ARIA
  const formCount = $js('form').length;
  const declarativeForms = [];
  $js('form').each((i, el) => {
    const $form = $js(el);
    const toolname = $form.attr('toolname');
    const tooldescription = $form.attr('tooldescription');
    if (toolname || tooldescription) {
      declarativeForms.push({
        toolname: toolname || '',
        tooldescription: tooldescription || '',
        autosubmit: $form.attr('data-autosubmit') === 'true',
        action: $form.attr('action') || '',
      });
    }
  });

  // Count ALL aria-* attributes across entire DOM
  let ariaCount = 0;
  let interactiveWithoutAria = 0;
  $js('*').each((i, el) => {
    const attribs = el.attribs || {};
    for (const attr in attribs) {
      if (attr.startsWith('aria-')) ariaCount++;
    }
  });
  // Check interactive elements for accessible names
  $js('button, input, select, textarea, a[role="button"], [role="button"]').each((i, el) => {
    const attribs = el.attribs || {};
    const hasLabel = attribs['aria-label'] || attribs['aria-labelledby'] || attribs['title'];
    if (!hasLabel) interactiveWithoutAria++;
  });

  const semanticTags = {
    main: $js('main').length,
    article: $js('article').length,
    section: $js('section').length,
    nav: $js('nav').length,
    aside: $js('aside').length,
    footer: $js('footer').length,
    header: $js('header').length,
  };

  const hasMain = semanticTags.main > 0;
  const hasArticle = semanticTags.article > 0;
  const hasSection = semanticTags.section > 0;
  const hasNav = semanticTags.nav > 0;
  const hasFooter = semanticTags.footer > 0;
  const hasHeader = semanticTags.header > 0;
  const semanticScore = [hasMain, hasArticle, hasSection, hasNav, hasFooter, hasHeader].filter(Boolean).length;

  const aeo = {
    has_declarative_webmcp: declarativeForms.length > 0,
    declarative_forms: declarativeForms,
    declarative_form_count: declarativeForms.length,
    forms_without_webmcp: formCount - declarativeForms.length,
    form_count: formCount,
    semantic_tags: semanticTags,
    has_main: hasMain,
    has_article: hasArticle,
    has_section: hasSection,
    has_nav: hasNav,
    has_footer: hasFooter,
    has_header: hasHeader,
    semantic_score: semanticScore,
    aria_count: ariaCount,
    interactive_without_aria: interactiveWithoutAria,
    has_aria_labels: ariaCount > 0,
  };

  // Digital assets
  const downloadLinkCount = ($js('a[href$=".pdf"], a[href$=".zip"], a[href$=".doc"], a[href$=".docx"], a[href$=".xls"], a[href$=".xlsx"], a[href$=".csv"], a[href$=".mp3"], a[href$=".mp4"]').length);
  const downloadAttrCount = $js('a[download]').length;
  const digital_assets = {
    download_link_count: downloadLinkCount,
    download_attr_count: downloadAttrCount,
    has_digital_assets: (downloadLinkCount + downloadAttrCount) > 0,
    has_transcripts: htmlLower.includes('transcript') || htmlLower.includes('caption') || htmlLower.includes('.srt') || htmlLower.includes('.vtt'),
    has_digital_asset_schema: schema.has_software_app || schema.has_data_download || schema.has_digital_document || schema.has_media_object,
  };

  return { schema, meta, media, aeo, digital_assets };
}


/**
 * Discover subpages from internal links.
 * Matches against priority paths (about, services, pricing, contact, blog).
 */
function discoverSubpages(internalLinks, maxPages = 5) {
  const priorityPaths = [
    { type: 'subpage', keywords: ['about', 'about-us', 'team', 'our-story'] },
    { type: 'subpage', keywords: ['services', 'solutions', 'products', 'features', 'what-we-do'] },
    { type: 'subpage', keywords: ['pricing', 'plans', 'price', 'packages'] },
    { type: 'subpage', keywords: ['contact', 'contact-us', 'get-in-touch'] },
    { type: 'subpage', keywords: ['blog', 'articles', 'news', 'resources', 'insights'] },
  ];

  const found = [];
  const usedTypes = new Set();

  for (const { type, keywords } of priorityPaths) {
    if (found.length >= maxPages) break;
    for (const link of internalLinks) {
      try {
        const pathname = new URL(link).pathname.toLowerCase().replace(/\/$/, '');
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length > 0 && keywords.some(kw => segments.includes(kw))) {
          if (!found.some(f => f.url === link)) {
            found.push({ url: link, type });
            break; // One match per priority group
          }
        }
      } catch (e) {}
    }
  }

  // If we didn't find enough via links, try common paths directly
  if (found.length < maxPages && internalLinks.length > 0) {
    const baseUrl = new URL(internalLinks[0]).origin;
    const fallbackPaths = ['/about', '/services', '/pricing', '/contact', '/blog'];
    for (const p of fallbackPaths) {
      if (found.length >= maxPages) break;
      const testUrl = baseUrl + p;
      if (!found.some(f => f.url === testUrl)) {
        found.push({ url: testUrl, type: 'subpage' });
      }
    }
  }

  return found;
}

module.exports = { analyzePage, closeBrowser, createBrowser, releaseBrowser, discoverSubpages, checkBrokenLinks, extractSeoDetails };
