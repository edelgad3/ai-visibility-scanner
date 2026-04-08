// PageSpeed Insights API integration — fetches Core Web Vitals + Lighthouse scores
// Free tier: 25,000 requests/day. One call per URL returns everything we need.

const PSI_API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_PAGESPEED_API_KEY;
const TIMEOUT_MS = 30000;

/**
 * Fetch PageSpeed Insights data for a URL.
 * Returns normalized scores or null on failure.
 */
async function fetchPageSpeedData(url, strategy = "mobile") {
  if (!API_KEY) {
    console.log("No Google API key — skipping PageSpeed check");
    return null;
  }

  const params = new URLSearchParams({
    url,
    key: API_KEY,
    strategy,
    category: ["performance", "seo", "accessibility", "best-practices"],
  });
  // URLSearchParams doesn't handle array params — fix manually
  const apiUrl = `${PSI_API}?url=${encodeURIComponent(url)}&key=${API_KEY}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const resp = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.error(`PageSpeed API error ${resp.status}: ${await resp.text().catch(() => "")}`);
      return null;
    }

    const raw = await resp.json();
    return normalizePageSpeedResults(raw);
  } catch (e) {
    if (e.name === "AbortError") {
      console.error(`PageSpeed API timeout (${TIMEOUT_MS}ms) for ${url}`);
    } else {
      console.error(`PageSpeed API failed for ${url}: ${e.message}`);
    }
    return null;
  }
}

/**
 * Extract structured data from the PSI API response.
 */
function normalizePageSpeedResults(raw) {
  const lhr = raw.lighthouseResult;
  if (!lhr) return null;

  const audit = (id) => lhr.audits?.[id] || {};
  const catScore = (id) => Math.round((lhr.categories?.[id]?.score || 0) * 100);

  // Core Web Vitals
  const lcp = audit("largest-contentful-paint").numericValue || null;
  const cls = audit("cumulative-layout-shift").numericValue || null;
  const inp = audit("interaction-to-next-paint").numericValue || null;
  const fcp = audit("first-contentful-paint").numericValue || null;
  const ttfb = audit("server-response-time").numericValue || null;

  // Field data (Chrome User Experience Report) if available
  const field = raw.loadingExperience?.metrics || {};
  const fieldLcp = field.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null;
  const fieldCls = field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null;
  const fieldInp = field.INTERACTION_TO_NEXT_PAINT?.percentile || null;

  // Lighthouse category scores (0-100)
  const lighthouse = {
    performance: catScore("performance"),
    seo: catScore("seo"),
    accessibility: catScore("accessibility"),
    best_practices: catScore("best-practices"),
  };

  // Rating helpers
  const rateLcp = (ms) => ms <= 2500 ? "good" : ms <= 4000 ? "needs_improvement" : "poor";
  const rateCls = (v) => v <= 0.1 ? "good" : v <= 0.25 ? "needs_improvement" : "poor";
  const rateInp = (ms) => ms <= 200 ? "good" : ms <= 500 ? "needs_improvement" : "poor";

  return {
    core_web_vitals: {
      lcp_ms: lcp ? Math.round(lcp) : null,
      cls: cls != null ? Math.round(cls * 1000) / 1000 : null,
      inp_ms: inp ? Math.round(inp) : null,
      fcp_ms: fcp ? Math.round(fcp) : null,
      ttfb_ms: ttfb ? Math.round(ttfb) : null,
      lcp_rating: lcp ? rateLcp(lcp) : null,
      cls_rating: cls != null ? rateCls(cls) : null,
      inp_rating: inp ? rateInp(inp) : null,
      // Prefer field data when available
      field_lcp_ms: fieldLcp,
      field_cls: fieldCls,
      field_inp_ms: fieldInp,
    },
    lighthouse,
    mobile_friendly: lighthouse.seo >= 80,
    overall_experience: raw.loadingExperience?.overall_category || null,
  };
}

module.exports = { fetchPageSpeedData, normalizePageSpeedResults };
