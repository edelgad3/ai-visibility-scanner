// UCP Commerce API — agent-to-business purchasing endpoints
// Auth: X-UCP-Key header (agent keys, not agency keys)
// Public: catalog + quote (no auth). Authenticated: register, order, cancel.
// Mounts at /api/v1/ucp/* on the Express app

const { Router } = require("express");
const crypto = require("crypto");

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
      ...(options.headers || {}),
    },
  });
  if (options.method === "PATCH" || options.method === "DELETE") {
    if (!resp.ok) throw new Error(await resp.text());
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
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
}

async function sbRpc(fn, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── UCP agent auth middleware ──

function ucpAgentAuth() {
  return async (req, res, next) => {
    const ucpKey = req.headers["x-ucp-key"];
    if (!ucpKey) {
      return res.status(401).json({ error: "X-UCP-Key header required" });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      const keyHash = crypto.createHash("sha256").update(ucpKey).digest("hex");
      const result = await sbRpc("ucp_check_agent_rate_limit", { p_key_hash: keyHash });
      const row = Array.isArray(result) ? result[0] : result;

      if (!row || !row.allowed) {
        if (row && row.agent_key_id) {
          return res.status(429).json({ error: "Daily rate limit exceeded" });
        }
        return res.status(401).json({ error: "Invalid UCP key" });
      }

      req.ucpAgent = {
        key_id: row.agent_key_id,
        agency_id: row.agency_id,
        name: row.agent_name,
        permissions: row.permissions || [],
      };
      next();
    } catch (e) {
      return res.status(500).json({ error: "Auth lookup failed" });
    }
  };
}

// Permission check helper
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.ucpAgent?.permissions?.includes(perm)) {
      return res.status(403).json({
        error: `Permission '${perm}' required`,
        your_permissions: req.ucpAgent?.permissions || [],
      });
    }
    next();
  };
}

// ── Create router ──

function createUcpApiRouter() {
  const router = Router();
  const auth = ucpAgentAuth();

  // ────────────────────────────────────────────────────────
  // POST /api/v1/ucp/register — Agent registration (get API key)
  // Public: any agent can register
  // ────────────────────────────────────────────────────────
  router.post("/api/v1/ucp/register", async (req, res) => {
    const { agent_name, agent_url, contact_email, agency_slug } = req.body;

    if (!agent_name || !contact_email) {
      return res.status(400).json({ error: "agent_name and contact_email are required" });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      // Look up the agency (default to 'ethereal' if no slug provided)
      const slug = agency_slug || "ethereal";
      const agencies = await sbQuery(
        `agencies?slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,name,slug&limit=1`
      );
      if (!agencies?.[0]) {
        return res.status(404).json({ error: `Agency '${slug}' not found` });
      }
      const agency = agencies[0];

      // Generate UCP key
      const rawKey = `ucp_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 12);

      const result = await sbInsert("ucp_agent_keys", {
        agency_id: agency.id,
        agent_name,
        agent_url: agent_url || null,
        contact_email,
        key_hash: keyHash,
        key_prefix: keyPrefix,
      });

      const record = Array.isArray(result) ? result[0] : result;

      // Log the registration event
      console.log(`UCP agent registered: ${agent_name} (${contact_email}) for agency ${agency.slug}`);

      res.status(201).json({
        id: record.id,
        agency: { id: agency.id, name: agency.name, slug: agency.slug },
        agent_name,
        key: rawKey,
        key_prefix: keyPrefix,
        permissions: ["browse_catalog", "get_quote", "place_order"],
        rate_limit_per_day: 1000,
        warning: "Save this key now. It will not be shown again.",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/v1/ucp/catalog — Browse offerings
  // Public (no auth) or authenticated
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/ucp/catalog", async (req, res) => {
    const agencySlug = req.query.agency || "ethereal";
    const category = req.query.category;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      // Resolve agency
      const agencies = await sbQuery(
        `agencies?slug=eq.${encodeURIComponent(agencySlug)}&active=eq.true&select=id,name,slug,brand_name&limit=1`
      );
      if (!agencies?.[0]) {
        return res.status(404).json({ error: `Agency '${agencySlug}' not found` });
      }
      const agency = agencies[0];

      // Build filter
      let filter = `agency_id=eq.${agency.id}&active=eq.true`;
      if (category) filter += `&category=eq.${encodeURIComponent(category)}`;

      const offerings = await sbQuery(
        `ucp_offerings?${filter}&select=id,name,slug,description,category,price_amount,price_currency,price_type,fulfillment_type,requires_auth,max_quantity,lead_time_hours,metadata,sort_order&order=sort_order,name&limit=${limit}&offset=${offset}`
      );

      res.json({
        agency: { name: agency.name, slug: agency.slug, brand: agency.brand_name },
        offerings: (offerings || []).map(o => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          description: o.description,
          category: o.category,
          price: {
            amount: o.price_amount,
            currency: o.price_currency,
            type: o.price_type,
            display: o.price_type === "quote"
              ? "Contact for quote"
              : `${(o.price_amount / 100).toFixed(2)} ${o.price_currency}`,
          },
          fulfillment: o.fulfillment_type,
          requires_auth: o.requires_auth,
          availability: {
            in_stock: o.max_quantity === null || o.max_quantity > 0,
            max_quantity: o.max_quantity,
            lead_time_hours: o.lead_time_hours,
          },
          metadata: o.metadata,
        })),
        count: (offerings || []).length,
        limit,
        offset,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/v1/ucp/quote — Get quote for specific offering
  // Public (no auth required)
  // ────────────────────────────────────────────────────────
  router.post("/api/v1/ucp/quote", async (req, res) => {
    const { offering_id, quantity = 1 } = req.body;

    if (!offering_id) {
      return res.status(400).json({ error: "offering_id is required" });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(503).json({ error: "Database not configured" });
    }

    try {
      const offerings = await sbQuery(
        `ucp_offerings?id=eq.${encodeURIComponent(offering_id)}&active=eq.true&select=*&limit=1`
      );
      if (!offerings?.[0]) {
        return res.status(404).json({ error: "Offering not found" });
      }
      const o = offerings[0];

      if (o.price_type === "quote") {
        return res.json({
          offering_id: o.id,
          name: o.name,
          price_type: "quote",
          message: "This offering requires a custom quote. Contact us.",
          contact_url: `/api/v1/ucp/register`,
        });
      }

      const unitPrice = o.price_amount;
      const total = unitPrice * quantity;

      res.json({
        offering_id: o.id,
        name: o.name,
        quantity,
        unit_price_cents: unitPrice,
        total_cents: total,
        currency: o.price_currency,
        display_total: `${(total / 100).toFixed(2)} ${o.price_currency}`,
        fulfillment_type: o.fulfillment_type,
        lead_time_hours: o.lead_time_hours,
        requires_auth_to_order: o.requires_auth,
        valid_for_minutes: 30,
        quoted_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/v1/ucp/order — Place order (requires auth)
  // ────────────────────────────────────────────────────────
  router.post("/api/v1/ucp/order", auth, requirePermission("place_order"), async (req, res) => {
    const {
      offering_id,
      quantity = 1,
      agent_reference,
      agent_notes,
      payment_method = "stripe",
    } = req.body;

    if (!offering_id) {
      return res.status(400).json({ error: "offering_id is required" });
    }

    try {
      // Verify offering exists and belongs to the agent's agency
      const offerings = await sbQuery(
        `ucp_offerings?id=eq.${encodeURIComponent(offering_id)}&agency_id=eq.${req.ucpAgent.agency_id}&active=eq.true&select=*&limit=1`
      );
      if (!offerings?.[0]) {
        return res.status(404).json({ error: "Offering not found or not available" });
      }
      const o = offerings[0];

      if (o.price_type === "quote") {
        return res.status(400).json({ error: "This offering requires a custom quote first" });
      }

      // Check stock
      if (o.max_quantity !== null && o.max_quantity < quantity) {
        return res.status(400).json({
          error: "Insufficient stock",
          available: o.max_quantity,
          requested: quantity,
        });
      }

      const unitPrice = o.price_amount;
      const total = unitPrice * quantity;

      // Create the order
      const orderData = {
        agency_id: req.ucpAgent.agency_id,
        offering_id: o.id,
        agent_key_id: req.ucpAgent.key_id,
        quantity,
        unit_price_cents: unitPrice,
        total_cents: total,
        currency: o.price_currency,
        status: "pending",
        payment_method,
        agent_name: req.ucpAgent.name,
        agent_reference: agent_reference || null,
        agent_notes: agent_notes || null,
        fulfillment_type: o.fulfillment_type,
      };

      const result = await sbInsert("ucp_orders", orderData);
      const order = Array.isArray(result) ? result[0] : result;

      // Create order_created event
      await sbInsert("ucp_order_events", {
        order_id: order.id,
        event_type: "created",
        detail: `Order placed by agent '${req.ucpAgent.name}' for ${quantity}x ${o.name}`,
        actor: "agent",
      });

      // Decrement stock if applicable
      if (o.max_quantity !== null) {
        await sbUpdate(
          "ucp_offerings",
          `id=eq.${o.id}`,
          { max_quantity: o.max_quantity - quantity }
        );
      }

      // Fire webhook if configured (non-blocking)
      fireOrderWebhook(order.id, req.ucpAgent.agency_id, "order_created").catch(() => {});

      console.log(`UCP order ${order.id}: ${req.ucpAgent.name} ordered ${quantity}x ${o.name} ($${(total / 100).toFixed(2)})`);

      res.status(201).json({
        order_id: order.id,
        status: "pending",
        offering: { id: o.id, name: o.name },
        quantity,
        total_cents: total,
        currency: o.price_currency,
        display_total: `${(total / 100).toFixed(2)} ${o.price_currency}`,
        fulfillment_type: o.fulfillment_type,
        lead_time_hours: o.lead_time_hours,
        agent_reference,
        status_url: `/api/v1/ucp/order/${order.id}`,
        created_at: order.created_at,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/v1/ucp/order/:id — Check order status
  // ────────────────────────────────────────────────────────
  router.get("/api/v1/ucp/order/:id", auth, async (req, res) => {
    try {
      const orders = await sbQuery(
        `ucp_orders?id=eq.${encodeURIComponent(req.params.id)}&agent_key_id=eq.${req.ucpAgent.key_id}&select=*&limit=1`
      );
      if (!orders?.[0]) {
        return res.status(404).json({ error: "Order not found" });
      }
      const o = orders[0];

      // Get offering name
      const offerings = await sbQuery(
        `ucp_offerings?id=eq.${o.offering_id}&select=name,slug&limit=1`
      );
      const offeringName = offerings?.[0]?.name || "Unknown";

      // Get events timeline
      const events = await sbQuery(
        `ucp_order_events?order_id=eq.${o.id}&select=event_type,detail,actor,created_at&order=created_at`
      );

      res.json({
        order_id: o.id,
        status: o.status,
        offering: { id: o.offering_id, name: offeringName },
        quantity: o.quantity,
        total_cents: o.total_cents,
        currency: o.currency,
        display_total: `${(o.total_cents / 100).toFixed(2)} ${o.currency}`,
        payment: {
          method: o.payment_method,
          paid: o.paid,
        },
        fulfillment: {
          type: o.fulfillment_type,
          fulfilled_at: o.fulfilled_at,
          data: o.fulfillment_data,
        },
        agent_reference: o.agent_reference,
        events: events || [],
        created_at: o.created_at,
        updated_at: o.updated_at,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/v1/ucp/order/:id/cancel — Cancel order
  // ────────────────────────────────────────────────────────
  router.post("/api/v1/ucp/order/:id/cancel", auth, requirePermission("place_order"), async (req, res) => {
    const { reason } = req.body;

    try {
      const orders = await sbQuery(
        `ucp_orders?id=eq.${encodeURIComponent(req.params.id)}&agent_key_id=eq.${req.ucpAgent.key_id}&select=*&limit=1`
      );
      if (!orders?.[0]) {
        return res.status(404).json({ error: "Order not found" });
      }
      const o = orders[0];

      // Can only cancel pending or confirmed orders
      if (!["pending", "confirmed"].includes(o.status)) {
        return res.status(400).json({
          error: `Cannot cancel order in '${o.status}' status`,
          cancellable_statuses: ["pending", "confirmed"],
        });
      }

      // Update order status
      await sbUpdate(
        "ucp_orders",
        `id=eq.${o.id}`,
        { status: "cancelled" }
      );

      // Log cancellation event
      await sbInsert("ucp_order_events", {
        order_id: o.id,
        event_type: "cancelled",
        detail: reason || `Cancelled by agent '${req.ucpAgent.name}'`,
        actor: "agent",
      });

      // Restore stock if applicable
      const offerings = await sbQuery(
        `ucp_offerings?id=eq.${o.offering_id}&select=max_quantity&limit=1`
      );
      if (offerings?.[0]?.max_quantity !== null) {
        await sbUpdate(
          "ucp_offerings",
          `id=eq.${o.offering_id}`,
          { max_quantity: offerings[0].max_quantity + o.quantity }
        );
      }

      // Fire webhook (non-blocking)
      fireOrderWebhook(o.id, o.agency_id, "order_cancelled").catch(() => {});

      console.log(`UCP order ${o.id} cancelled by agent '${req.ucpAgent.name}'`);

      res.json({
        order_id: o.id,
        status: "cancelled",
        reason: reason || null,
        cancelled_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// ── Webhook helper ──

async function fireOrderWebhook(orderId, agencyId, eventType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    // Look up agency's lead_webhook_url (reuse existing field for now)
    const agencies = await sbQuery(
      `agencies?id=eq.${agencyId}&select=lead_webhook_url&limit=1`
    );
    const webhookUrl = agencies?.[0]?.lead_webhook_url;
    if (!webhookUrl) return;

    // Get order data
    const orders = await sbQuery(
      `ucp_orders?id=eq.${orderId}&select=*&limit=1`
    );
    if (!orders?.[0]) return;

    const payload = {
      event: eventType,
      order: orders[0],
      timestamp: new Date().toISOString(),
    };

    // Sign the payload
    const signature = crypto
      .createHmac("sha256", SUPABASE_KEY.slice(0, 32))
      .update(JSON.stringify(payload))
      .digest("hex");

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-UCP-Signature": signature,
        "X-UCP-Event": eventType,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    // Log result
    await sbInsert("ucp_order_events", {
      order_id: orderId,
      event_type: resp.ok ? "webhook_sent" : "webhook_failed",
      detail: `${eventType} → ${webhookUrl} (${resp.status})`,
      actor: "system",
    });
  } catch (e) {
    // Log failure silently
    try {
      await sbInsert("ucp_order_events", {
        order_id: orderId,
        event_type: "webhook_failed",
        detail: `${eventType} webhook error: ${e.message}`,
        actor: "system",
      });
    } catch {}
  }
}

module.exports = { createUcpApiRouter };
