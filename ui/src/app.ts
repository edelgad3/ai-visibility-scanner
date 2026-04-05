import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "AI Visibility Scanner", version: "1.0.0" });

// State
let currentUrl = "";
let activePriority = "p0";
let scanData: any = null;
let scanMeta: any = null;

// ── Lifecycle ──

app.ontoolinput = (input: any) => {
  const args = input?.arguments || input;
  if (args?.url) {
    currentUrl = args.url;
    const el = document.getElementById("loading-url");
    if (el) el.textContent = currentUrl;
  }
  show("loading");
  hide("dashboard");
};

app.ontoolresult = (result: any) => {
  scanData = result.structuredContent;
  scanMeta = result._meta || {};

  hide("loading");
  show("dashboard");
  render();
};

app.connect();

// ── Render ──

function render() {
  if (!scanData) return;

  const { client, scores, findings_summary, revenue_impact } = scanData;
  const { findings, pages_analyzed, checks, recommendations } = scanMeta;

  currentUrl = client?.url || currentUrl;

  // Header
  setText("client-name", client?.name || "");
  setText("scan-date", client?.audit_date || "");

  // Combined gauge
  const combined = scores?.combined?.overall || 0;
  setText("combined-score", String(Math.round(combined)));
  setText("combined-grade", scores?.combined?.grade || "--");
  setGauge("gauge-combined-fill", combined);
  colorByScore("combined-score", combined);

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
      .map(([key, val]: [string, any]) => {
        const score = val?.score ?? val ?? 0;
        return `<div class="dim"><span class="dim-label">${formatDimName(key)}</span><span class="dim-val ${scoreClass(score)}">${Math.round(score)}</span></div>`;
      })
      .join("");
  }

  // Revenue
  if (revenue_impact) {
    setText("rev-low", `$${(revenue_impact.monthly_low || 0).toLocaleString()}`);
    setText("rev-high", `$${(revenue_impact.monthly_high || 0).toLocaleString()}`);
  }

  // Findings counts
  setText("count-p0", String(findings_summary?.p0 || 0));
  setText("count-p1", String(findings_summary?.p1 || 0));
  setText("count-p2", String(findings_summary?.p2 || 0));

  renderFindings(findings);
  renderChecks(checks);
  renderPages(pages_analyzed);
  bindEvents();
}

// ── Findings ──

function renderFindings(findings: any) {
  if (!findings) return;
  const list = document.getElementById("findings-list");
  if (!list) return;

  const items = findings[activePriority] || [];
  list.innerHTML = items.length === 0
    ? `<div style="color: var(--text-muted); text-align: center; padding: 24px;">No findings at this priority level</div>`
    : items.map((f: any, i: number) => `
      <div class="finding-item" data-idx="${i}">
        <div class="finding-header">
          <div class="finding-action">${esc(f.action)}</div>
          <div class="finding-badges">
            <span class="badge badge-impact-${f.impact || 'medium'}">${f.impact || 'medium'}</span>
            <span class="badge badge-effort-${f.effort || 'medium'}">${f.effort || 'medium'} effort</span>
          </div>
        </div>
        <div class="finding-detail">
          <p>${esc(f.detail || '')}</p>
          ${f.revenue_impact?.monthly_estimate_mid ? `<div class="finding-revenue">+$${f.revenue_impact.monthly_estimate_mid.toLocaleString()}/mo potential</div>` : ''}
          ${f.source ? `<div style="margin-top:6px; font-size:11px; color:var(--text-muted)">Source: ${esc(f.source)}</div>` : ''}
        </div>
      </div>
    `).join("");

  // Expand/collapse
  list.querySelectorAll(".finding-item").forEach((el) => {
    el.addEventListener("click", () => el.classList.toggle("expanded"));
  });
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
    { name: "llms-full.txt", exists: checks.llms_full_txt?.exists, detail: "" },
    { name: "agent-card.json", exists: checks.agent_card?.exists, detail: "" },
    { name: "UCP", exists: checks.ucp?.exists, detail: "" },
  ];

  grid.innerHTML = items.map((c) => `
    <div class="check-item">
      <span class="check-icon">${c.exists ? "\u2705" : "\u274C"}</span>
      <div>
        <div class="check-name">${esc(c.name)}</div>
        ${c.detail ? `<div class="check-status">${esc(c.detail)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

// ── Pages Table ──

function renderPages(pages: any[]) {
  if (!pages || pages.length === 0) return;
  const table = document.getElementById("pages-table");
  if (!table) return;

  table.innerHTML = `
    <div class="page-row page-header">
      <div>URL</div><div>SEO</div><div>CTA</div><div>Trust</div><div>Track</div><div>Overall</div>
    </div>
    ${pages.map((p: any) => `
      <div class="page-row">
        <div class="page-url" title="${esc(p.url)}">${esc(shortenUrl(p.url))}</div>
        <div class="page-val ${scoreClass(p.scores?.seo * 10)}">${p.scores?.seo ?? '-'}</div>
        <div class="page-val ${scoreClass(p.scores?.cta * 10)}">${p.scores?.cta ?? '-'}</div>
        <div class="page-val ${scoreClass(p.scores?.trust * 10)}">${p.scores?.trust ?? '-'}</div>
        <div class="page-val ${scoreClass(p.scores?.tracking * 10)}">${p.scores?.tracking ?? '-'}</div>
        <div class="page-val ${scoreClass(p.overall * 10)}">${p.overall?.toFixed(1) ?? '-'}</div>
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

  // Re-scan button
  document.getElementById("btn-rescan")?.addEventListener("click", async () => {
    if (!currentUrl) return;
    show("loading");
    hide("dashboard");
    try {
      const result = await app.callServerTool({ name: "refresh_scan", arguments: { url: currentUrl, max_pages: 5 } });
      scanData = result.structuredContent;
      scanMeta = result._meta || {};
      hide("loading");
      show("dashboard");
      render();
    } catch (e) {
      hide("loading");
      show("dashboard");
    }
  });

  // Fix plan button — sends message to AI
  document.getElementById("btn-fix-plan")?.addEventListener("click", () => {
    const critCount = scanData?.findings_summary?.p0 || 0;
    app.sendMessage({
      role: "user",
      content: {
        type: "text",
        text: `Based on the scan of ${currentUrl}, create a detailed fix plan for the ${critCount} critical findings. Include implementation steps, estimated effort, and expected impact for each.`,
      },
    });
  });

  // Compare button — sends message to AI
  document.getElementById("btn-compare")?.addEventListener("click", () => {
    app.sendMessage({
      role: "user",
      content: {
        type: "text",
        text: `I'd like to scan a competitor website to compare against ${currentUrl}. What competitor URL should we scan?`,
      },
    });
  });
}

// ── Helpers ──

function show(id: string) { const el = document.getElementById(id); if (el) el.style.display = ""; }
function hide(id: string) { const el = document.getElementById(id); if (el) el.style.display = "none"; }
function setText(id: string, text: string) { const el = document.getElementById(id); if (el) el.textContent = text; }

function setGauge(id: string, score: number) {
  const el = document.getElementById(id) as SVGCircleElement | null;
  if (!el) return;
  const circumference = 314; // 2 * PI * 50
  const offset = circumference - (score / 100) * circumference;
  el.style.strokeDashoffset = String(offset);
  el.style.stroke = scoreColor(score);
}

function scoreColor(score: number): string {
  if (score >= 80) return "var(--success)";
  if (score >= 60) return "#84cc16";
  if (score >= 40) return "var(--warning)";
  if (score >= 20) return "#f97316";
  return "var(--danger)";
}

function scoreClass(score: number): string {
  if (score >= 80) return "score-excellent";
  if (score >= 60) return "score-good";
  if (score >= 40) return "score-fair";
  if (score >= 20) return "score-poor";
  return "score-bad";
}

function colorByScore(id: string, score: number) {
  const el = document.getElementById(id);
  if (el) el.className = (el.className.replace(/score-\w+/g, '') + ' ' + scoreClass(score)).trim();
}

function formatDimName(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

function esc(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
