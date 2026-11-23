// POST /api/shopfix  { items: [{ order: "1346", amount: 1595, title?: "..." }] } -> sets those Shopify orders' value (see lib/shopsrv.setOrderTotal)
const { authed } = require('../lib/auth');
const shop = require('../lib/shopsrv');
module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'locked' });
  if (req.method !== 'POST') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 60) : [];
  const out = [];
  for (const it of items) {
    const amount = Number(it.amount);
    if (!it.order || !isFinite(amount) || amount <= 0) { out.push({ order: it.order, ok: false, why: 'bad-input' }); continue; }
    try { out.push({ order: it.order, ...(await shop.setOrderTotal(it.order, amount, it.title)) }); } catch (e) { out.push({ order: it.order, ok: false, why: String(e.message || e) }); }
  }
  res.status(200).json({ results: out });
};
