// Stripe billing module — checkout, webhooks, provisioning, portal, onboarding
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Stripe setup ──
let stripe;
function getStripe() {
  if (!stripe) {
    const Stripe = require("stripe");
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// ── Tier config ──
const TIERS = {
  starter: {
    name: "Starter",
    price_monthly: 4900, // cents
    scans_limit: 50,
    features: ["50 scans/mo", "White-label branding", "Lead routing", "Usage dashboard"],
  },
  growth: {
    name: "Growth",
    price_monthly: 14900,
    scans_limit: 250,
    features: ["250 scans/mo", "White-label branding", "Lead routing", "Usage dashboard", "Priority support"],
  },
  enterprise: {
    name: "Enterprise",
    price_monthly: 49900,
    scans_limit: 999999,
    features: ["Unlimited scans", "White-label branding", "Lead routing", "Usage dashboard", "Priority support", "Custom integrations"],
  },
};

// ── One-time setup: create Stripe products + prices ──
// Call POST /api/billing/setup once to seed Stripe
async function setupStripeProducts() {
  const s = getStripe();

  // Check if product already exists
  const existing = await s.products.search({ query: 'metadata["app"]:"ai-visibility-scanner"' });
  if (existing.data.length > 0) {
    // Fetch prices for existing product
    const product = existing.data[0];
    const prices = await s.prices.list({ product: product.id, active: true });
    return {
      product_id: product.id,
      prices: prices.data.map((p) => ({
        id: p.id,
        tier: p.metadata.tier,
        amount: p.unit_amount,
        interval: p.recurring?.interval,
      })),
      message: "Products already exist",
    };
  }

  // Create product
  const product = await s.products.create({
    name: "AI Visibility Scanner",
    description: "White-label AI visibility scanning for agencies. Scan websites for AI readiness, marketing health, and generate leads.",
    metadata: { app: "ai-visibility-scanner" },
  });

  // Create prices for each tier
  const prices = {};
  for (const [tier, config] of Object.entries(TIERS)) {
    const price = await s.prices.create({
      product: product.id,
      unit_amount: config.price_monthly,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { tier, scans_limit: String(config.scans_limit) },
    });
    prices[tier] = price.id;
  }

  return {
    product_id: product.id,
    prices,
    message: "Products and prices created",
  };
}

// ── Create checkout session ──
async function createCheckoutSession({ tier, agencyName, email, slug, successUrl, cancelUrl }) {
  const s = getStripe();

  // Look up the price ID for this tier
  const priceId = await getPriceIdForTier(tier);
  if (!priceId) throw new Error(`No Stripe price found for tier: ${tier}`);

  // Generate slug from agency name if not provided
  const agencySlug = slug || agencyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Check slug isn't taken
  if (SUPABASE_URL && SUPABASE_KEY) {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?slug=eq.${encodeURIComponent(agencySlug)}&select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await resp.json();
    if (rows?.length > 0) throw new Error(`Slug "${agencySlug}" is already taken`);
  }

  const baseUrl = process.env.APP_BASE_URL || "https://ai-visibility-scanner-production.up.railway.app";

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      agency_name: agencyName,
      agency_slug: agencySlug,
      tier,
    },
    subscription_data: {
      metadata: {
        agency_name: agencyName,
        agency_slug: agencySlug,
        tier,
      },
    },
    success_url: successUrl || `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${baseUrl}/billing/cancel`,
    allow_promotion_codes: true,
  });

  return { url: session.url, session_id: session.id, slug: agencySlug };
}

// ── Find price ID for a tier ──
async function getPriceIdForTier(tier) {
  const s = getStripe();

  // Try product search first
  let productId = null;
  try {
    const products = await s.products.search({ query: 'metadata["app"]:"ai-visibility-scanner"' });
    if (products.data.length) productId = products.data[0].id;
  } catch {
    // Search API may not be available in sandbox
  }

  // Fallback: list all products and find by metadata
  if (!productId) {
    const allProducts = await s.products.list({ active: true, limit: 20 });
    const match = allProducts.data.find((p) => p.metadata?.app === "ai-visibility-scanner");
    if (match) productId = match.id;
  }

  if (!productId) return null;

  const prices = await s.prices.list({ product: productId, active: true });
  const match = prices.data.find((p) => p.metadata.tier === tier);
  return match?.id || null;
}

// ── Webhook handler ──
async function handleWebhook(rawBody, signature) {
  const s = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");

  const event = s.webhooks.constructEvent(rawBody, signature, webhookSecret);

  console.log(`Stripe event: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(event.data.object);
      break;

    case "customer.subscription.updated":
      await onSubscriptionUpdated(event.data.object);
      break;

    case "customer.subscription.deleted":
      await onSubscriptionDeleted(event.data.object);
      break;

    case "invoice.paid":
      await onInvoicePaid(event.data.object);
      break;

    case "invoice.payment_failed":
      await onPaymentFailed(event.data.object);
      break;

    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return { received: true, type: event.type };
}

// ── Checkout completed → route by type ──
async function onCheckoutCompleted(session) {
  const { agency_name, agency_slug, tier, scan_type } = session.metadata;
  const email = session.customer_email || session.customer_details?.email;

  // Route: one-time scan purchase
  if (scan_type === "one_time") {
    await onScanPurchaseCompleted(session, email, tier);
    return;
  }

  // Route: agency subscription
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!agency_slug || !tier) {
    console.error("Checkout session missing metadata:", session.id);
    return;
  }

  // Get subscription details for period end
  const s = getStripe();
  let periodEnd = null;
  let priceId = null;
  try {
    const subscription = await s.subscriptions.retrieve(subscriptionId);
    if (subscription.current_period_end) {
      periodEnd = new Date(subscription.current_period_end * 1000).toISOString();
    }
    priceId = subscription.items.data[0]?.price?.id || null;
  } catch (e) {
    console.error("Subscription retrieve failed:", e.message);
  }

  const tierConfig = TIERS[tier];
  if (!tierConfig) {
    console.error("Unknown tier:", tier);
    return;
  }

  // Provision agency in Supabase
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Supabase not configured — cannot provision agency");
    return;
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/provision_agency`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        p_name: agency_name,
        p_slug: agency_slug,
        p_tier: tier,
        p_scans_limit: tierConfig.scans_limit,
        p_billing_email: email,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subscriptionId,
        p_stripe_price_id: priceId,
        p_current_period_end: periodEnd,
      }),
    });

    const result = await resp.json();
    if (!resp.ok) {
      console.error("Provision failed:", result);
      return;
    }

    const agency = Array.isArray(result) ? result[0] : result;
    console.log(`Agency provisioned: ${agency_slug} (${tier}) — API key: ${agency.api_key?.slice(0, 8)}...`);

    // Send onboarding email
    await sendOnboardingEmail({
      email,
      agencyName: agency_name,
      slug: agency_slug,
      apiKey: agency.api_key,
      tier,
      scansLimit: tierConfig.scans_limit,
    });

    // Slack notification
    await notifySlack(
      `New agency signup! *${agency_name}* (${tier} — $${tierConfig.price_monthly / 100}/mo)\n` +
      `Slug: ${agency_slug}\nEmail: ${email}`
    );
  } catch (e) {
    console.error("Agency provisioning error:", e.message);
  }
}

// ── One-time scan purchase → create account + unlock report ──
async function onScanPurchaseCompleted(session, email, tier) {
  if (!email) {
    console.error("Scan purchase missing email:", session.id);
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Supabase not configured — cannot process scan purchase");
    return;
  }

  const stripeSessionId = session.id;
  const amountPaid = session.amount_total;

  console.log(`Scan purchase: ${email} bought ${tier} tier ($${(amountPaid / 100).toFixed(2)})`);

  try {
    // 1. Update scan_payments record
    await fetch(
      `${SUPABASE_URL}/rest/v1/scan_payments?stripe_session_id=eq.${encodeURIComponent(stripeSessionId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
      }
    ).catch(() => {});

    // 2. Upgrade any pending/completed scans for this email to the paid tier
    const scansResp = await fetch(
      `${SUPABASE_URL}/rest/v1/scans?lead_email=eq.${encodeURIComponent(email)}&select=id,tier,status&order=created_at.desc&limit=5`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const scans = await scansResp.json();

    if (scans && scans.length > 0) {
      // Upgrade the most recent scan to the paid tier
      const latestScan = scans[0];
      await fetch(
        `${SUPABASE_URL}/rest/v1/scans?id=eq.${latestScan.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            tier,
            paid: true,
            amount_cents: amountPaid,
            stripe_session_id: stripeSessionId,
          }),
        }
      );
      console.log(`Scan ${latestScan.id} upgraded to ${tier}`);
    }

    // 3. Create Supabase Auth account (invite via magic link)
    const authResp = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/generate_link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          type: "magiclink",
          email,
          options: {
            data: { source: "scan_purchase", tier, stripe_session_id: stripeSessionId },
            redirectTo: "https://etherealmedia.ai/dashboard/",
          },
        }),
      }
    );

    if (authResp.ok) {
      const authData = await authResp.json();
      const magicLink = authData.properties?.action_link;

      // 4. Send report delivery email with magic link
      await sendScanReportEmail({ email, tier, magicLink, amountPaid });
      console.log(`Account created + magic link sent to ${email}`);
    } else {
      // User may already exist — still send report email without magic link
      console.log(`Auth link generation failed (user may exist): ${await authResp.text()}`);
      await sendScanReportEmail({ email, tier, magicLink: null, amountPaid });
    }

    // 5. Update lead status
    await fetch(
      `${SUPABASE_URL}/rest/v1/leads?email=eq.${encodeURIComponent(email)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ status: "customer", tier }),
      }
    ).catch(() => {});

    // 6. Slack notification
    await notifySlack(
      `Scan purchase! *${email}* bought ${tier} tier ($${(amountPaid / 100).toFixed(2)})`
    );
  } catch (e) {
    console.error("Scan purchase processing error:", e.message);
  }
}

// ── Send scan report delivery email ──
async function sendScanReportEmail({ email, tier, magicLink, amountPaid }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log("RESEND_API_KEY not set — skipping report email");
    return;
  }

  const tierNames = { forge: "Forge Report", diagnostic: "Full Diagnostic" };
  const tierName = tierNames[tier] || tier;
  const dashboardUrl = magicLink || "https://etherealmedia.ai/dashboard/";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #2494A3; margin: 0;">Ethereal Media</h1>
    <p style="color: #666; margin: 4px 0 0;">The Ethereal Forge</p>
  </div>

  <h2>Your ${tierName} is ready!</h2>
  <p>Thank you for your purchase ($${(amountPaid / 100).toFixed(2)}). Your full AI visibility report is now available in your dashboard.</p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="${dashboardUrl}" style="display: inline-block; background: #2494A3; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 100px; font-weight: 600; font-size: 16px;">View Your Report &rarr;</a>
  </div>

  <h3>What's included in your ${tierName}:</h3>
  <ul style="line-height: 1.8; color: #444;">
    ${tier === "diagnostic" ? `
    <li>Complete AI visibility grade + GEO score</li>
    <li>All P0/P1/P2 findings with action items</li>
    <li>WebMCP + agent protocol audit</li>
    <li>Marketing health analysis (6 dimensions)</li>
    <li>Competitive visibility comparison</li>
    <li>Revenue impact estimates</li>
    <li>Implementation roadmap</li>
    <li>Human strategist review + 30-min debrief</li>
    ` : `
    <li>Complete AI visibility grade + GEO score</li>
    <li>All P0/P1/P2 findings with action items</li>
    <li>Competitive visibility comparison</li>
    <li>Revenue impact estimates</li>
    <li>Prioritized implementation roadmap</li>
    `}
  </ul>

  <p style="margin-top: 24px;">Ready to get your site fixed? Reply to this email or <a href="https://etherealmedia.ai/#contact" style="color: #2494A3;">book a consultation</a> — we'll handle the implementation.</p>

  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 13px;">
    <p>Ethereal Media &mdash; The Ethereal Forge</p>
    <p><a href="mailto:info@etherealmedia.ai" style="color: #2494A3;">info@etherealmedia.ai</a></p>
  </div>
</body>
</html>`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Ethereal Media <info@etherealmedia.ai>",
        to: [email],
        subject: `Your ${tierName} is ready — view your AI visibility report`,
        html,
      }),
    });

    if (!resp.ok) {
      console.error("Report email failed:", await resp.text());
    } else {
      console.log(`Report email sent to ${email}`);
    }
  } catch (e) {
    console.error("Report email error:", e.message);
  }
}

// ── Subscription updated → handle tier changes ──
async function onSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const newPriceId = subscription.items.data[0]?.price?.id;
  const newTier = subscription.items.data[0]?.price?.metadata?.tier;
  const status = subscription.status;
  const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();
  const cancelAtEnd = subscription.cancel_at_period_end;

  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const updateData = {
    subscription_status: status === "active" ? "active" : status === "past_due" ? "past_due" : status,
    current_period_end: periodEnd,
    cancel_at_period_end: cancelAtEnd,
    stripe_price_id: newPriceId,
  };

  // If tier changed, update limits
  if (newTier && TIERS[newTier]) {
    updateData.tier = newTier;
    updateData.scans_limit = TIERS[newTier].scans_limit;
  }

  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(updateData),
      }
    );

    if (newTier) {
      console.log(`Agency ${customerId} updated to ${newTier}`);
    }
    if (cancelAtEnd) {
      console.log(`Agency ${customerId} set to cancel at period end`);
    }
  } catch (e) {
    console.error("Subscription update error:", e.message);
  }
}

// ── Subscription deleted → deactivate agency ──
async function onSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          active: false,
          subscription_status: "canceled",
        }),
      }
    );

    console.log(`Agency deactivated: ${customerId}`);
    await notifySlack(`Agency canceled: customer ${customerId}`);
  } catch (e) {
    console.error("Subscription deletion error:", e.message);
  }
}

// ── Invoice paid → reset monthly scan count ──
async function onInvoicePaid(invoice) {
  if (invoice.billing_reason !== "subscription_cycle") return;

  const customerId = invoice.customer;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    // Look up agency by stripe_customer_id
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await resp.json();
    if (!rows?.[0]) return;

    // Reset scan count for new billing period
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/reset_agency_scans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ agency_uuid: rows[0].id }),
    });

    console.log(`Scans reset for agency ${customerId}`);
  } catch (e) {
    console.error("Scan reset error:", e.message);
  }
}

// ── Payment failed → mark past_due ──
async function onPaymentFailed(invoice) {
  const customerId = invoice.customer;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ subscription_status: "past_due" }),
      }
    );

    await notifySlack(`Payment failed for customer ${customerId} — marked past_due`);
  } catch (e) {
    console.error("Payment failure update error:", e.message);
  }
}

// ── Customer portal session ──
async function createPortalSession(stripeCustomerId, returnUrl) {
  const s = getStripe();
  const baseUrl = process.env.APP_BASE_URL || "https://ai-visibility-scanner-production.up.railway.app";

  const session = await s.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl || baseUrl,
  });

  return { url: session.url };
}

// ── Onboarding email via Resend ──
async function sendOnboardingEmail({ email, agencyName, slug, apiKey, tier, scansLimit }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log("RESEND_API_KEY not set — skipping onboarding email");
    return;
  }

  const baseUrl = process.env.APP_BASE_URL || "https://ai-visibility-scanner-production.up.railway.app";
  const mcpEndpoint = `${baseUrl}/a/${slug}/mcp?key=${apiKey}`;
  const tierName = TIERS[tier]?.name || tier;
  const scansText = scansLimit >= 999999 ? "Unlimited" : String(scansLimit);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #6366f1; margin: 0;">AI Visibility Scanner</h1>
    <p style="color: #666; margin: 4px 0 0;">by Ethereal Media</p>
  </div>

  <h2>Welcome aboard, ${agencyName}!</h2>
  <p>Your <strong>${tierName}</strong> subscription is active. Here's everything you need to get started.</p>

  <div style="background: #f8f8fc; border: 1px solid #e2e2f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <h3 style="margin-top: 0; color: #6366f1;">Your MCP Endpoint</h3>
    <code style="display: block; background: #1a1a2e; color: #a5f3fc; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 13px;">${mcpEndpoint}</code>
    <p style="font-size: 13px; color: #666; margin-bottom: 0;">Add this URL as an MCP server in Claude Desktop, ChatGPT, or any MCP-compatible client.</p>
  </div>

  <div style="background: #f8f8fc; border: 1px solid #e2e2f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <h3 style="margin-top: 0; color: #6366f1;">Your API Key</h3>
    <code style="display: block; background: #1a1a2e; color: #fbbf24; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 13px;">${apiKey}</code>
    <p style="font-size: 13px; color: #666; margin-bottom: 0;">Keep this secret. Use it in the <code>?key=</code> parameter or <code>X-API-Key</code> header.</p>
  </div>

  <h3>Plan Details</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Plan</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${tierName}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Scans/month</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${scansText}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Slug</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${slug}</td></tr>
    <tr><td style="padding: 8px;"><strong>White-label</strong></td><td style="padding: 8px;">Included — customize via API</td></tr>
  </table>

  <h3>Quick Start</h3>
  <ol style="line-height: 1.8;">
    <li>Add the MCP endpoint URL to your AI client (Claude, ChatGPT, etc.)</li>
    <li>Ask: <em>"Scan example.com for AI visibility"</em></li>
    <li>Review the interactive dashboard with scores and recommendations</li>
    <li>Customize your branding (name, logo, colors) via the API</li>
  </ol>

  <h3>Customize Your Branding</h3>
  <p>Update your white-label settings with a PATCH request:</p>
  <code style="display: block; background: #1a1a2e; color: #a5f3fc; padding: 12px; border-radius: 4px; font-size: 12px; white-space: pre; overflow-x: auto;">curl -X PATCH "${baseUrl}/api/agencies/${slug}/branding" \\
  -H "X-API-Key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"brand_name": "Your Brand", "accent_color": "#ff6600"}'</code>

  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 13px;">
    <p>Need help? Reply to this email or reach us at <a href="mailto:support@etherealmedia.ai" style="color: #6366f1;">support@etherealmedia.ai</a></p>
    <p>Ethereal Media &mdash; The Ethereal Forge</p>
  </div>
</body>
</html>`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "AI Visibility Scanner <scanner@etherealmedia.ai>",
        to: [email],
        subject: `Welcome to AI Visibility Scanner — Your ${tierName} plan is active`,
        html,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("Resend email failed:", err);
    } else {
      console.log(`Onboarding email sent to ${email}`);
    }
  } catch (e) {
    console.error("Onboarding email error:", e.message);
  }
}

// ── Slack notification helper ──
async function notifySlack(text) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[Billing] ${text}` }),
    });
  } catch (e) {
    console.error("Slack billing notification failed:", e.message);
  }
}

// ── Look up agency by API key (for portal access) ──
async function getAgencyByApiKey(apiKey) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !apiKey) return null;

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/agencies?api_key=eq.${encodeURIComponent(apiKey)}&active=eq.true&select=id,slug,name,stripe_customer_id,tier,billing_email,scans_used,scans_limit,subscription_status&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await resp.json();
    return rows?.[0] || null;
  } catch (e) {
    console.error("Agency lookup by API key failed:", e.message);
    return null;
  }
}

module.exports = {
  TIERS,
  setupStripeProducts,
  createCheckoutSession,
  handleWebhook,
  createPortalSession,
  sendOnboardingEmail,
  getAgencyByApiKey,
};
