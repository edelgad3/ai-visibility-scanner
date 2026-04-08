import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "AI Visibility Scanner", version: "2.0.0" });

// ── State ──
let currentUrl = "";
let activePriority = "p0";
let scanData: any = null;
let scanMeta: any = null;
let selectedTier = "forge";
let activeDrilldown = "";
let progressTimer: any = null;

// ── Lifecycle ──

app.ontoolinput = (input: any) => {
  const args = input?.arguments || input;
  if (args?.url) {
    currentUrl = args.url;
    setText("loading-url", currentUrl);
  }
  show("loading");
  hide("dashboard");
  startProgressAnimation();
};

app.ontoolresult = (result: any) => {
  stopProgressAnimation();
  scanData = result.structuredContent;
  scanMeta = result._meta || {};
  hide("loading");
  show("dashboard");
  render();
};

app.connect();

// ── Progress Animation ──

function startProgressAnimation() {
  const stages = document.querySelectorAll(".stage");
  stages.forEach((s) => s.classList.remove("active", "done"));
  let idx = 0;
  const timings = [0, 2000, 5000, 10000];
  timings.forEach((t, i) => {
    setTimeout(() => {
      if (i > 0) stages[i - 1]?.classList.replace("active", "done");
      stages[i]?.classList.add("active");
    }, t);
  });
  progressTimer = setTimeout(() => {
    stages[3]?.classList.replace("active", "done");
  }, 14000);
}

function stopProgressAnimation() {
  if (progressTimer) clearTimeout(progressTimer);
  document.querySelectorAll(".stage").forEach((s) => { s.classList.remove("active"); s.classList.add("done"); });
}

// ── Render ──

function render() {
  if (!scanData) return;
  const { client, scores, findings_summary, revenue_impact } = scanData;
  const { findings, pages_analyzed, checks } = scanMeta;
  currentUrl = client?.url || currentUrl;

  setText("client-name", client?.name || "");
  setText("scan-date", client?.audit_date || "");

  // Forge Score gauge (was "Combined")
  const forgeScore = scores?.forge_score?.overall || scores?.combined?.overall || 0;
  setText("combined-score", String(Math.round(forgeScore)));
  setText("combined-grade", scores?.forge_score?.grade || scores?.combined?.grade || "--");
  setGauge("gauge-combined-fill", forgeScore);
  colorByScore("combined-score", forgeScore);

  // AI Visibility
  const ai = scores?.ai_visibility || {};
  setText("ai-score", String(Math.round(ai.overall || 0)));
  setText("ai-grade", ai.grade || "--");
  setText("geo-score", String(ai.geo || 0));
  setText("multi-score", String(ai.multimodal || 0));
  setText("agent-score", String(ai.agent_ready || 0));
  colorByScore("ai-score", ai.overall || 0);
  colorByScore("geo-score", ai.geo || 0);
  colorByScore("multi-score", ai.multimodal || 0);
  colorByScore("agent-score", ai.agent_ready || 0);

  // Marketing Health
  const mkt = scores?.marketing_health || {};
  setText("mkt-score", String(Math.round(mkt.overall || 0)));
  setText("mkt-grade", mkt.grade || "--");
  colorByScore("mkt-score", mkt.overall || 0);
  const mktDims = document.getElementById("mkt-dims");
  if (mktDims && mkt.dimensions) {
    mktDims.innerHTML = Object.entries(mkt.dimensions)
      .map(([, val]: [string, any]) => {
        const score = val?.score ?? val ?? 0;
        const label = val?.label || "";
        return `<div class="dim"><span class="dim-label">${esc(label)}</span><span class="dim-val ${scoreClass(score)}">${Math.round(score)}</span></div>`;
      }).join("");
  }

  // SEO Health
  const seo = scores?.seo_health || {};
  setText("seo-score", String(Math.round(seo.overall || 0)));
  setText("seo-grade", seo.grade || "--");
  colorByScore("seo-score", seo.overall || 0);
  if (seo.sub_scores) {
    setText("cwv-score", String(seo.sub_scores.cwv || 0));
    setText("tech-seo-score", String(seo.sub_scores.technical || 0));
    setText("onpage-score", String(seo.sub_scores.on_page || 0));
    setText("mobile-score", String(seo.sub_scores.mobile_perf || 0));
    colorByScore("cwv-score", seo.sub_scores.cwv || 0);
    colorByScore("tech-seo-score", seo.sub_scores.technical || 0);
    colorByScore("onpage-score", seo.sub_scores.on_page || 0);
    colorByScore("mobile-score", seo.sub_scores.mobile_perf || 0);
  }

  // Revenue
  if (revenue_impact) {
    setText("rev-low", `$${(revenue_impact.monthly_low || 0).toLocaleString()}`);
    setText("rev-high", `$${(revenue_impact.monthly_high || 0).toLocaleString()}`);
  }

  // Findings
  setText("count-p0", String(findings_summary?.p0 || 0));
  setText("count-p1", String(findings_summary?.p1 || 0));
  setText("count-p2", String(findings_summary?.p2 || 0));
  renderFindings(findings);
  renderChecks(checks);
  renderPages(pages_analyzed);
  bindEvents();
}

// ── Findings with Action Cards ──

const FIX_STEPS: Record<string, string[]> = {
  "Deploy llms.txt file": ["Create a text file describing your business, services, and value proposition", "Upload to your site root at /llms.txt", "Reference it in robots.txt with: llms-txt: /llms.txt", "Test at yoursite.com/llms.txt"],
  "Add Organization schema markup": ["Create JSON-LD with @type: Organization", "Include name, url, logo, description, contactPoint", "Add to <head> of every page", "Test with Google Rich Results Test"],
  "Create and submit XML sitemap": ["Generate sitemap.xml with all public URLs", "Upload to site root", "Add to robots.txt: Sitemap: /sitemap.xml", "Submit to Google Search Console"],
  "Configure robots.txt with AI crawler policies": ["Add rules for GPTBot, ClaudeBot, PerplexityBot", "Set crawl-delay if needed", "Reference sitemap and llms.txt"],
  "Add FAQ section with FAQPage schema": ["Write 5-10 common questions and answers", "Add FAQPage JSON-LD schema", "Place FAQ section on relevant service pages"],
  "Deploy .well-known/agent-card.json for A2A agent discovery": ["Create agent-card.json with capabilities, endpoints, authentication", "Upload to /.well-known/agent-card.json", "Include service descriptions and supported protocols"],
  "Add OG image meta tags for social/AI sharing": ["Create a 1200x630px branded image", "Add og:image, og:title, og:description meta tags", "Test with social media debuggers"],
  "Add video content (explainer/demo)": ["Record a 60-90 second explainer video", "Host on YouTube or self-host with VideoObject schema", "Embed on homepage and key service pages"],
  "Add WebMCP Declarative attributes (toolname, tooldescription) to all forms": ["Add toolname attribute to each form element", "Add tooldescription explaining what the form does", "Add toolparam on each input describing its purpose"],
};

function getFixSteps(action: string): string[] {
  return FIX_STEPS[action] || ["Contact us for a custom implementation plan"];
}

function effortToTime(effort: string): string {
  return { low: "1-2 hours", medium: "4-8 hours", high: "2-5 days" }[effort] || "Varies";
}

function effortToCost(effort: string): string {
  return { low: "$99", medium: "$199", high: "$499+" }[effort] || "Custom";
}

function renderFindings(findings: any) {
  if (!findings) return;
  const list = document.getElementById("findings-list");
  if (!list) return;

  const items = findings[activePriority] || [];
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state">No findings at this priority level</div>`;
    return;
  }

  list.innerHTML = items.map((f: any, i: number) => `
    <div class="finding-item" data-idx="${i}">
      <div class="finding-header">
        <div class="finding-action">${esc(f.action)}</div>
        <div class="finding-badges">
          <span class="badge badge-impact-${f.impact || 'medium'}">${f.impact || 'medium'}</span>
          <span class="badge badge-effort-${f.effort || 'medium'}">${f.effort || 'medium'}</span>
        </div>
      </div>
      <div class="finding-detail">
        <p>${esc(f.detail || "")}</p>
        <div class="fix-steps">
          <strong>How to fix:</strong>
          <ol>${getFixSteps(f.action).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        </div>
        <div class="finding-meta-row">
          <span class="estimate">${effortToTime(f.effort)} &middot; ${effortToCost(f.effort)}</span>
          ${f.revenue_impact?.monthly_estimate_mid ? `<span class="finding-revenue">+$${f.revenue_impact.monthly_estimate_mid.toLocaleString()}/mo</span>` : ""}
        </div>
        <button class="btn btn-primary btn-sm btn-fix" data-action="${esc(f.action)}">Fix It</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".finding-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".btn-fix")) return;
      el.classList.toggle("expanded");
    });
  });

  list.querySelectorAll(".btn-fix").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action || "";
      openCommerceModal(action);
    });
  });
}

// ── Commerce Modal ──

function openCommerceModal(findingAction: string) {
  setText("modal-finding", findingAction);
  const form = document.getElementById("lead-form") as HTMLFormElement;
  if (form) form.reset();
  hide("lead-success");
  show("lead-form");
  show("commerce-modal");

  // Pre-select tier from URL param (?tier=forge or ?tier=diagnostic), default to forge
  const urlTier = new URLSearchParams(window.location.search).get("tier");
  const validTiers = ["visibility", "forge", "diagnostic"];
  selectedTier = validTiers.includes(urlTier || "") ? urlTier! : "forge";
  document.querySelectorAll(".tier-card").forEach((c) => c.classList.remove("selected"));
  document.querySelector(`.tier-card[data-tier="${selectedTier}"]`)?.classList.add("selected");
}

function closeCommerceModal() {
  hide("commerce-modal");
}

// ── Competitor Comparison ──

async function runComparison() {
  const input = document.getElementById("competitor-url") as HTMLInputElement;
  const competitorUrl = input?.value?.trim();
  if (!competitorUrl || !currentUrl) return;

  show("compare-loading");
  hide("compare-results");

  try {
    const result = await app.callServerTool({ name: "compare_scan", arguments: { url: currentUrl, competitor_url: competitorUrl, max_pages: 3 } });
    hide("compare-loading");
    show("compare-results");
    renderComparison(result.structuredContent);
  } catch (e) {
    hide("compare-loading");
    const el = document.getElementById("compare-results");
    if (el) { el.style.display = "block"; el.innerHTML = `<div class="empty-state">Comparison failed. Check the URL and try again.</div>`; }
  }
}

function renderComparison(data: any) {
  const el = document.getElementById("compare-results");
  if (!el || !data) return;

  const { primary, competitor, delta, primary_url, competitor_url } = data;
  const arrow = (d: number) => d > 0 ? `<span class="delta-up">+${d}</span>` : d < 0 ? `<span class="delta-down">${d}</span>` : `<span class="delta-even">0</span>`;

  el.innerHTML = `
    <div class="compare-grid">
      <div class="compare-col compare-header-row">
        <div class="compare-label"></div>
        <div class="compare-you">You</div>
        <div class="compare-them">Competitor</div>
        <div class="compare-delta">Delta</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">AI Visibility</div>
        <div class="compare-you ${scoreClass(primary?.ai_visibility?.overall || 0)}">${Math.round(primary?.ai_visibility?.overall || 0)}</div>
        <div class="compare-them ${scoreClass(competitor?.ai_visibility?.overall || 0)}">${Math.round(competitor?.ai_visibility?.overall || 0)}</div>
        <div class="compare-delta">${arrow(delta?.ai_visibility || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">GEO</div>
        <div class="compare-you">${primary?.ai_visibility?.geo || 0}</div>
        <div class="compare-them">${competitor?.ai_visibility?.geo || 0}</div>
        <div class="compare-delta">${arrow(delta?.geo || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">Multimodal</div>
        <div class="compare-you">${primary?.ai_visibility?.multimodal || 0}</div>
        <div class="compare-them">${competitor?.ai_visibility?.multimodal || 0}</div>
        <div class="compare-delta">${arrow(delta?.multimodal || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">Agent-Ready</div>
        <div class="compare-you">${primary?.ai_visibility?.agent_ready || 0}</div>
        <div class="compare-them">${competitor?.ai_visibility?.agent_ready || 0}</div>
        <div class="compare-delta">${arrow(delta?.agent_ready || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">Marketing</div>
        <div class="compare-you ${scoreClass(primary?.marketing_health?.overall || 0)}">${Math.round(primary?.marketing_health?.overall || 0)}</div>
        <div class="compare-them ${scoreClass(competitor?.marketing_health?.overall || 0)}">${Math.round(competitor?.marketing_health?.overall || 0)}</div>
        <div class="compare-delta">${arrow(delta?.marketing_health || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">SEO Health</div>
        <div class="compare-you ${scoreClass(primary?.seo_health?.overall || 0)}">${Math.round(primary?.seo_health?.overall || 0)}</div>
        <div class="compare-them ${scoreClass(competitor?.seo_health?.overall || 0)}">${Math.round(competitor?.seo_health?.overall || 0)}</div>
        <div class="compare-delta">${arrow(delta?.seo_health || 0)}</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">Forge Score</div>
        <div class="compare-you ${scoreClass(primary?.forge_score?.overall || primary?.combined?.overall || 0)}"><strong>${Math.round(primary?.forge_score?.overall || primary?.combined?.overall || 0)}</strong></div>
        <div class="compare-them ${scoreClass(competitor?.forge_score?.overall || competitor?.combined?.overall || 0)}"><strong>${Math.round(competitor?.forge_score?.overall || competitor?.combined?.overall || 0)}</strong></div>
        <div class="compare-delta"><strong>${arrow(delta?.forge_score || delta?.combined || 0)}</strong></div>
      </div>
    </div>
  `;
}

// ── Score Drill-Down ──

async function showDrillDown(dimension: string) {
  if (!scanMeta?.checks) return;
  activeDrilldown = dimension;

  try {
    const result = await app.callServerTool({ name: "get_score_breakdown", arguments: { dimension, checks: scanMeta.checks } });
    const bd = result.structuredContent;
    if (!bd) return;

    setText("drilldown-title", { geo: "GEO Score Breakdown", multimodal: "Multimodal Score Breakdown", agent_ready: "Agent-Ready Score Breakdown", cwv: "Core Web Vitals Breakdown", technical_seo: "Technical SEO Breakdown", on_page_seo: "On-Page SEO Breakdown", mobile_perf: "Mobile & Performance Breakdown" }[dimension] || "Breakdown");
    setText("drilldown-passed", String(bd.passed));
    setText("drilldown-failed", String(bd.failed));
    setText("drilldown-total", String(bd.total));
    setText("drilldown-max", String(bd.max));

    const list = document.getElementById("drilldown-list");
    if (list) {
      list.innerHTML = (bd.breakdown || []).map((r: any) => `
        <div class="breakdown-item ${r.passed ? "pass" : "fail"}">
          <span class="breakdown-icon">${r.passed ? "\u2705" : "\u274C"}</span>
          <div class="breakdown-info">
            <div class="breakdown-name">${esc(r.name)}</div>
            <div class="breakdown-desc">${esc(r.description)}</div>
          </div>
          <span class="breakdown-points">${r.points}/${r.maxPoints}</span>
        </div>
      `).join("");
    }
    show("drilldown-panel");
  } catch { /* drill-down failed silently */ }
}

// ── Infrastructure Checks ──

function renderChecks(checks: any) {
  if (!checks) return;
  const grid = document.getElementById("checks-grid");
  if (!grid) return;

  const items = [
    { name: "robots.txt", exists: checks.robots?.exists, detail: checks.robots?.ai_crawlers_mentioned ? "AI crawlers configured" : "" },
    { name: "sitemap.xml", exists: checks.sitemap?.exists, detail: checks.sitemap?.url_count ? `${checks.sitemap.url_count} URLs` : "" },
    { name: "llms.txt", exists: checks.llms_txt?.exists, detail: checks.llms_txt?.length ? `${checks.llms_txt.length} chars` : "" },
    { name: "llms-full.txt", exists: checks.llms_full_txt?.exists },
    { name: "agent-card.json", exists: checks.agent_card?.exists },
    { name: "UCP", exists: checks.ucp?.exists },
  ];

  grid.innerHTML = items.map((c) => `
    <div class="check-item">
      <span class="check-icon">${c.exists ? "\u2705" : "\u274C"}</span>
      <div><div class="check-name">${esc(c.name)}</div>${c.detail ? `<div class="check-status">${esc(c.detail)}</div>` : ""}</div>
    </div>
  `).join("");
}

// ── Pages Table ──

function renderPages(pages: any[]) {
  if (!pages || pages.length === 0) return;
  const table = document.getElementById("pages-table");
  if (!table) return;

  table.innerHTML = `
    <div class="page-row page-header"><div>URL</div><div>SEO</div><div>CTA</div><div>Trust</div><div>Track</div><div>Overall</div></div>
    ${pages.map((p: any) => `
      <div class="page-row">
        <div class="page-url" title="${esc(p.url)}">${esc(shortenUrl(p.url))}</div>
        <div class="page-val ${scoreClass((p.scores?.seo || 0) * 10)}">${p.scores?.seo ?? "-"}</div>
        <div class="page-val ${scoreClass((p.scores?.cta || 0) * 10)}">${p.scores?.cta ?? "-"}</div>
        <div class="page-val ${scoreClass((p.scores?.trust || 0) * 10)}">${p.scores?.trust ?? "-"}</div>
        <div class="page-val ${scoreClass((p.scores?.tracking || 0) * 10)}">${p.scores?.tracking ?? "-"}</div>
        <div class="page-val ${scoreClass((p.overall || 0) * 10)}">${p.overall?.toFixed(1) ?? "-"}</div>
      </div>
    `).join("")}
  `;
}

// ── Events ──

function bindEvents() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activePriority = (tab as HTMLElement).dataset.priority || "p0";
      renderFindings(scanMeta?.findings);
    });
  });

  // Re-scan
  document.getElementById("btn-rescan")?.addEventListener("click", async () => {
    if (!currentUrl) return;
    show("loading");
    hide("dashboard");
    startProgressAnimation();
    try {
      const result = await app.callServerTool({ name: "refresh_scan", arguments: { url: currentUrl, max_pages: 5 } });
      stopProgressAnimation();
      scanData = result.structuredContent;
      scanMeta = result._meta || {};
      hide("loading");
      show("dashboard");
      render();
    } catch { stopProgressAnimation(); hide("loading"); show("dashboard"); }
  });

  // Competitor comparison
  document.getElementById("btn-compare-run")?.addEventListener("click", runComparison);
  document.getElementById("competitor-url")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") runComparison(); });

  // Score drill-down
  document.querySelectorAll(".dim-clickable").forEach((el) => {
    el.addEventListener("click", () => showDrillDown((el as HTMLElement).dataset.dim || ""));
  });
  document.getElementById("drilldown-close")?.addEventListener("click", () => hide("drilldown-panel"));
  document.getElementById("drilldown-learn")?.addEventListener("click", () => {
    const labels: Record<string, string> = { geo: "GEO (Generative Engine Optimization)", multimodal: "Multimodal readiness", agent_ready: "Agent-Ready infrastructure", cwv: "Core Web Vitals", technical_seo: "Technical SEO", on_page_seo: "On-Page SEO", mobile_perf: "Mobile & Performance" };
    app.sendMessage({ role: "user", content: [{ type: "text", text: `Explain the ${labels[activeDrilldown] || activeDrilldown} score breakdown for ${currentUrl} and what I should prioritize fixing first.` }] });
  });

  // Fix plan
  document.getElementById("btn-fix-plan")?.addEventListener("click", () => {
    const critCount = scanData?.findings_summary?.p0 || 0;
    const impCount = scanData?.findings_summary?.p1 || 0;
    app.sendMessage({ role: "user", content: [{ type: "text", text: `Create a detailed fix plan for the ${critCount} critical and ${impCount} important findings on ${currentUrl}. Include implementation steps, estimated effort, and expected revenue impact for each.` }] });
  });

  // Download report
  document.getElementById("btn-download")?.addEventListener("click", () => {
    const report = buildReport();
    app.sendMessage({ role: "user", content: [{ type: "text", text: `Here are the full scan results for ${currentUrl}. Please format this as a professional report:\n\n${report}` }] });
  });

  // Share results
  document.getElementById("btn-share")?.addEventListener("click", () => {
    const sc = scanData?.scores;
    app.sendMessage({ role: "user", content: [{ type: "text", text: `Share a summary of the AI Visibility scan for ${currentUrl}: Forge Score ${sc?.forge_score?.overall || sc?.combined?.overall}/100 (${sc?.forge_score?.grade || sc?.combined?.grade}), AI Visibility ${sc?.ai_visibility?.overall}/100, SEO Health ${sc?.seo_health?.overall || '--'}/100, Marketing Health ${sc?.marketing_health?.overall}/100. ${scanData?.findings_summary?.p0 || 0} critical findings.` }] });
  });

  // Commerce modal
  document.getElementById("modal-close")?.addEventListener("click", closeCommerceModal);
  document.getElementById("modal-backdrop")?.addEventListener("click", closeCommerceModal);

  document.querySelectorAll(".tier-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".tier-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedTier = (card as HTMLElement).dataset.tier || "full_audit";
    });
  });

  document.getElementById("lead-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const email = data.get("email") as string;
    const name = data.get("name") as string;
    const company = (data.get("company") as string) || "";

    // Submit lead to backend
    try {
      await app.callServerTool({
        name: "submit_lead",
        arguments: {
          name,
          email,
          company,
          tier: selectedTier,
          scan_url: currentUrl,
          findings_count: (scanData?.findings_summary?.p0 || 0) + (scanData?.findings_summary?.p1 || 0),
        },
      });
    } catch { /* submission failed but show success anyway for UX */ }

    // For paid tiers, redirect to Stripe checkout
    if (selectedTier === "forge" || selectedTier === "diagnostic") {
      try {
        const resp = await fetch("/api/v1/scan/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: selectedTier, email }),
        });
        const result = await resp.json();
        if (result.checkout_url) {
          window.location.href = result.checkout_url;
          return;
        }
      } catch { /* checkout failed — fall through to success message */ }
    }

    hide("lead-form");
    show("lead-success");

    // Notify the AI
    const tierLabels: Record<string, string> = { visibility: "Visibility Scan (Free)", forge: "Forge Scan ($299)", diagnostic: "Full Diagnostic ($499)" };
    app.updateModelContext({ content: [{ type: "text", text: `User submitted a lead for ${currentUrl}. Tier: ${tierLabels[selectedTier]}. Name: ${data.get("name")}. Email: ${data.get("email")}.` }] });
  });
}

// ── Report Builder ──

function buildReport(): string {
  if (!scanData) return "No scan data available.";
  const s = scanData.scores;
  const f = scanData.findings_summary;
  let report = `# AI Visibility Scan Report: ${scanData.client?.name}\n`;
  report += `URL: ${scanData.client?.url}\nDate: ${scanData.client?.audit_date}\n\n`;
  report += `## Scores\n`;
  report += `- Forge Score: ${s?.forge_score?.overall || s?.combined?.overall}/100 (${s?.forge_score?.grade || s?.combined?.grade})\n`;
  report += `- AI Visibility: ${s?.ai_visibility?.overall}/100 (${s?.ai_visibility?.grade})\n`;
  report += `  - GEO: ${s?.ai_visibility?.geo}\n  - Multimodal: ${s?.ai_visibility?.multimodal}\n  - Agent-Ready: ${s?.ai_visibility?.agent_ready}\n`;
  report += `- SEO Health: ${s?.seo_health?.overall || '--'}/100 (${s?.seo_health?.grade || '--'})\n`;
  report += `  - Core Web Vitals: ${s?.seo_health?.sub_scores?.cwv || '--'}\n  - Technical SEO: ${s?.seo_health?.sub_scores?.technical || '--'}\n  - On-Page SEO: ${s?.seo_health?.sub_scores?.on_page || '--'}\n  - Mobile & Perf: ${s?.seo_health?.sub_scores?.mobile_perf || '--'}\n`;
  report += `- Marketing Health: ${s?.marketing_health?.overall}/100 (${s?.marketing_health?.grade})\n\n`;
  report += `## Findings\n- Critical: ${f?.p0}\n- Important: ${f?.p1}\n- Nice-to-have: ${f?.p2}\n\n`;
  report += `## Revenue Impact\n$${scanData.revenue_impact?.monthly_low?.toLocaleString()}-$${scanData.revenue_impact?.monthly_high?.toLocaleString()}/mo\n`;
  return report;
}

// ── Helpers ──

function show(id: string) { const el = document.getElementById(id); if (el) el.style.display = ""; }
function hide(id: string) { const el = document.getElementById(id); if (el) el.style.display = "none"; }
function setText(id: string, text: string) { const el = document.getElementById(id); if (el) el.textContent = text; }

function setGauge(id: string, score: number) {
  const el = document.getElementById(id) as SVGCircleElement | null;
  if (!el) return;
  const offset = 314 - (score / 100) * 314;
  el.style.strokeDashoffset = String(offset);
  el.style.stroke = scoreColor(score);
}

function scoreColor(s: number): string {
  if (s >= 80) return "var(--success)";
  if (s >= 60) return "#84cc16";
  if (s >= 40) return "var(--warning)";
  if (s >= 20) return "#f97316";
  return "var(--danger)";
}

function scoreClass(s: number): string {
  if (s >= 80) return "score-excellent";
  if (s >= 60) return "score-good";
  if (s >= 40) return "score-fair";
  if (s >= 20) return "score-poor";
  return "score-bad";
}

function colorByScore(id: string, score: number) {
  const el = document.getElementById(id);
  if (el) el.className = (el.className.replace(/score-\w+/g, "") + " " + scoreClass(score)).trim();
}

function shortenUrl(url: string): string {
  try { const u = new URL(url); return u.pathname === "/" ? u.hostname : u.pathname; } catch { return url; }
}

function esc(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
