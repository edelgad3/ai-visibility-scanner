const axios = require('axios');

async function checkEndpoint(baseUrl, path) {
  try {
    const url = new URL(path, baseUrl).href;
    const response = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    
    if (response.status === 200) {
      return {
        exists: true,
        content: typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      };
    }
    return { exists: false, content: null };
  } catch (error) {
    return { exists: false, content: null };
  }
}

module.exports = { probeEndpoints };

async function probeEndpoints(baseUrl) {
  const results = {
    robots: { exists: false, has_sitemap_reference: false, ai_crawler_rules: [], ai_crawlers_mentioned: false, content_preview: "" },
    sitemap: { exists: false, url_count: 0 },
    llms_txt: { exists: false, length: 0, preview: "" },
    llms_full_txt: { exists: false, length: 0, preview: "" },
    agent_card: { exists: false },
    ucp: { exists: false }
  };

  // Launch all requests concurrently
  const [
    robotsRes,
    sitemapRes,
    llmsRes,
    llmsFullRes,
    agentCardRes,
    ucpRes
  ] = await Promise.all([
    checkEndpoint(baseUrl, '/robots.txt'),
    checkEndpoint(baseUrl, '/sitemap.xml'),
    checkEndpoint(baseUrl, '/llms.txt'),
    checkEndpoint(baseUrl, '/llms-full.txt'),
    checkEndpoint(baseUrl, '/.well-known/agent-card.json'),
    checkEndpoint(baseUrl, '/.well-known/ucp')
  ]);

  // 1. Process robots.txt
  if (robotsRes.exists) {
    results.robots.exists = true;
    results.robots.content_preview = robotsRes.content.substring(0, 500);
    results.robots.has_sitemap_reference = /sitemap:/i.test(robotsRes.content);
    
    const lines = robotsRes.content.split('\n');
    for (const line of lines) {
      if (/user-agent:.*(gptbot|chatgpt-user|claudebot|perplexitybot|oai-searchbot)/i.test(line)) {
        results.robots.ai_crawler_rules.push(line.trim());
      }
    }
    results.robots.ai_crawlers_mentioned = results.robots.ai_crawler_rules.length > 0;
  }

  // 2. Process sitemap.xml
  if (sitemapRes.exists) {
    results.sitemap.exists = true;
    const matches = sitemapRes.content.match(/<url>|<loc>/gi);
    results.sitemap.url_count = matches ? matches.length : 0;
  }

  // 3. Process llms.txt
  if (llmsRes.exists) {
    results.llms_txt.exists = true;
    results.llms_txt.length = llmsRes.content.length;
    results.llms_txt.preview = llmsRes.content.substring(0, 300);
  }

  // 4. Process llms-full.txt
  if (llmsFullRes.exists) {
    results.llms_full_txt.exists = true;
    results.llms_full_txt.length = llmsFullRes.content.length;
    results.llms_full_txt.preview = llmsFullRes.content.substring(0, 300);
  }

  // 5. Process Agent endpoints
  if (agentCardRes.exists) results.agent_card.exists = true;
  if (ucpRes.exists) results.ucp.exists = true;

  return results;
}
