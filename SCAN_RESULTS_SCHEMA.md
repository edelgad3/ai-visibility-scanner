# Scan Results JSON Schema

> This is the exact JSON structure that `unified_audit_pipeline.py` and `generate_client_reports.py` expect.
> Your Puppeteer scanner should output this structure to `clients/{slug}/audit/unified-audit-data.json`.

## Architecture

```
puppeteer-scanner CLI
  → fetches each page twice (JS disabled + JS enabled)
  → extracts all signals
  → outputs: clients/{slug}/audit/unified-audit-data.json

generate_client_reports.py --slug {slug}
  → reads unified-audit-data.json
  → outputs: clients/{slug}/deliverables/audit-report.html
```

The scanner replaces BOTH `unified_audit_pipeline.py` Phase 2 AND `page_analyzer.py`. It should output the **final** `unified-audit-data.json` directly — no intermediate processing needed.

---

## Complete Schema

```jsonc
{
  // ═══════════════════════════════════════════════════════════
  // CLIENT METADATA
  // ═══════════════════════════════════════════════════════════
  "client": {
    "name": "Ethereal Media",                    // Business name (extracted from site)
    "url": "https://etherealmedia.ai",           // Target URL
    "slug": "etherealmedia-ai",                  // Directory slug
    "industry": "ai-agency",                     // Industry vertical (passed via CLI flag)
    "audit_date": "2026-04-04",                  // ISO date string
    "business_type": {
      "type": "agency",                          // Detected: "agency", "saas", "ecommerce", "local", "unknown"
      "confidence": 85,                          // 0-100
      "focus": "AI Marketing & Automation"       // One-line description
    }
  },

  // ═══════════════════════════════════════════════════════════
  // SCORES (all 0-100 unless noted)
  // ═══════════════════════════════════════════════════════════
  "scores": {

    // ── AI Visibility ──────────────────────────────────────
    "ai_visibility": {
      "overall": 70.0,                           // Average of geo + multimodal + agent_ready
      "geo": 90,                                 // Generative Engine Optimization score
      "multimodal": 45,                          // Visual + structured content score
      "agent_ready": 75,                         // Machine-actionable readiness score
      "grade": "B",                              // Letter grade from overall

      // Raw check data — this is what the report renders directly
      "checks": {

        "robots": {
          "exists": true,                        // GET /robots.txt returns 200
          "has_sitemap_reference": true,          // Contains "Sitemap:" directive
          "ai_crawler_rules": [                  // Lines mentioning AI crawlers
            "user-agent: gptbot",
            "user-agent: chatgpt-user",
            "user-agent: claudebot",
            "user-agent: perplexitybot"
          ],
          "ai_crawlers_mentioned": true,          // Any AI crawler rules found
          "content_preview": "..."               // First 500 chars of robots.txt
        },

        "sitemap": {
          "exists": true,                        // GET /sitemap.xml returns 200
          "url_count": 15                        // Number of <url> or <loc> entries
        },

        "llms_txt": {
          "exists": true,                        // GET /llms.txt returns 200
          "length": 3999,                        // Character count
          "preview": "# Ethereal Media\n\n> ..."  // First 300 chars
        },

        "llms_full_txt": {
          "exists": true,                        // GET /llms-full.txt returns 200
          "length": 13665,
          "preview": "# Ethereal Media — Full..." // First 300 chars
        },

        "agent_card": {
          "exists": true                         // GET /.well-known/agent-card.json returns 200
        },

        "ucp": {
          "exists": false                        // GET /.well-known/ucp returns 200
        },

        "schema": {
          "has_organization": true,              // JSON-LD contains "Organization" @type
          "has_service": true,                   // JSON-LD contains "Service" @type
          "has_product": false,                  // JSON-LD contains "Product" @type
          "has_faq": true,                       // JSON-LD contains "FAQPage" @type
          "has_person": true,                    // JSON-LD contains "Person" @type
          "has_breadcrumb": true,                // JSON-LD contains "BreadcrumbList" @type
          "has_howto": false,                    // JSON-LD contains "HowTo" @type
          "has_speakable": false,                // JSON-LD contains "speakable" property
          "has_image_object": false,             // JSON-LD contains "ImageObject" @type
          "has_video_object": false,             // JSON-LD contains "VideoObject" @type
          "has_machine_catalog": false,           // Reserved for future use
          "schema_count": 7,                     // Total <script type="application/ld+json"> blocks
          "has_software_app": false,             // JSON-LD contains "SoftwareApplication"
          "has_data_download": false,            // JSON-LD contains "DataDownload"
          "has_digital_document": false,          // JSON-LD contains "DigitalDocument"
          "has_media_object": false,             // JSON-LD contains "MediaObject"
          "has_creative_work": false             // JSON-LD contains "CreativeWork"
        },

        "meta": {
          "has_canonical": true,                 // <link rel="canonical"> present
          "has_structured_contact": true         // mailto: or tel: links present
        },

        "media": {
          "has_og_image": true,                  // <meta property="og:image"> present
          "has_twitter_card": true,              // <meta name="twitter:card"> present
          "images_total": 2,                     // Total <img> tags
          "images_with_alt": 2,                  // <img> tags with non-empty alt text
          "images_with_alt_pct": 100.0,          // Percentage
          "has_video": false,                    // <video> or youtube/vimeo embed found
          "has_webp_avif": false,                // .webp or .avif references in src/srcset
          "has_srcset": false,                   // srcset= attribute found on any img
          "has_infographic": false,              // Heuristic — large images with data/chart keywords
          "is_spa": false                        // SPA-only detection (id="root" + few <a> tags)
        },

        "aeo": {
          "has_declarative_webmcp": true,         // Any form has toolname + tooldescription attrs
          "declarative_forms": [                 // Array of WebMCP-enabled forms
            {
              "toolname": "request_ai_visibility_report",
              "tooldescription": "Request a free AI Visibility Report...",
              "autosubmit": false,               // data-autosubmit attribute
              "action": ""                       // Form action URL
            }
          ],
          "declarative_form_count": 1,           // Count of WebMCP-enabled forms
          "forms_without_webmcp": 0,             // Forms missing WebMCP attrs
          "form_count": 1,                       // Total <form> elements

          // Semantic HTML
          "semantic_tags": {
            "main": 1,                           // Count of <main> tags
            "article": 0,                        // Count of <article> tags
            "section": 8,                        // Count of <section> tags
            "nav": 1,                            // Count of <nav> tags
            "aside": 0,                          // Count of <aside> tags
            "footer": 1,                         // Count of <footer> tags
            "header": 0                          // Count of <header> tags
          },
          "has_main": true,                      // <main> tag exists
          "has_article": false,
          "has_section": true,
          "has_nav": true,
          "has_footer": true,
          "has_header": false,
          "semantic_score": 4,                   // Count of unique semantic tag types used (0-7)

          // ARIA / Accessibility
          "aria_count": 15,                      // Total aria-* attributes found
          "interactive_without_aria": 1,         // Buttons/inputs/links without aria-label
          "has_aria_labels": true                 // Any aria-label found
        },

        "digital_assets": {
          "download_link_count": 0,              // Links to downloadable files (.pdf, .zip, etc.)
          "download_attr_count": 0,              // <a download> attributes
          "has_digital_assets": false,            // Either count > 0
          "has_transcripts": true,               // "transcript", "caption", ".srt", ".vtt" in HTML
          "has_digital_asset_schema": false       // SoftwareApp/DataDownload/DigitalDocument schema found
        }
      }
    },

    // ── Marketing Health ───────────────────────────────────
    "marketing_health": {
      "overall": 80.5,                           // Weighted average of dimensions
      "seo": 9.0,                                // Average SEO score across pages (0-10)
      "cta_conversion": 6.5,                     // Average CTA score across pages (0-10)
      "trust_signals": 7.5,                      // Average trust score across pages (0-10)
      "analytics_tracking": 1.0,                 // Average tracking score across pages (0-10)
      "competitor_position": 50,                 // Competitive position (0-100)
      "cro": 80,                                 // Conversion rate optimization (0-100)
      "grade": "B",

      // 6-dimension scoring with weights
      "dimensions": {
        "content_messaging": {
          "score": 100,                          // 0-100
          "weight": 0.25,                        // Weight in overall calculation
          "label": "Content & Messaging"         // Display label for report
        },
        "conversion_cro": {
          "score": 80,
          "weight": 0.20,
          "label": "Conversion/CRO"
        },
        "seo_discoverability": {
          "score": 90,
          "weight": 0.20,
          "label": "SEO & Discoverability"
        },
        "competitive_position": {
          "score": 50,
          "weight": 0.15,
          "label": "Competitive Position"
        },
        "brand_trust": {
          "score": 80,
          "weight": 0.10,
          "label": "Brand & Trust"
        },
        "growth_signals": {
          "score": 60,
          "weight": 0.10,
          "label": "Growth Signals"
        }
      }
    },

    // ── Combined ──────────────────────────────────────────
    "combined": {
      "overall": 75.2,                           // (ai_visibility * 0.5) + (marketing_health * 0.5)
      "grade": "B+"
    }
  },

  // ═══════════════════════════════════════════════════════════
  // FINDINGS (grouped by priority)
  // ═══════════════════════════════════════════════════════════
  "findings": {
    "p0": [                                      // Critical — fix immediately
      {
        "action": "Add WebMCP Declarative attributes to all forms",
        "detail": "Forms exist but lack toolname/tooldescription attributes",  // Optional
        "impact": "high",                        // "high", "medium", "low"
        "source": "aeo",                         // Source category (see list below)
        "category": "Agent Readiness",           // Optional display category
        "effort": "low",                         // "low", "medium", "high" — used by effort/impact matrix
        "revenue_impact": {                      // Optional — for marketing findings
          "monthly_estimate_low": 500,
          "monthly_estimate_mid": 1500,
          "monthly_estimate_high": 3000
        }
      }
    ],
    "p1": [                                      // Important — fix within 30 days
      // Same structure as p0 entries
    ],
    "p2": [                                      // Nice-to-have — within 90 days
      // Same structure as p0 entries
    ]
  },

  // Source values used in findings:
  //   "ai_visibility"       — GEO/multimodal checks
  //   "ai_visibility_llm"   — LLM-detected content issues (JS rendering, etc.)
  //   "aeo"                 — WebMCP, A2A, agent readiness
  //   "geo"                 — GEO-specific (llms.txt, etc.)
  //   "marketing_health"    — Marketing dimension findings
  //   "semantic_html"       — Semantic tag issues
  //   "accessibility"       — ARIA/a11y issues
  //   "digital_assets"      — Downloadable file schema issues

  // ═══════════════════════════════════════════════════════════
  // PAGE-BY-PAGE ANALYSIS
  // ═══════════════════════════════════════════════════════════
  "pages_analyzed": [
    {
      "url": "https://etherealmedia.ai",
      "type": "homepage",                        // "homepage" or "subpage"
      "status_code": 200,                        // HTTP status (from Puppeteer response)
      "response_time_ms": 201,                   // Time to first byte or DOMContentLoaded
      "scores": {
        "seo": 9,                                // 0-10: meta tags, headings, canonical, structured data
        "cta": 6,                                // 0-10: CTA presence, placement, clarity, quantity
        "trust": 8,                              // 0-10: SSL, contact info, testimonials, social proof
        "tracking": 1                            // 0-10: analytics tools, event tracking, conversion pixels
      },
      "overall": 6.0                             // Average of the 4 scores

      // ═══ NEW: Puppeteer-exclusive fields (optional but powerful) ═══
      // These don't exist in the current Python scanner.
      // If present, generate_client_reports.py will use them for
      // enhanced "Proof of Scrape" evidence.

      // "js_diff": {                            // What changed between no-JS and JS-rendered DOM
      //   "elements_added": 42,                 // DOM nodes added by JS
      //   "text_content_changed": [             // Content that only appears after JS runs
      //     {
      //       "selector": ".counter-stat",
      //       "no_js_text": "0%",
      //       "js_text": "98%",
      //       "description": "Animated counter"
      //     }
      //   ],
      //   "schemas_injected_by_js": 3,          // JSON-LD blocks added by React/Next hydration
      //   "forms_added_by_js": 0                // Forms that only appear after JS
      // },
      // "screenshot_path": "clients/{slug}/scan/screenshots/homepage.png"
    },
    {
      "url": "https://etherealmedia.ai/about",
      "type": "subpage",
      "status_code": 200,
      "response_time_ms": 149,
      "scores": { "seo": 9, "cta": 6, "trust": 8, "tracking": 1 },
      "overall": 6.0
    }
    // ... more pages
  ],

  // ═══════════════════════════════════════════════════════════
  // COMPETITORS (optional — pass competitor URLs via CLI)
  // ═══════════════════════════════════════════════════════════
  "competitors": [
    // If competitor URLs are provided, scan them and populate:
    {
      "name": "Rival Agency",                    // Extracted from their site
      "url": "https://rival-agency.com",
      "geo_score": 55,                           // Their GEO score (run same checks)
      "multimodal_score": 40,
      "agent_ready_score": 30,
      "ai_visibility_score": 42,                 // Average of their 3 scores
      "marketing_score": 72                      // Their marketing health score
    }
    // The report's competitive benchmarking page uses this data.
    // If empty, falls back to industry benchmarks.
  ],

  // ═══════════════════════════════════════════════════════════
  // UNIFIED RECOMMENDATIONS (auto-generated from findings)
  // ═══════════════════════════════════════════════════════════
  "recommendations": [
    {
      "priority": "P0",                          // "P0", "P1", or "P2"
      "action": "Add WebMCP Declarative attributes to all forms",
      "detail": "Forms exist but agents can't determine what they do",
      "category": "aeo",
      "effort": "low",                           // Used by the effort/impact matrix
      "impact": "high",
      "source": "aeo",
      "revenue_impact": {
        "monthly_estimate_low": 500,
        "monthly_estimate_mid": 1500,
        "monthly_estimate_high": 3000
      }
    }
    // ... sorted P0 first, then P1, then P2
  ],

  // ═══════════════════════════════════════════════════════════
  // REVENUE IMPACT (aggregate)
  // ═══════════════════════════════════════════════════════════
  "revenue_impact": {
    "monthly_low": 900,                          // Sum of all recommendation lows
    "monthly_mid": 3450,                         // Sum of all recommendation mids
    "monthly_high": 6000                         // Sum of all recommendation highs
  },

  // ═══════════════════════════════════════════════════════════
  // BRAND DATA (from Phase 1 scan — optional, enriches report)
  // ═══════════════════════════════════════════════════════════
  "brand": {
    "colors": {                                  // Extracted brand colors
      "primary": "#2494A3",
      "secondary": "#D4B57A",
      "accent": "#30C5D2",
      "all_colors": ["#2494A3", "#D4B57A", "#30C5D2", "#212934"]
    },
    "typography": {
      "heading_font": "Plus Jakarta Sans",
      "body_font": "DM Sans"
    },
    "content_inventory": {
      "services": ["AI Automation", "Content Creation", "Internet Marketing"],
      "testimonials": [],
      "team": [],
      "contact": { "email": "info@etherealmedia.ai" }
    },
    "profile": {
      "vibe": "Premium tech-forward",
      "tagline": "Make Your Business Callable by AI",
      "value_proposition": "AI visibility optimization",
      "theme_direction": "dark + teal accents"
    }
  },

  // ═══════════════════════════════════════════════════════════
  // METADATA
  // ═══════════════════════════════════════════════════════════
  "metadata": {
    "pipeline_version": "2.0.0",                 // Bump when schema changes
    "scanner": "puppeteer-forge-scanner",         // Identifies which tool produced this
    "scan_duration_ms": 12500,                   // Total scan time
    "pages_scanned": 6,
    "js_rendering_enabled": true,                // Whether Puppeteer was used
    "generated_at": "2026-04-04T19:32:57Z"       // ISO timestamp
  }
}
```

## Scoring Formulas

The scanner should compute these scores. Here's how the current Python pipeline calculates them:

### GEO Score (0-100)
| Check | Points |
|-------|--------|
| Organization schema | +15 |
| Service/Product schema | +10 |
| FAQ schema | +10 |
| Person schema | +5 |
| Breadcrumb schema | +5 |
| HowTo schema | +5 |
| robots.txt exists | +5 |
| AI crawlers configured in robots.txt | +10 |
| sitemap.xml exists | +10 |
| llms.txt exists | +15 |
| Canonical tags | +5 |
| Speakable schema | +5 |

### Multimodal Score (0-100)
| Check | Points |
|-------|--------|
| OG image meta tag | +15 |
| Twitter card meta tag | +10 |
| Alt text >= 80% of images | +15 (50-79% = +8) |
| Video content detected | +15 |
| ImageObject schema | +10 |
| VideoObject schema | +10 |
| WebP/AVIF images | +10 |
| srcset responsive images | +10 |
| Infographic detected | +5 |

### Agent-Ready Score (0-100)
| Check | Points |
|-------|--------|
| llms.txt exists | +10 |
| llms-full.txt exists | +5 |
| .well-known/mcp endpoint | +10 |
| .well-known/ai-plugin.json | +5 |
| .well-known/agent-card.json (A2A) | +10 |
| .well-known/ucp manifest | +5 |
| WebMCP declarative forms | +15 |
| Semantic score >= 5 | +10 (3-4 = +5) |
| ARIA count >= 5 | +5 |
| sitemap.xml exists | +5 |
| Not SPA-only | +10 |
| Schema count >= 3 | +5 |
| Structured contact (mailto/tel) | +5 |
| **Max** | **100** |

### Marketing Page Scores (0-10 each)
| Dimension | What to check |
|-----------|--------------|
| **SEO** | meta title, meta description, h1, canonical, OG tags, structured data, mobile viewport |
| **CTA** | button/link count, CTA text ("get started", "contact", "book"), placement, form presence |
| **Trust** | SSL, contact info, testimonials, reviews, social proof, privacy policy link, team/about |
| **Tracking** | Google Analytics, GA4, GTM, Plausible, Mixpanel, Hotjar, Meta Pixel, any analytics script |

### Grade Thresholds
| Score | Grade |
|-------|-------|
| 90+ | A+ |
| 85-89 | A |
| 80-84 | A- |
| 75-79 | B+ |
| 70-74 | B |
| 65-69 | B- |
| 60-64 | C+ |
| 55-59 | C |
| 50-54 | C- |
| 45-49 | D+ |
| 40-44 | D |
| 35-39 | D- |
| 0-34 | F |

## Puppeteer-Specific Additions

These fields don't exist in the current Python scanner but would be high-value additions from Puppeteer:

### `pages_analyzed[].js_diff` (NEW)
```jsonc
{
  "elements_added": 42,           // DOM node count difference (JS on vs off)
  "text_content_changed": [       // Content only visible after JS execution
    {
      "selector": ".counter-stat",
      "no_js_text": "0%",         // What crawlers/LLMs see
      "js_text": "98%",           // What users see
      "description": "Animated counter"
    }
  ],
  "schemas_injected_by_js": 3,    // JSON-LD blocks that React/Next injects at hydration
  "forms_added_by_js": 0          // Forms only present after JS
}
```

This powers the "Proof of Scrape" page with real evidence instead of heuristics.

### `pages_analyzed[].screenshot_path` (NEW)
```
"screenshot_path": "clients/{slug}/scan/screenshots/homepage.png"
```

Full-page screenshot for visual reference. The report doesn't render these yet but they're useful for the brand extraction phase.

## CLI Interface Suggestion

```bash
# Basic scan
npx forge-scanner --url https://example.com --slug example-com

# With competitors
npx forge-scanner --url https://example.com --slug example-com \
  --competitors https://rival1.com,https://rival2.com

# With industry
npx forge-scanner --url https://example.com --slug example-com \
  --industry dental

# Output location (always):
# clients/{slug}/audit/unified-audit-data.json
```

After the scanner outputs the JSON, run:
```bash
python execution/generate_client_reports.py --slug example-com
```
