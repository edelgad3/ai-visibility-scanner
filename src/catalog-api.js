// Asset Catalog API — persistent, editable, versioned component catalog with agentic annotations
// Auth: X-API-Key header (same as agency API)
// Mounts under /api/v1/agency/* alongside existing agency routes

const { Router } = require("express");
const {
  uuidParam, catalogListQuery, catalogUpdateBody, annotationOverrideBody,
  annotationBulkBody, customAnnotationCreate, customAnnotationUpdate,
  catalogImportBody, catalogCompareQuery, agentPreviewQuery,
  autoAnnotateBulkBody, catalogPagesQuery, annotationType,
} = require("./catalog-schemas");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Supabase helpers (same pattern as agency-api.js) ──

async function sbQuery(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: options.headers?.Prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
  if (options.method === "PATCH" && resp.ok) {
    const text = await resp.text();
    return text ? JSON.parse(text) : [];
  }
  if (options.method === "DELETE" && resp.ok) {
    return null;
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sbInsert(table, data) {
  return sbQuery(table, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
}

async function sbUpdate(table, filter, data) {
  return sbQuery(`${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
}

async function sbDelete(table, filter) {
  return sbQuery(`${table}?${filter}`, { method: "DELETE" });
}

// ── Auth middleware (same as agency-api.js) ──

function agencyApiAuth() {
  return async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "X-API-Key header required" });
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: "Database not configured" });
    try {
      const rows = await sbQuery(
        `agencies?api_key=eq.${encodeURIComponent(apiKey)}&active=eq.true&select=*&limit=1`
      );
      if (!rows?.[0]) return res.status(401).json({ error: "Invalid API key" });
      req.agency = rows[0];
      next();
    } catch (e) {
      return res.status(500).json({ error: "Auth lookup failed" });
    }
  };
}

// ── Verify client belongs to agency ──

async function verifyClient(req, res) {
  const { clientId } = req.params;
  const parse = uuidParam.safeParse(clientId);
  if (!parse.success) { res.status(400).json({ error: "Invalid clientId" }); return null; }

  const rows = await sbQuery(
    `agency_clients?id=eq.${clientId}&agency_id=eq.${req.agency.id}&select=id,name,website_url&limit=1`
  );
  if (!rows?.[0]) { res.status(404).json({ error: "Client not found" }); return null; }
  return rows[0];
}

// ── Verify asset belongs to agency ──

async function verifyAsset(req, res) {
  const { assetId } = req.params;
  const parse = uuidParam.safeParse(assetId);
  if (!parse.success) { res.status(400).json({ error: "Invalid assetId" }); return null; }

  const rows = await sbQuery(
    `asset_catalog?id=eq.${assetId}&agency_id=eq.${req.agency.id}&select=*&limit=1`
  );
  if (!rows?.[0]) { res.status(404).json({ error: "Asset not found" }); return null; }
  return rows[0];
}

// ═══════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════

function createCatalogApiRouter() {
  const r = Router();
  const auth = agencyApiAuth();

  // ─── 1. Catalog Overview Summary ───────────────────────────────────
  // GET /api/v1/agency/catalog/summary
  r.get("/api/v1/agency/catalog/summary", auth, async (req, res) => {
    try {
      const agencyId = req.agency.id;

      // Get all clients for this agency
      const clients = await sbQuery(
        `agency_clients?agency_id=eq.${agencyId}&status=eq.active&select=id,name,website_url`
      );

      // Get catalog stats per client
      const clientStats = [];
      for (const client of clients) {
        const items = await sbQuery(
          `asset_catalog?client_id=eq.${client.id}&status=neq.archived&select=id`
        );
        const totalComponents = items.length;

        if (totalComponents === 0) continue;

        const annotations = await sbQuery(
          `asset_annotations?asset_id=in.(${items.map(i => i.id).join(",")})&select=asset_id,completeness_score`
        );

        // An asset is "annotated" if it has at least one annotation with score > 0
        const annotatedAssetIds = new Set(
          annotations.filter(a => a.completeness_score > 0).map(a => a.asset_id)
        );

        const customAnns = await sbQuery(
          `asset_custom_annotations?agency_id=eq.${agencyId}&asset_id=in.(${items.map(i => i.id).join(",")})&select=id,asset_id`
        );

        // Auto = annotations with score > 0 that don't have overrides
        const autoAnnotations = await sbQuery(
          `asset_annotations?asset_id=in.(${items.map(i => i.id).join(",")})&completeness_score=gt.0&override_value=is.null&select=id`
        );

        // Get distinct page_urls for page count
        const pageUrls = new Set(items.map(i => i.page_url).filter(Boolean));

        // Coverage = annotated assets / total assets
        const coveragePct = totalComponents > 0
          ? Math.round((annotatedAssetIds.size / totalComponents) * 1000) / 10
          : 0;

        clientStats.push({
          client_id: client.id,
          client_name: client.name,
          website_url: client.website_url,
          total_pages: pageUrls.size,
          total_components: totalComponents,
          annotated_components: annotatedAssetIds.size,
          coverage_pct: coveragePct,
          custom_annotations: customAnns.length,
          auto_annotations: autoAnnotations.length,
          needs_attention: coveragePct < 50,
        });
      }

      res.json({ agency_id: agencyId, clients: clientStats });
    } catch (e) {
      console.error("Catalog summary error:", e.message);
      res.status(500).json({ error: "Failed to load catalog summary" });
    }
  });

  // ─── 2. List Catalog Items ─────────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog
  r.get("/api/v1/agency/clients/:clientId/catalog", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const q = catalogListQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: q.error.flatten() });
      const { category, page_url, status, limit, offset, include_annotations } = q.data;

      // Build filter
      let filter = `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}`;
      if (category) filter += `&category=eq.${category}`;
      if (page_url) filter += `&page_url=eq.${encodeURIComponent(page_url)}`;
      if (status) {
        const statuses = status.split(",").map(s => s.trim());
        filter += `&status=in.(${statuses.join(",")})`;
      } else {
        filter += `&status=in.(detected,reviewed,enhanced)`;
      }
      filter += `&order=page_url.asc,category.asc,name.asc`;
      filter += `&limit=${limit}&offset=${offset}`;
      filter += `&select=*`;

      const items = await sbQuery(filter);

      // Optionally include annotations
      if (include_annotations && items.length > 0) {
        const ids = items.map(i => i.id).join(",");
        const anns = await sbQuery(`asset_annotations?asset_id=in.(${ids})&select=*`);
        const annsByAsset = {};
        for (const a of anns) {
          (annsByAsset[a.asset_id] = annsByAsset[a.asset_id] || []).push(a);
        }
        for (const item of items) {
          item.annotations = annsByAsset[item.id] || [];
        }
      }

      // Summary counts
      const allItems = await sbQuery(
        `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}&status=neq.archived&select=category,status`
      );
      const byCategory = {};
      const byStatus = {};
      for (const i of allItems) {
        byCategory[i.category] = (byCategory[i.category] || 0) + 1;
        byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      }

      res.json({
        client: { id: client.id, name: client.name },
        items,
        count: allItems.length,
        limit,
        offset,
        summary: { by_category: byCategory, by_status: byStatus, total: allItems.length },
      });
    } catch (e) {
      console.error("Catalog list error:", e.message);
      res.status(500).json({ error: "Failed to list catalog items" });
    }
  });

  // ─── 3. Per-Page Stats ─────────────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog/pages
  r.get("/api/v1/agency/clients/:clientId/catalog/pages", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const q = catalogPagesQuery.omit({ clientId: true }).safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: q.error.flatten() });
      const { limit, offset } = q.data;

      // Get all non-archived items grouped by page
      const items = await sbQuery(
        `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}&status=neq.archived&select=id,page_url`
      );

      // Group by page_url
      const pageMap = {};
      for (const item of items) {
        const url = item.page_url || "(site-level)";
        if (!pageMap[url]) pageMap[url] = [];
        pageMap[url].push(item.id);
      }

      // Get annotation data for all items
      const allIds = items.map(i => i.id);
      let annData = [];
      if (allIds.length > 0) {
        annData = await sbQuery(
          `asset_annotations?asset_id=in.(${allIds.join(",")})&select=asset_id,annotation_type,completeness_score`
        );
      }

      const annByAsset = {};
      for (const a of annData) {
        (annByAsset[a.asset_id] = annByAsset[a.asset_id] || []).push(a);
      }

      const pages = Object.entries(pageMap).map(([url, assetIds]) => {
        let annotationCount = 0;
        let ariaCount = 0;
        let schemaCount = 0;
        let webmcpCount = 0;

        for (const aid of assetIds) {
          const assetAnns = annByAsset[aid] || [];
          const hasAny = assetAnns.some(a => a.completeness_score > 0);
          if (hasAny) annotationCount++;
          if (assetAnns.find(a => a.annotation_type === "aria" && a.completeness_score > 0)) ariaCount++;
          if (assetAnns.find(a => a.annotation_type === "schema_org" && a.completeness_score > 0)) schemaCount++;
          if (assetAnns.find(a => a.annotation_type === "webmcp" && a.completeness_score > 0)) webmcpCount++;
        }

        const componentCount = assetIds.length;
        const coveragePct = componentCount > 0
          ? Math.round((annotationCount / componentCount) * 1000) / 10
          : 0;

        // Derive slug
        let pageSlug = "index";
        try {
          const pathname = new URL(url).pathname;
          pageSlug = encodeURIComponent(pathname.replace(/\//g, "_").slice(1)) || "index";
        } catch {
          pageSlug = url === "(site-level)" ? "site-level" : encodeURIComponent(url);
        }

        return {
          page_url: url,
          page_slug: pageSlug,
          component_count: componentCount,
          annotation_count: annotationCount,
          coverage_pct: coveragePct,
          aria_count: ariaCount,
          schema_count: schemaCount,
          webmcp_count: webmcpCount,
        };
      });

      // Sort by page_url, paginate
      pages.sort((a, b) => a.page_url.localeCompare(b.page_url));
      const paged = pages.slice(offset, offset + limit);

      res.json({
        client_id: client.id,
        pages: paged,
        count: pages.length,
        limit,
        offset,
      });
    } catch (e) {
      console.error("Catalog pages error:", e.message);
      res.status(500).json({ error: "Failed to load catalog pages" });
    }
  });

  // ─── 4. Get Single Catalog Item ────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog/:assetId
  r.get("/api/v1/agency/clients/:clientId/catalog/:assetId", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      // Get annotations
      const annotations = await sbQuery(
        `asset_annotations?asset_id=eq.${asset.id}&select=*&order=annotation_type.asc`
      );

      // Get custom annotations
      const customAnnotations = await sbQuery(
        `asset_custom_annotations?asset_id=eq.${asset.id}&agency_id=eq.${req.agency.id}&select=*&order=created_at.desc`
      );

      res.json({ ...asset, annotations, custom_annotations: customAnnotations });
    } catch (e) {
      console.error("Catalog get error:", e.message);
      res.status(500).json({ error: "Failed to load catalog item" });
    }
  });

  // ─── 5. Update Catalog Item ────────────────────────────────────────
  // PUT /api/v1/agency/clients/:clientId/catalog/:assetId
  r.put("/api/v1/agency/clients/:clientId/catalog/:assetId", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const body = catalogUpdateBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      const updateData = { ...body.data, version: asset.version + 1 };
      await sbUpdate("asset_catalog", `id=eq.${asset.id}`, updateData);

      // Re-fetch with annotations
      const updated = await sbQuery(`asset_catalog?id=eq.${asset.id}&select=*&limit=1`);
      const annotations = await sbQuery(`asset_annotations?asset_id=eq.${asset.id}&select=*`);
      const customAnnotations = await sbQuery(
        `asset_custom_annotations?asset_id=eq.${asset.id}&agency_id=eq.${req.agency.id}&select=*`
      );

      res.json({ ...updated[0], annotations, custom_annotations: customAnnotations });
    } catch (e) {
      console.error("Catalog update error:", e.message);
      res.status(500).json({ error: "Failed to update catalog item" });
    }
  });

  // ─── 6. Archive Catalog Item ───────────────────────────────────────
  // DELETE /api/v1/agency/clients/:clientId/catalog/:assetId
  r.delete("/api/v1/agency/clients/:clientId/catalog/:assetId", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      await sbUpdate("asset_catalog", `id=eq.${asset.id}`, { status: "archived" });
      res.json({ archived: true, id: asset.id });
    } catch (e) {
      console.error("Catalog archive error:", e.message);
      res.status(500).json({ error: "Failed to archive catalog item" });
    }
  });

  // ─── 7. List Annotations ──────────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog/:assetId/annotations
  r.get("/api/v1/agency/clients/:clientId/catalog/:assetId/annotations", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const annotations = await sbQuery(
        `asset_annotations?asset_id=eq.${asset.id}&select=*&order=annotation_type.asc`
      );
      const customAnnotations = await sbQuery(
        `asset_custom_annotations?asset_id=eq.${asset.id}&agency_id=eq.${req.agency.id}&select=*&order=created_at.desc`
      );

      res.json({ asset_id: asset.id, annotations, custom_annotations: customAnnotations });
    } catch (e) {
      console.error("Annotations list error:", e.message);
      res.status(500).json({ error: "Failed to load annotations" });
    }
  });

  // ─── 8. Override Annotation ────────────────────────────────────────
  // PUT /api/v1/agency/clients/:clientId/catalog/:assetId/annotations/:annotationType
  r.put("/api/v1/agency/clients/:clientId/catalog/:assetId/annotations/:annotationType", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const typeCheck = annotationType.safeParse(req.params.annotationType);
      if (!typeCheck.success) return res.status(400).json({ error: "Invalid annotation type" });

      const body = annotationOverrideBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      // Find or create the annotation row
      let ann = await sbQuery(
        `asset_annotations?asset_id=eq.${asset.id}&annotation_type=eq.${typeCheck.data}&select=*&limit=1`
      );

      if (!ann?.[0]) {
        // Create annotation row
        const inserted = await sbInsert("asset_annotations", {
          asset_id: asset.id,
          annotation_type: typeCheck.data,
          current_value: {},
          override_value: body.data.override_value,
          override_by: req.agency.name || "agency",
          override_at: new Date().toISOString(),
        });
        ann = inserted;
      } else {
        // Record history
        await sbInsert("asset_annotation_history", {
          annotation_id: ann[0].id,
          asset_id: asset.id,
          annotation_type: typeCheck.data,
          previous_value: ann[0].override_value || ann[0].current_value,
          new_value: body.data.override_value,
          change_source: "agency_edit",
          changed_by: req.agency.name || "agency",
        });

        // Update annotation
        await sbUpdate("asset_annotations", `id=eq.${ann[0].id}`, {
          override_value: body.data.override_value,
          override_by: req.agency.name || "agency",
          override_at: new Date().toISOString(),
          version: ann[0].version + 1,
        });

        ann = await sbQuery(`asset_annotations?id=eq.${ann[0].id}&select=*&limit=1`);
      }

      res.json(ann[0] || ann);
    } catch (e) {
      console.error("Annotation override error:", e.message);
      res.status(500).json({ error: "Failed to override annotation" });
    }
  });

  // ─── 9. Clear Annotation Override ──────────────────────────────────
  // DELETE /api/v1/agency/clients/:clientId/catalog/:assetId/annotations/:annotationType/override
  r.delete("/api/v1/agency/clients/:clientId/catalog/:assetId/annotations/:annotationType/override", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const typeCheck = annotationType.safeParse(req.params.annotationType);
      if (!typeCheck.success) return res.status(400).json({ error: "Invalid annotation type" });

      const ann = await sbQuery(
        `asset_annotations?asset_id=eq.${asset.id}&annotation_type=eq.${typeCheck.data}&select=*&limit=1`
      );
      if (!ann?.[0]) return res.status(404).json({ error: "Annotation not found" });

      // Record history
      if (ann[0].override_value) {
        await sbInsert("asset_annotation_history", {
          annotation_id: ann[0].id,
          asset_id: asset.id,
          annotation_type: typeCheck.data,
          previous_value: ann[0].override_value,
          new_value: {},
          change_source: "agency_edit",
          changed_by: req.agency.name || "agency",
          notes: "Override cleared",
        });
      }

      await sbUpdate("asset_annotations", `id=eq.${ann[0].id}`, {
        override_value: null,
        override_by: null,
        override_at: null,
        version: ann[0].version + 1,
      });

      res.json({ cleared: true });
    } catch (e) {
      console.error("Clear override error:", e.message);
      res.status(500).json({ error: "Failed to clear override" });
    }
  });

  // ─── 10. Bulk Update Annotations ──────────────────────────────────
  // POST /api/v1/agency/clients/:clientId/catalog/:assetId/annotations/bulk
  r.post("/api/v1/agency/clients/:clientId/catalog/:assetId/annotations/bulk", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const body = annotationBulkBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      const results = [];
      for (const item of body.data.annotations) {
        let ann = await sbQuery(
          `asset_annotations?asset_id=eq.${asset.id}&annotation_type=eq.${item.annotation_type}&select=*&limit=1`
        );

        if (!ann?.[0]) {
          const inserted = await sbInsert("asset_annotations", {
            asset_id: asset.id,
            annotation_type: item.annotation_type,
            current_value: {},
            override_value: item.override_value,
            override_by: req.agency.name || "agency",
            override_at: new Date().toISOString(),
          });
          results.push(inserted[0] || inserted);
        } else {
          await sbInsert("asset_annotation_history", {
            annotation_id: ann[0].id,
            asset_id: asset.id,
            annotation_type: item.annotation_type,
            previous_value: ann[0].override_value || ann[0].current_value,
            new_value: item.override_value,
            change_source: "agency_edit",
            changed_by: req.agency.name || "agency",
          });

          await sbUpdate("asset_annotations", `id=eq.${ann[0].id}`, {
            override_value: item.override_value,
            override_by: req.agency.name || "agency",
            override_at: new Date().toISOString(),
            version: ann[0].version + 1,
          });

          const updated = await sbQuery(`asset_annotations?id=eq.${ann[0].id}&select=*&limit=1`);
          results.push(updated[0]);
        }
      }

      res.json({ updated: results.length, annotations: results });
    } catch (e) {
      console.error("Bulk annotation error:", e.message);
      res.status(500).json({ error: "Failed to bulk update annotations" });
    }
  });

  // ─── 11. Auto-Annotate Single Component ────────────────────────────
  // POST /api/v1/agency/clients/:clientId/catalog/:assetId/auto-annotate
  r.post("/api/v1/agency/clients/:clientId/catalog/:assetId/auto-annotate", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      // Generate recommended annotations based on asset data
      const generated = generateAnnotations(asset);

      // Upsert recommended_value for each annotation type
      for (const g of generated) {
        const existing = await sbQuery(
          `asset_annotations?asset_id=eq.${asset.id}&annotation_type=eq.${g.annotation_type}&select=*&limit=1`
        );

        if (existing?.[0]) {
          await sbUpdate("asset_annotations", `id=eq.${existing[0].id}`, {
            recommended_value: g.recommended_value,
            completeness_score: g.completeness_score,
            version: existing[0].version + 1,
          });
        } else {
          await sbInsert("asset_annotations", {
            asset_id: asset.id,
            annotation_type: g.annotation_type,
            current_value: {},
            recommended_value: g.recommended_value,
            completeness_score: g.completeness_score,
          });
        }
      }

      res.json({
        asset_id: asset.id,
        generated_annotations: generated,
        status: "pending_review",
      });
    } catch (e) {
      console.error("Auto-annotate error:", e.message);
      res.status(500).json({ error: "Failed to auto-annotate" });
    }
  });

  // ─── 12. Bulk Auto-Annotate ────────────────────────────────────────
  // POST /api/v1/agency/clients/:clientId/catalog/auto-annotate
  r.post("/api/v1/agency/clients/:clientId/catalog/auto-annotate", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const body = autoAnnotateBulkBody.safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      let filter = `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}&status=neq.archived&select=*`;
      if (body.data.page_url) filter += `&page_url=eq.${encodeURIComponent(body.data.page_url)}`;

      const assets = await sbQuery(filter);
      let annotationsGenerated = 0;

      for (const asset of assets) {
        const generated = generateAnnotations(asset);
        for (const g of generated) {
          const existing = await sbQuery(
            `asset_annotations?asset_id=eq.${asset.id}&annotation_type=eq.${g.annotation_type}&select=*&limit=1`
          );

          if (existing?.[0]) {
            await sbUpdate("asset_annotations", `id=eq.${existing[0].id}`, {
              recommended_value: g.recommended_value,
              completeness_score: g.completeness_score,
              version: existing[0].version + 1,
            });
          } else {
            await sbInsert("asset_annotations", {
              asset_id: asset.id,
              annotation_type: g.annotation_type,
              current_value: {},
              recommended_value: g.recommended_value,
              completeness_score: g.completeness_score,
            });
          }
          annotationsGenerated++;
        }
      }

      res.json({
        client_id: client.id,
        components_processed: assets.length,
        annotations_generated: annotationsGenerated,
        status: "complete",
      });
    } catch (e) {
      console.error("Bulk auto-annotate error:", e.message);
      res.status(500).json({ error: "Failed to bulk auto-annotate" });
    }
  });

  // ─── 13. Create Custom Annotation ─────────────────────────────────
  // POST /api/v1/agency/clients/:clientId/catalog/:assetId/custom
  r.post("/api/v1/agency/clients/:clientId/catalog/:assetId/custom", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const body = customAnnotationCreate.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      const inserted = await sbInsert("asset_custom_annotations", {
        asset_id: asset.id,
        agency_id: req.agency.id,
        key: body.data.key,
        value_text: body.data.value_text || null,
        value_json: body.data.value_json || null,
        value_type: body.data.value_type,
        created_by: req.agency.name || "agency",
      });

      res.status(201).json(inserted[0] || inserted);
    } catch (e) {
      if (e.message?.includes("duplicate key") || e.message?.includes("unique")) {
        return res.status(409).json({ error: "Custom annotation with this key already exists" });
      }
      console.error("Custom annotation create error:", e.message);
      res.status(500).json({ error: "Failed to create custom annotation" });
    }
  });

  // ─── 14. Update Custom Annotation ─────────────────────────────────
  // PUT /api/v1/agency/clients/:clientId/catalog/:assetId/custom/:customId
  r.put("/api/v1/agency/clients/:clientId/catalog/:assetId/custom/:customId", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const customId = req.params.customId;
      const idCheck = uuidParam.safeParse(customId);
      if (!idCheck.success) return res.status(400).json({ error: "Invalid customId" });

      const body = customAnnotationUpdate.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      // Verify ownership
      const existing = await sbQuery(
        `asset_custom_annotations?id=eq.${customId}&asset_id=eq.${asset.id}&agency_id=eq.${req.agency.id}&select=*&limit=1`
      );
      if (!existing?.[0]) return res.status(404).json({ error: "Custom annotation not found" });

      await sbUpdate("asset_custom_annotations", `id=eq.${customId}`, body.data);

      const updated = await sbQuery(`asset_custom_annotations?id=eq.${customId}&select=*&limit=1`);
      res.json(updated[0]);
    } catch (e) {
      console.error("Custom annotation update error:", e.message);
      res.status(500).json({ error: "Failed to update custom annotation" });
    }
  });

  // ─── 15. Delete Custom Annotation ─────────────────────────────────
  // DELETE /api/v1/agency/clients/:clientId/catalog/:assetId/custom/:customId
  r.delete("/api/v1/agency/clients/:clientId/catalog/:assetId/custom/:customId", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;
      const asset = await verifyAsset(req, res);
      if (!asset) return;

      const customId = req.params.customId;
      const idCheck = uuidParam.safeParse(customId);
      if (!idCheck.success) return res.status(400).json({ error: "Invalid customId" });

      // Verify ownership
      const existing = await sbQuery(
        `asset_custom_annotations?id=eq.${customId}&asset_id=eq.${asset.id}&agency_id=eq.${req.agency.id}&select=id&limit=1`
      );
      if (!existing?.[0]) return res.status(404).json({ error: "Custom annotation not found" });

      await sbDelete("asset_custom_annotations", `id=eq.${customId}`);
      res.json({ deleted: true });
    } catch (e) {
      console.error("Custom annotation delete error:", e.message);
      res.status(500).json({ error: "Failed to delete custom annotation" });
    }
  });

  // ─── 16. Import from Scan ─────────────────────────────────────────
  // POST /api/v1/agency/clients/:clientId/catalog/import
  r.post("/api/v1/agency/clients/:clientId/catalog/import", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const body = catalogImportBody.safeParse(req.body || {});
      if (!body.success) return res.status(400).json({ error: body.error.flatten() });

      let scanId = body.data.scan_id;
      const mode = body.data.mode;

      // If no scan_id, find the latest completed scan for this client
      if (!scanId) {
        const scans = await sbQuery(
          `scans?agency_client_id=eq.${client.id}&status=eq.completed&select=id&order=created_at.desc&limit=1`
        );
        if (!scans?.[0]) return res.status(404).json({ error: "No completed scans found for this client" });
        scanId = scans[0].id;
      }

      // Load scan results
      const scanRows = await sbQuery(`scans?id=eq.${scanId}&select=id,results,created_at&limit=1`);
      if (!scanRows?.[0]?.results) return res.status(404).json({ error: "Scan results not found" });

      const results = scanRows[0].results;
      const agencyId = req.agency.id;
      const clientId = client.id;

      // If replace mode, archive all existing
      if (mode === "replace") {
        await sbUpdate(
          "asset_catalog",
          `client_id=eq.${clientId}&agency_id=eq.${agencyId}&status=neq.archived`,
          { status: "archived" }
        );
      }

      // Extract inventory items from scan results
      const inventoryItems = extractInventoryFromScan(results, client.website_url);
      let itemsCreated = 0;
      let itemsUpdated = 0;
      let annotationsGenerated = 0;
      const seenIds = [];

      for (const item of inventoryItems) {
        // Dedup key: (client_id, category, sub_type, page_url) or (client_id, category, sub_type) for site-level
        let dedup = `client_id=eq.${clientId}&category=eq.${item.category}`;
        if (item.sub_type) dedup += `&sub_type=eq.${encodeURIComponent(item.sub_type)}`;
        if (item.page_url) dedup += `&page_url=eq.${encodeURIComponent(item.page_url)}`;
        dedup += `&status=neq.archived`;

        const existing = await sbQuery(`asset_catalog?${dedup}&select=id,version&limit=1`);

        let assetId;
        if (existing?.[0] && mode !== "append") {
          // Update existing
          await sbUpdate("asset_catalog", `id=eq.${existing[0].id}`, {
            last_seen_at: new Date().toISOString(),
            raw_value: item.raw_value || {},
            exists_on_site: true,
            scan_id: scanId,
            version: existing[0].version + 1,
            content_summary: item.content_summary,
          });
          assetId = existing[0].id;
          itemsUpdated++;
        } else if (!existing?.[0]) {
          // Insert new
          const inserted = await sbInsert("asset_catalog", {
            agency_id: agencyId,
            client_id: clientId,
            scan_id: scanId,
            name: item.name,
            category: item.category,
            sub_type: item.sub_type,
            page_url: item.page_url,
            page_type: item.page_type,
            dom_selector: item.dom_selector,
            component_type: item.component_type,
            content_summary: item.content_summary,
            raw_value: item.raw_value || {},
          });
          assetId = inserted[0]?.id;
          itemsCreated++;
        } else {
          assetId = existing[0].id;
        }

        if (assetId) {
          seenIds.push(assetId);
          // Auto-generate annotations
          const generated = generateAnnotations({ ...item, id: assetId });
          for (const g of generated) {
            const existingAnn = await sbQuery(
              `asset_annotations?asset_id=eq.${assetId}&annotation_type=eq.${g.annotation_type}&select=id,version&limit=1`
            );
            if (existingAnn?.[0]) {
              await sbUpdate("asset_annotations", `id=eq.${existingAnn[0].id}`, {
                current_value: g.recommended_value,
                completeness_score: g.completeness_score,
                version: existingAnn[0].version + 1,
              });
            } else {
              await sbInsert("asset_annotations", {
                asset_id: assetId,
                annotation_type: g.annotation_type,
                current_value: g.recommended_value,
                completeness_score: g.completeness_score,
              });
            }
            annotationsGenerated++;
          }
        }
      }

      // Mark assets not seen in this scan as missing (merge mode only)
      if (mode === "merge" && seenIds.length > 0) {
        await sbQuery(`rpc/mark_missing_assets`, {
          method: "POST",
          body: JSON.stringify({
            p_client_id: clientId,
            p_scan_id: scanId,
            p_seen_asset_ids: seenIds,
          }),
        });
      }

      const itemsRemoved = mode === "merge" ? (inventoryItems.length > 0 ? "check_async" : 0) : 0;

      res.json({
        scan_id: scanId,
        mode,
        items_created: itemsCreated,
        items_updated: itemsUpdated,
        annotations_generated: annotationsGenerated,
        total_items: seenIds.length,
      });
    } catch (e) {
      console.error("Catalog import error:", e.message);
      res.status(500).json({ error: "Failed to import catalog from scan" });
    }
  });

  // ─── 17. Version Comparison ────────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog/compare
  r.get("/api/v1/agency/clients/:clientId/catalog/compare", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const q = catalogCompareQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: q.error.flatten() });

      const { scan_before, scan_after, category } = q.data;

      // Get items from both scans
      let filter = `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}`;
      if (category) filter += `&category=eq.${category}`;

      const beforeItems = await sbQuery(`${filter}&scan_id=eq.${scan_before}&select=*`);
      const afterItems = await sbQuery(`${filter}&scan_id=eq.${scan_after}&select=*`);

      // Also get items that were updated between the two scans
      const allItems = await sbQuery(
        `${filter}&status=neq.archived&select=id,name,category,sub_type,page_url,scan_id,exists_on_site,content_summary,version`
      );

      const beforeIds = new Set(beforeItems.map(i => `${i.category}:${i.sub_type}:${i.page_url}`));
      const afterIds = new Set(afterItems.map(i => `${i.category}:${i.sub_type}:${i.page_url}`));

      const changes = [];
      let added = 0, removed = 0, changed = 0, unchanged = 0;

      // Items in after but not in before = added
      for (const item of afterItems) {
        const key = `${item.category}:${item.sub_type}:${item.page_url}`;
        if (!beforeIds.has(key)) {
          changes.push({ asset_id: item.id, name: item.name, category: item.category, change_type: "added", before: null, after: item });
          added++;
        }
      }

      // Items in before but not in after = removed
      for (const item of beforeItems) {
        const key = `${item.category}:${item.sub_type}:${item.page_url}`;
        if (!afterIds.has(key)) {
          changes.push({ asset_id: item.id, name: item.name, category: item.category, change_type: "removed", before: item, after: null });
          removed++;
        }
      }

      // Items in both = check for changes
      for (const afterItem of afterItems) {
        const key = `${afterItem.category}:${afterItem.sub_type}:${afterItem.page_url}`;
        if (beforeIds.has(key)) {
          const beforeItem = beforeItems.find(b => `${b.category}:${b.sub_type}:${b.page_url}` === key);
          if (beforeItem && beforeItem.version !== afterItem.version) {
            changes.push({ asset_id: afterItem.id, name: afterItem.name, category: afterItem.category, change_type: "enhanced", before: beforeItem, after: afterItem });
            changed++;
          } else {
            unchanged++;
          }
        }
      }

      // Get scan metadata
      const beforeScan = await sbQuery(`scans?id=eq.${scan_before}&select=id,created_at&limit=1`);
      const afterScan = await sbQuery(`scans?id=eq.${scan_after}&select=id,created_at&limit=1`);

      res.json({
        before_scan: beforeScan[0] || { id: scan_before },
        after_scan: afterScan[0] || { id: scan_after },
        summary: { items_added: added, items_removed: removed, items_changed: changed, items_unchanged: unchanged },
        changes: changes.slice(0, 100), // Cap at 100 for response size
      });
    } catch (e) {
      console.error("Catalog compare error:", e.message);
      res.status(500).json({ error: "Failed to compare catalog versions" });
    }
  });

  // ─── 18. Agent Preview ─────────────────────────────────────────────
  // GET /api/v1/agency/clients/:clientId/catalog/agent-preview
  r.get("/api/v1/agency/clients/:clientId/catalog/agent-preview", auth, async (req, res) => {
    try {
      const client = await verifyClient(req, res);
      if (!client) return;

      const q = agentPreviewQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: q.error.flatten() });
      const { format, use_overrides, limit, offset } = q.data;

      // Get all catalog items + annotations
      const items = await sbQuery(
        `asset_catalog?client_id=eq.${client.id}&agency_id=eq.${req.agency.id}&status=neq.archived&select=*&limit=${limit}&offset=${offset}`
      );

      if (items.length === 0) {
        return res.json({
          client: { id: client.id, name: client.name, website: client.website_url },
          preview: {},
          completeness: { overall: 0, by_protocol: {} },
        });
      }

      const ids = items.map(i => i.id).join(",");
      const allAnns = await sbQuery(`asset_annotations?asset_id=in.(${ids})&select=*`);

      const annByAsset = {};
      for (const a of allAnns) {
        (annByAsset[a.asset_id] = annByAsset[a.asset_id] || []).push(a);
      }

      const preview = {};

      // Build llms.txt preview
      if (format === "all" || format === "llms_txt") {
        let llmsTxt = `# ${client.name}\n\n`;
        const llmsAnns = allAnns.filter(a => a.annotation_type === "llms_txt");
        for (const ann of llmsAnns) {
          const val = (use_overrides && ann.override_value) || ann.current_value;
          if (val?.included) {
            llmsTxt += `- ${val.description || "(no description)"}\n`;
          }
        }
        preview.llms_txt = { generated: llmsTxt, current_on_site: null, has_changes: true };
      }

      // Build agent-card preview
      if (format === "all" || format === "agent_card") {
        const cardAnns = allAnns.filter(a => a.annotation_type === "agent_card");
        const capabilities = [];
        for (const ann of cardAnns) {
          const val = (use_overrides && ann.override_value) || ann.current_value;
          if (val?.capability) {
            capabilities.push(val);
          }
        }
        preview.agent_card = {
          generated: { name: client.name, url: client.website_url, capabilities },
          current_on_site: null,
          has_changes: capabilities.length > 0,
        };
      }

      // Build webmcp preview
      if (format === "all" || format === "webmcp") {
        const mcpAnns = allAnns.filter(a => a.annotation_type === "webmcp");
        const forms = [];
        for (const ann of mcpAnns) {
          const val = (use_overrides && ann.override_value) || ann.current_value;
          if (val?.toolname) {
            const asset = items.find(i => i.id === ann.asset_id);
            forms.push({
              asset_id: ann.asset_id,
              toolname: val.toolname,
              tooldescription: val.tooldescription,
              action: val.action,
              source: ann.override_value ? "override" : "scan",
            });
          }
        }
        preview.webmcp = { forms };
      }

      // Build a2ui preview
      if (format === "all" || format === "a2ui") {
        const a2uiAnns = allAnns.filter(a => a.annotation_type === "a2ui");
        const components = [];
        for (const ann of a2uiAnns) {
          const val = (use_overrides && ann.override_value) || ann.current_value;
          if (val?.component_id) {
            components.push({ asset_id: ann.asset_id, jsonl_line: JSON.stringify(val) });
          }
        }
        preview.a2ui = { components };
      }

      // Completeness scores
      const byProtocol = {};
      const typeScores = {};
      const typeCounts = {};
      for (const ann of allAnns) {
        if (!typeScores[ann.annotation_type]) {
          typeScores[ann.annotation_type] = 0;
          typeCounts[ann.annotation_type] = 0;
        }
        typeScores[ann.annotation_type] += ann.completeness_score || 0;
        typeCounts[ann.annotation_type]++;
      }
      for (const [type, total] of Object.entries(typeScores)) {
        byProtocol[type] = Math.round(total / typeCounts[type]);
      }

      const allScores = Object.values(byProtocol);
      const overall = allScores.length > 0
        ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
        : 0;

      res.json({
        client: { id: client.id, name: client.name, website: client.website_url },
        preview,
        completeness: { overall, by_protocol: byProtocol },
      });
    } catch (e) {
      console.error("Agent preview error:", e.message);
      res.status(500).json({ error: "Failed to generate agent preview" });
    }
  });

  return r;
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: Generate annotations from asset data
// ═══════════════════════════════════════════════════════════════════════

function generateAnnotations(asset) {
  const annotations = [];
  const raw = asset.raw_value || {};
  const cat = asset.category;

  // Every item gets aria + semantic_html
  annotations.push({
    annotation_type: "aria",
    recommended_value: inferAriaAnnotation(asset),
    completeness_score: scoreAnnotation("aria", inferAriaAnnotation(asset)),
  });

  annotations.push({
    annotation_type: "semantic_html",
    recommended_value: inferSemanticAnnotation(asset),
    completeness_score: scoreAnnotation("semantic_html", inferSemanticAnnotation(asset)),
  });

  // Schema items get schema_org
  if (cat === "schema" || raw.type || raw.raw_jsonld) {
    annotations.push({
      annotation_type: "schema_org",
      recommended_value: inferSchemaAnnotation(asset),
      completeness_score: scoreAnnotation("schema_org", inferSchemaAnnotation(asset)),
    });
  }

  // Form items get webmcp + a2ui
  if (cat === "form" || raw.toolname || raw.fields) {
    annotations.push({
      annotation_type: "webmcp",
      recommended_value: inferWebmcpAnnotation(asset),
      completeness_score: scoreAnnotation("webmcp", inferWebmcpAnnotation(asset)),
    });
    annotations.push({
      annotation_type: "a2ui",
      recommended_value: inferA2uiAnnotation(asset),
      completeness_score: scoreAnnotation("a2ui", inferA2uiAnnotation(asset)),
    });
  }

  // Form items also get ag_ui (streaming interaction layer)
  if (cat === "form" || raw.toolname || raw.fields) {
    annotations.push({
      annotation_type: "ag_ui",
      recommended_value: inferAgUiAnnotation(asset),
      completeness_score: scoreAnnotation("ag_ui", inferAgUiAnnotation(asset)),
    });
  }

  // Protocol items get llms_txt + agent_card + acp + anp
  if (cat === "protocol" || raw.protocol_type) {
    annotations.push({
      annotation_type: "llms_txt",
      recommended_value: inferLlmsTxtAnnotation(asset),
      completeness_score: scoreAnnotation("llms_txt", inferLlmsTxtAnnotation(asset)),
    });
    annotations.push({
      annotation_type: "agent_card",
      recommended_value: inferAgentCardAnnotation(asset),
      completeness_score: scoreAnnotation("agent_card", inferAgentCardAnnotation(asset)),
    });
    annotations.push({
      annotation_type: "acp",
      recommended_value: inferAcpAnnotation(asset),
      completeness_score: scoreAnnotation("acp", inferAcpAnnotation(asset)),
    });
    annotations.push({
      annotation_type: "anp",
      recommended_value: inferAnpAnnotation(asset),
      completeness_score: scoreAnnotation("anp", inferAnpAnnotation(asset)),
    });
  }

  return annotations;
}

function inferAriaAnnotation(asset) {
  const tag = asset.component_type || asset.sub_type || "";
  const roleMap = {
    nav: "navigation", header: "banner", footer: "contentinfo",
    form: "form", main: "main", aside: "complementary",
    hero: "banner", sidebar: "complementary", navigation: "navigation",
  };
  return {
    role: roleMap[tag.toLowerCase()] || null,
    label: asset.name || null,
    describedby: null,
    live_region: null,
  };
}

function inferSemanticAnnotation(asset) {
  const tag = asset.sub_type || "div";
  const suggestMap = {
    div: "section", span: "p", header: "header", nav: "nav",
    footer: "footer", form: "form", main: "main",
  };
  return {
    current_tag: tag,
    recommended_tag: suggestMap[tag.toLowerCase()] || tag,
    reason: tag === "div" ? "Consider using semantic HTML for better accessibility and AI parsing" : null,
    landmark_role: null,
  };
}

function inferSchemaAnnotation(asset) {
  const raw = asset.raw_value || {};
  return {
    type: raw.type || raw["@type"] || null,
    name: raw.name || null,
    description: raw.description || null,
    properties: raw.properties || {},
    raw_jsonld: raw.raw_jsonld ? JSON.stringify(raw.raw_jsonld) : null,
  };
}

function inferWebmcpAnnotation(asset) {
  const raw = asset.raw_value || {};
  return {
    toolname: raw.toolname || null,
    tooldescription: raw.tooldescription || asset.content_summary || null,
    autosubmit: raw.autosubmit || false,
    action: raw.action || "",
  };
}

function inferA2uiAnnotation(asset) {
  const raw = asset.raw_value || {};
  return {
    component_id: raw.component_id || asset.name?.toLowerCase().replace(/\s+/g, "-") || null,
    component_type: asset.component_type || null,
    interactions: raw.interactions || (asset.category === "form" ? ["submit"] : []),
    jsonl_line: null,
  };
}

function inferLlmsTxtAnnotation(asset) {
  return {
    included: true,
    description: asset.content_summary || asset.name || null,
    section: asset.sub_type === "llms.txt" ? "## About" : "## Tools",
  };
}

function inferAgentCardAnnotation(asset) {
  return {
    capability: asset.name?.toLowerCase().replace(/\s+/g, "_") || null,
    endpoint: null,
    method: null,
    description: asset.content_summary || null,
  };
}

function inferAgUiAnnotation(asset) {
  const raw = asset.raw_value || {};
  return {
    stream_endpoint: null,
    event_types: raw.event_types || [],
    supports_sse: raw.supports_sse || false,
    copilotkit_action: raw.copilotkit_action || null,
    description: asset.content_summary || null,
  };
}

function inferAcpAnnotation(asset) {
  return {
    endpoint: null,
    method: null,
    message_types: [],
    auth_required: true,
    description: asset.content_summary || null,
  };
}

function inferAnpAnnotation(asset) {
  return {
    did_method: null,
    did_id: null,
    verification_method: null,
    service_endpoints: [],
    description: asset.content_summary || null,
  };
}

function scoreAnnotation(type, value) {
  if (!value) return 0;
  const fields = Object.entries(value);
  const filled = fields.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  return Math.round((filled.length / Math.max(fields.length, 1)) * 100);
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: Extract inventory items from scan results
// ═══════════════════════════════════════════════════════════════════════

function extractInventoryFromScan(results, websiteUrl) {
  const items = [];
  const homepage = results.homepage || results.url || websiteUrl;

  // Protocols
  if (results.protocols) {
    for (const [key, val] of Object.entries(results.protocols)) {
      if (val && typeof val === "object" && (val.found || val.exists || val.content)) {
        items.push({
          name: key,
          category: "protocol",
          sub_type: key,
          page_url: homepage,
          page_type: "homepage",
          component_type: "protocol",
          content_summary: val.summary || `${key} protocol file detected`,
          raw_value: val,
        });
      }
    }
  }

  // Schemas
  if (results.schemas && Array.isArray(results.schemas)) {
    for (const schema of results.schemas) {
      items.push({
        name: `${schema.type || schema["@type"] || "Unknown"} Schema`,
        category: "schema",
        sub_type: schema.type || schema["@type"],
        page_url: schema.page_url || homepage,
        page_type: schema.page_url === homepage ? "homepage" : "subpage",
        component_type: "schema",
        content_summary: `Schema.org ${schema.type || schema["@type"]} with ${Object.keys(schema.properties || {}).length} properties`,
        raw_value: schema,
      });
    }
  }

  // Forms
  if (results.forms?.declarative_forms) {
    for (const form of results.forms.declarative_forms) {
      items.push({
        name: form.toolname || form.name || "Form",
        category: "form",
        sub_type: form.toolname ? "webmcp_enabled" : "standard",
        page_url: form.page_url || homepage,
        page_type: form.page_url === homepage ? "homepage" : "subpage",
        dom_selector: form.selector || form.dom_selector,
        component_type: "form",
        content_summary: form.tooldescription || `Form with ${(form.fields || []).length} fields`,
        raw_value: form,
      });
    }
  }

  // SEO pages
  if (results.seo?.pages && Array.isArray(results.seo.pages)) {
    for (const page of results.seo.pages) {
      items.push({
        name: `SEO: ${page.path || page.url || "unknown"}`,
        category: "seo",
        sub_type: "page_seo",
        page_url: page.url || page.path,
        page_type: page.url === homepage ? "homepage" : "subpage",
        component_type: "seo",
        content_summary: `Title: ${page.title || "(missing)"}, Meta: ${page.meta_description ? "present" : "missing"}`,
        raw_value: page,
      });
    }
  }

  // Semantic HTML
  if (results.semantic_html && Array.isArray(results.semantic_html)) {
    for (const item of results.semantic_html) {
      items.push({
        name: `<${item.tag || item.element}> (${item.count || 1}×)`,
        category: "semantic_html",
        sub_type: item.tag || item.element,
        page_url: item.page_url || homepage,
        page_type: item.page_url === homepage ? "homepage" : "subpage",
        component_type: "semantic",
        content_summary: `${item.tag || item.element} element found ${item.count || 1} time(s)`,
        raw_value: item,
      });
    }
  }

  // Media
  if (results.media) {
    const media = results.media;
    items.push({
      name: "Media Inventory",
      category: "media",
      sub_type: "summary",
      page_url: homepage,
      page_type: "homepage",
      component_type: "media",
      content_summary: `${media.images || 0} images, ${media.videos || 0} videos`,
      raw_value: media,
    });
  }

  // Tracking
  if (results.tracking) {
    items.push({
      name: "Tracking & Analytics",
      category: "tracking",
      sub_type: "summary",
      page_url: homepage,
      page_type: "homepage",
      component_type: "tracking",
      content_summary: `Analytics: ${results.tracking.google_analytics ? "GA" : "none"}, GTM: ${results.tracking.gtm ? "yes" : "no"}`,
      raw_value: results.tracking,
    });
  }

  // Accessibility
  if (results.accessibility) {
    items.push({
      name: "Accessibility Summary",
      category: "accessibility",
      sub_type: "summary",
      page_url: homepage,
      page_type: "homepage",
      component_type: "accessibility",
      content_summary: `ARIA labels: ${results.accessibility.aria_labels || 0}, roles: ${results.accessibility.roles || 0}`,
      raw_value: results.accessibility,
    });
  }

  // Digital assets
  if (results.digital_assets) {
    const da = results.digital_assets;
    if (da.download_links > 0 || da.download_attrs > 0) {
      items.push({
        name: "Digital Assets",
        category: "digital_asset",
        sub_type: "summary",
        page_url: homepage,
        page_type: "homepage",
        component_type: "digital_asset",
        content_summary: `${da.download_links || 0} download links, ${da.download_attrs || 0} download attributes`,
        raw_value: da,
      });
    }
  }

  // JS rendering
  if (results.js_rendering) {
    const js = results.js_rendering;
    if (js.total_elements_added > 0) {
      items.push({
        name: "JS Rendering Impact",
        category: "js_rendering",
        sub_type: "summary",
        page_url: homepage,
        page_type: "homepage",
        component_type: "js_rendering",
        content_summary: `${js.total_elements_added} elements added by JavaScript`,
        raw_value: js,
      });
    }
  }

  return items;
}

module.exports = { createCatalogApiRouter };
