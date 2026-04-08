const { z } = require("zod");

const uuidParam = z.string().uuid();

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const assetCategory = z.enum([
  "protocol", "schema", "semantic_html", "form",
  "media", "seo", "tracking", "accessibility",
  "digital_asset", "js_rendering",
]);

const assetStatus = z.enum(["detected", "reviewed", "enhanced", "archived"]);

const annotationType = z.enum([
  "aria", "schema_org", "webmcp", "a2ui",
  "llms_txt", "semantic_html", "agent_card",
]);

const catalogListQuery = paginationQuery.extend({
  category: assetCategory.optional(),
  page_url: z.string().min(1).optional(),
  status: z.string().optional(),
  include_annotations: z.coerce.boolean().default(false),
});

const catalogUpdateBody = z.object({
  name: z.string().min(1).max(500).optional(),
  content_summary: z.string().max(5000).optional(),
  status: assetStatus.optional(),
  dom_selector: z.string().max(1000).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: "At least one field required",
});

const annotationOverrideBody = z.object({
  override_value: z.record(z.unknown()),
});

const schemaOrgJsonLdValue = z.string().refine(
  (v) => { try { JSON.parse(v); return true; } catch { return false; } },
  "Must be valid JSON"
);

const annotationBulkBody = z.object({
  annotations: z.array(
    z.object({
      annotation_type: annotationType,
      override_value: z.record(z.unknown()),
    })
  ).min(1).max(7),
});

const customAnnotationCreate = z.object({
  key: z.string().min(1).max(255).regex(/^[a-z0-9_]+$/, "Key must be lowercase alphanumeric with underscores"),
  value_text: z.string().max(50000).optional(),
  value_json: z.record(z.unknown()).optional(),
  value_type: z.enum(["text", "json", "markdown", "url", "number", "boolean"]).default("text"),
}).refine(data => data.value_text !== undefined || data.value_json !== undefined, {
  message: "Either value_text or value_json is required",
});

const customAnnotationUpdate = z.object({
  value_text: z.string().max(50000).optional(),
  value_json: z.record(z.unknown()).optional(),
  value_type: z.enum(["text", "json", "markdown", "url", "number", "boolean"]).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: "At least one field required",
});

const catalogImportBody = z.object({
  scan_id: z.string().uuid().optional(),
  mode: z.enum(["merge", "replace", "append"]).default("merge"),
});

const autoAnnotateSingleParams = z.object({
  clientId: uuidParam,
  assetId: uuidParam,
});

const autoAnnotateBulkBody = z.object({
  page_url: z.string().min(1).optional(),
});

const catalogPagesQuery = paginationQuery.extend({
  clientId: uuidParam,
});

const catalogCompareQuery = z.object({
  scan_before: z.string().uuid(),
  scan_after: z.string().uuid(),
  category: assetCategory.optional(),
});

const agentPreviewQuery = paginationQuery.extend({
  format: z.enum(["all", "llms_txt", "agent_card", "webmcp", "a2ui"]).default("all"),
  use_overrides: z.coerce.boolean().default(true),
});

module.exports = {
  uuidParam, paginationQuery, assetCategory, assetStatus, annotationType,
  catalogListQuery, catalogUpdateBody, annotationOverrideBody, schemaOrgJsonLdValue,
  annotationBulkBody, customAnnotationCreate, customAnnotationUpdate,
  catalogImportBody, catalogCompareQuery, agentPreviewQuery,
  autoAnnotateSingleParams, autoAnnotateBulkBody, catalogPagesQuery,
};
