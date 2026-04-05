# AI Visibility Scanner — MCP App

Scan any website for AI visibility and marketing health, with an interactive dashboard that renders inline in Claude and ChatGPT.

## Live Endpoint

```
https://ai-visibility-scanner-production.up.railway.app/mcp
```

## Connect to Claude

### Claude Desktop
Settings > Connectors > Add Custom Connector > paste:
```
https://ai-visibility-scanner-production.up.railway.app/mcp
```

### Claude Code
```bash
claude mcp add ai-visibility-scanner --transport streamable-http https://ai-visibility-scanner-production.up.railway.app/mcp
```

## Connect to ChatGPT

Settings > Apps > Developer Mode > Add MCP Server > paste:
```
https://ai-visibility-scanner-production.up.railway.app/mcp
```

## Usage

Once connected, just ask:

> "Scan etherealmedia.ai for AI visibility"

The scanner will:
1. Probe infrastructure (robots.txt, sitemap, llms.txt, agent-card.json, etc.)
2. Analyze homepage + subpages (raw HTTP + Puppeteer JS rendering)
3. Score across 3 AI Visibility dimensions + 6 Marketing Health dimensions
4. Return interactive dashboard with findings and revenue impact estimates

## Tools

| Tool | Visibility | Description |
|------|-----------|-------------|
| `scan_website` | model + app | Full scan with scores, findings, revenue impact |
| `refresh_scan` | app only | Re-scan from the dashboard UI |

## Scores

- **GEO** (Generative Engine Optimization): Schema, robots, sitemap, llms.txt
- **Multimodal**: OG images, video, alt text, WebP/AVIF, srcset
- **Agent-Ready**: llms.txt, agent-card.json, UCP, WebMCP, semantic HTML
- **Marketing Health**: SEO, CTA/CRO, Trust, Analytics, Competitive, Growth

## Development

```bash
npm install
npm run serve    # Build UI + start MCP server on :3001
```

## Deploy

Docker with Puppeteer/Chrome:
```bash
docker build -t ai-visibility-scanner .
docker run -p 3001:3001 ai-visibility-scanner
```

Railway:
```bash
railway up
```

---

Built by [Ethereal Media](https://etherealmedia.ai) — The Ethereal Forge
