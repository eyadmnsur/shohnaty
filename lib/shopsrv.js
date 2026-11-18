// Server-side Shopify actions used when a customer taps a button in WhatsApp (works with every app closed).
const kv = require('./kv');
const API = '2026-07';

async function ctx() {
  const cfg = await kv.storeGet('shopify_cfg');
  if (!cfg || !cfg.shop) return null;
  let host = String(cfg.shop).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host.includes('.')) host += '.myshopify.com';
  let token = cfg.token;
  if (cfg.mode === 'client' || !token) {
    const r = await fetch(`${process.env.SHOPIFY_TEST_BASE || 'https://' + host}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(cfg.clientId || '').trim(), client_secret: String(cfg.clientSecret || '').trim() }).toString() });
    token = (await r.json().catch(() => ({}))).access_token;
  }
  return token ? { host, token } : null;
}
async function gql(c, query, variables) {
  const r = await fetch(`${process.env.SHOPIFY_TEST_BASE || 'https://' + c.host}/admin/api/${API}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': c.token }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
  return j.data;
}
async function findOrder(c, no) {
  const d = await gql(c, `query($q:String!){ orders(first:3, query:$q){ nodes { id name tags displayFulfillmentStatus fulfillmentOrders(first:10){ nodes { id status } } } } }`, { q: `name:${String(no).replace(/\D/g, '')}` });
  return d.orders.nodes.find(o => o.name.replace(/\D/g, '') === String(no).replace(/\D/g, '')) || null;
}
async function tag(c, id, tags) { await gql(c, `mutation($id:ID!,$t:[String!]!){ tagsAdd(id:$id, tags:$t){ userErrors { message } } }`, { id, t: tags }); }

// Customer confirmed -> mark Fulfilled (that is what "ready to ship" means in the app).
exports.confirmOrder = async no => {
  const c = await ctx(); if (!c) return { ok: false, why: 'shopify-not-set' };
  const o = await findOrder(c, no); if (!o) return { ok: false, why: 'order-not-found' };
  await tag(c, o.id, ['wa-confirmed']);
  const open = o.fulfillmentOrders.nodes.filter(f => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
  if (!open.length) return { ok: true, already: true };
  const m = await gql(c, `mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ userErrors { message } } }`, { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: open.map(f => ({ fulfillmentOrderId: f.id })) } });
  const e = m.fulfillmentCreate.userErrors[0]; if (e) return { ok: false, why: e.message };
  return { ok: true };
};
// Customer asked to cancel -> tag it (and cancel only when the merchant enabled auto-cancel).
exports.cancelRequest = async (no, doCancel) => {
  const c = await ctx(); if (!c) return { ok: false, why: 'shopify-not-set' };
  const o = await findOrder(c, no); if (!o) return { ok: false, why: 'order-not-found' };
  await tag(c, o.id, ['wa-cancel-request']);
  if (doCancel) {
    const m = await gql(c, `mutation($id:ID!){ orderCancel(orderId:$id, reason:CUSTOMER, refund:false, restock:true, notifyCustomer:false){ orderCancelUserErrors { message } } }`, { id: o.id });
    const e = (m.orderCancel.orderCancelUserErrors || [])[0]; if (e) return { ok: false, why: e.message };
    return { ok: true, cancelled: true };
  }
  return { ok: true, cancelled: false };
};
