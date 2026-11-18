// WhatsApp Business API through Kapso — runs on the website's server so the API key never reaches a phone or browser.
//   POST /api/kapso/setup    connect a number: stores the (encrypted) key, registers the webhook, creates the templates
//   GET  /api/kapso/status   connection + template review status
//   POST /api/kapso/send     send the confirmation template / a shipment update / a free-form text
//   GET  /api/kapso/inbox    replies, inbound messages and delivery states since a timestamp
//   POST /api/kapso/webhook  Kapso -> us (HMAC verified): button replies confirm / cancel the Shopify order by themselves
const crypto = require('crypto');
const { authed } = require('../lib/auth');
const kv = require('../lib/kv');
const vault = require('../lib/vault');
const shop = require('../lib/shopsrv');

const KAPSO = () => (process.env.KAPSO_BASE || 'https://api.kapso.ai').replace(/\/+$/, '');
const META = 'v24.0';
const H_CFG = 'shohnaty_kapso', EVENTS = 'shohnaty_kapso_events', REFS = 'shohnaty_kapso_refs', MSGS = 'shohnaty_kapso_msgs';

// ---------- Templates (Arabic, UTILITY) ----------
const TEMPLATES = [
  {
    name: 'order_confirm_ar', category: 'UTILITY', language: 'ar', parameter_format: 'NAMED',
    components: [
      { type: 'BODY', text: 'أهلاً {{customer_name}} 👋\nشكراً لطلبك من {{store_name}}.\n\n🧾 رقم الطلب: {{order_number}}\n🛍️ المنتجات: {{products}}\n💰 الإجمالي شامل الشحن: {{total}} ج.م\n📍 العنوان: {{address}}\n\nبرجاء تأكيد الطلب لنبدأ التجهيز والشحن.\n\n📏 ولتأكيد المقاس: أرسل الوزن والطول، أو نص محيط الصدر بالسنتيمتر، مع اسمك كاملاً.',
        example: { body_text_named_params: [
          { param_name: 'customer_name', example: 'سارة' }, { param_name: 'store_name', example: 'علياء فاشون' }, { param_name: 'order_number', example: '1209' },
          { param_name: 'products', example: 'فستان كتان مقاس L' }, { param_name: 'total', example: '1495' }, { param_name: 'address', example: 'المعادي، القاهرة' }] } },
      { type: 'FOOTER', text: 'نشكرك على ثقتك بنا 🤍' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'تأكيد الطلب' }, { type: 'QUICK_REPLY', text: 'إلغاء الطلب' }] },
    ],
  },
  {
    name: 'order_update_ar', category: 'UTILITY', language: 'ar', parameter_format: 'NAMED',
    components: [
      { type: 'BODY', text: 'تم تحديث حالة طلبك رقم {{order_number}}.\n\n📦 الحالة: {{status}}\n🔎 رقم الشحنة: {{waybill}}\n\nلأي استفسار رد على هذه الرسالة. شكراً لثقتك 🤍',
        example: { body_text_named_params: [{ param_name: 'order_number', example: '1209' }, { param_name: 'status', example: 'خرج للتسليم' }, { param_name: 'waybill', example: 'HZM9827489' }] } },
    ],
  },
];

// ---------- helpers ----------
const rawBody = req => new Promise((ok, no) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
const json = (res, code, obj) => { res.setHeader('Cache-Control', 'no-store'); res.status(code).json(obj); };
const clean = (s, max = 300) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max) || '-';
const phoneIntl = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (/^0?1[0125]\d{8}$/.test(d)) d = '20' + d.replace(/^0/, ''); return /^\d{10,15}$/.test(d) ? d : ''; };

async function getCfg() { const [raw] = await kv.redis([['HGET', H_CFG, 'cfg']]); return raw ? vault.open(raw) : null; }
async function kapso(cfg, path, opts = {}) {
  const r = await fetch(KAPSO() + path, { method: opts.method || 'GET', headers: { 'X-API-Key': cfg.apiKey, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, data: j, text };
}
const sendMsg = (cfg, body) => kapso(cfg, `/meta/whatsapp/${META}/${cfg.phoneNumberId}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...body } });
const refMerge = async (ref, patch) => { if (!ref) return; const [raw] = await kv.redis([['HGET', REFS, ref]]); let o = {}; try { o = JSON.parse(raw || '{}'); } catch {} await kv.redis([['HSET', REFS, ref, JSON.stringify({ ...o, ...patch })]]); };
const pushEvent = async ev => { await kv.redis([['LPUSH', EVENTS, JSON.stringify({ t: Date.now(), ...ev })], ['LTRIM', EVENTS, 0, 499]]); };
const errText = r => (r.data && (r.data.error?.message || r.data.error || r.data.message)) ? String(r.data.error?.message || r.data.error || r.data.message) : `HTTP ${r.status}`;

// ---------- webhook ----------
async function replyAck(cfg, phone, text) { try { await sendMsg(cfg, { to: phone, type: 'text', text: { body: text, preview_url: false } }); } catch {} }

async function onReply(cfg, rep) {
  const prefs = (await kv.storeGet('kapso_prefs', {})) || {};
  const { action, kind, id } = rep; // action CONFIRM|CANCEL, kind S (Shopify order) | D (chat draft)
  const out = { applied: false, note: '' };
  try {
    if (kind === 'S') {
      if (action === 'CONFIRM') { if (prefs.autoConfirm !== false) { const r = await shop.confirmOrder(id); out.applied = !!r.ok; out.note = r.why || (r.already ? 'already' : ''); } }
      else { const r = await shop.cancelRequest(id, prefs.autoCancel === true); out.applied = !!r.ok; out.cancelled = !!r.cancelled; out.note = r.why || ''; }
    } else if (kind === 'D') {
      const drafts = (await kv.storeGet('wa_drafts', [])) || [];
      const d = drafts.find(x => String(x.id) === String(id));
      if (d) {
        if (action === 'CONFIRM') { d.stage = 'ready'; d.confirmedBy = 'whatsapp'; } else { d.cancelRequested = true; }
        await kv.storeSet('wa_drafts', drafts); out.applied = true;
        if (d.shop && d.shop.name && action === 'CANCEL') await shop.cancelRequest(d.shop.name, prefs.autoCancel === true).catch(() => {});
      } else out.note = 'draft-not-found';
    }
  } catch (e) { out.note = String(e.message || e).slice(0, 120); }
  return out;
}

async function handleEvent(cfg, event, p) {
  const m = p.message || {}, conv = p.conversation || {};
  const mid = m.id;
  if (event === 'whatsapp.message.received') {
    if (mid) { const [seen] = await kv.redis([['SET', 'shohnaty_kapso_seen:' + mid, '1', 'NX', 'EX', 604800]]); if (!seen) return; }
    const phone = conv.phone_number || m.from || '', name = conv.contact_name || '';
    const payload = (m.button && m.button.payload) || (m.interactive && ((m.interactive.button_reply || {}).id || (m.interactive.list_reply || {}).id)) || '';
    const text = (m.kapso && m.kapso.content) || (m.text && m.text.body) || (m.button && m.button.text) || '';
    const pm = /^(CONFIRM|CANCEL):(S|D):(.+)$/.exec(payload);
    if (pm) {
      const rep = { action: pm[1], kind: pm[2], id: pm[3] }, ref = pm[2] + ':' + pm[3];
      const res = await onReply(cfg, rep);
      await refMerge(ref, { action: rep.action, replyAt: Date.now(), applied: res.applied, cancelled: !!res.cancelled, note: res.note });
      await pushEvent({ kind: 'reply', action: rep.action, ref, phone, name, applied: res.applied, note: res.note });
      if (phone) await replyAck(cfg, phone, rep.action === 'CONFIRM'
        ? 'تم تأكيد طلبك ✅\nشكراً لك! هنجهّزه ونشحنه في أقرب وقت، وهنبعتلك تفاصيل الشحنة أول ما تتحرك 🚚'
        : 'وصلنا طلبك بإلغاء الأوردر ❌\nهنراجعه ونتواصل معاك لو احتجنا أي تفاصيل. شكراً لوقتك 🤍');
    } else {
      const [lastRef] = await kv.redis([['GET', 'shohnaty_kapso_last:' + phone]]).catch(() => [null]);
      if (lastRef) await refMerge(lastRef, { textReply: String(text).slice(0, 300), textReplyAt: Date.now() });
      await pushEvent({ kind: 'message', phone, name, text: String(text).slice(0, 1000), type: m.type || 'text', mid, ref: lastRef || '' });
    }
  } else if (/^whatsapp\.message\.(sent|delivered|read|failed)$/.test(event)) {
    const st = event.split('.').pop();
    const [raw] = mid ? await kv.redis([['HGET', MSGS, mid]]) : [null];
    let rec = null; try { rec = raw ? JSON.parse(raw) : null; } catch {}
    if (rec && rec.ref) {
      const patch = { status: st, statusAt: Date.now() };
      if (st === 'failed') patch.error = String((m.kapso && (m.kapso.status_reason || m.kapso.error)) || (m.errors && m.errors[0] && m.errors[0].message) || 'failed').slice(0, 160);
      await refMerge(rec.ref, patch);
      if (st === 'failed') await pushEvent({ kind: 'failed', ref: rec.ref, phone: conv.phone_number || '', error: patch.error });
    }
  }
}

async function webhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const buf = await rawBody(req);
  const cfg = await getCfg();
  if (!cfg || !cfg.webhookSecret) return res.status(404).send('not configured');
  const sig = String(req.headers['x-webhook-signature'] || '');
  const exp = crypto.createHmac('sha256', cfg.webhookSecret).update(buf).digest('hex');
  const a = Buffer.from(exp), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('bad signature');
  let body; try { body = JSON.parse(buf.toString('utf8')); } catch { return res.status(400).send('bad json'); }
  const event = String(req.headers['x-webhook-event'] || body.event || '');
  const list = (body.batch === true && Array.isArray(body.data)) ? body.data : [body];
  for (const p of list) { try { await handleEvent(cfg, event, p); } catch {} }
  res.status(200).send('OK');
}

// ---------- operations for the app ----------
async function setup(req, res, body) {
  const apiKey = String(body.apiKey || '').trim(), phoneNumberId = String(body.phoneNumberId || '').trim();
  if (!apiKey || !/^\d{6,20}$/.test(phoneNumberId)) return json(res, 400, { ok: false, error: 'اكتب الـ API Key و Phone Number ID (أرقام)' });
  const cfg = { apiKey, phoneNumberId };
  const info = await kapso(cfg, `/platform/v1/whatsapp/phone_numbers/${phoneNumberId}`);
  if (!info.ok) return json(res, 400, { ok: false, error: info.status === 401 || info.status === 403 ? 'الـ API Key غلط' : info.status === 404 ? 'Phone Number ID مش موجود في حسابك' : 'كابسو رفض الطلب: ' + errText(info) });
  const d = info.data && (info.data.data || info.data);
  cfg.wabaId = String((d && d.business_account_id) || '');
  cfg.displayName = (d && (d.verified_name || d.display_phone_number || d.name)) || '';
  cfg.webhookSecret = crypto.randomBytes(24).toString('hex');
  const origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
  const url = origin + '/api/kapso/webhook';
  const steps = { number: true, webhook: false, templates: [] };

  // webhook: replace any previous one that points at this site
  const wl = await kapso(cfg, `/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`);
  const rows = wl.ok ? (Array.isArray(wl.data) ? wl.data : (wl.data && (wl.data.data || wl.data.webhooks)) || []) : [];
  for (const w of rows) { if (w && w.url === url && w.id) await kapso(cfg, `/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks/${w.id}`, { method: 'DELETE' }); }
  const wc = await kapso(cfg, `/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks`, { method: 'POST', body: { whatsapp_webhook: {
    kind: 'kapso', url, secret_key: cfg.webhookSecret, active: true,
    events: ['whatsapp.message.received', 'whatsapp.message.sent', 'whatsapp.message.delivered', 'whatsapp.message.read', 'whatsapp.message.failed'] } } });
  steps.webhook = wc.ok; if (!wc.ok) steps.webhookError = errText(wc);

  // templates: create the missing ones
  if (cfg.wabaId) {
    for (const t of TEMPLATES) {
      const ex = await kapso(cfg, `/meta/whatsapp/${META}/${cfg.wabaId}/message_templates?name=${t.name}`);
      const found = ex.ok && ((ex.data && ex.data.data) || []).find(x => x.name === t.name);
      if (found) { steps.templates.push({ name: t.name, status: found.status || 'UNKNOWN' }); continue; }
      const cr = await kapso(cfg, `/meta/whatsapp/${META}/${cfg.wabaId}/message_templates`, { method: 'POST', body: t });
      steps.templates.push({ name: t.name, status: cr.ok ? ((cr.data && cr.data.status) || 'PENDING') : 'ERROR', error: cr.ok ? undefined : errText(cr) });
    }
  } else steps.templatesError = 'مش قادر أعرف WhatsApp Business Account ID';
  await kv.redis([['HSET', H_CFG, 'cfg', vault.seal(cfg)]]);
  json(res, 200, { ok: true, name: cfg.displayName, waba: cfg.wabaId, webhookUrl: url, ...steps });
}

async function status(req, res) {
  const cfg = await getCfg();
  if (!cfg) return json(res, 200, { connected: false });
  const out = { connected: true, phoneNumberId: cfg.phoneNumberId, name: cfg.displayName || '', waba: cfg.wabaId || '', templates: [] };
  if (cfg.wabaId) {
    for (const t of TEMPLATES) {
      const ex = await kapso(cfg, `/meta/whatsapp/${META}/${cfg.wabaId}/message_templates?name=${t.name}`);
      const f = ex.ok && ((ex.data && ex.data.data) || []).find(x => x.name === t.name);
      out.templates.push({ name: t.name, status: f ? (f.status || 'UNKNOWN') : (ex.ok ? 'MISSING' : 'ERROR'), reason: f && f.rejected_reason && f.rejected_reason !== 'NONE' ? f.rejected_reason : undefined });
    }
  }
  json(res, 200, out);
}

async function send(req, res, body) {
  const cfg = await getCfg(); if (!cfg) return json(res, 400, { ok: false, error: 'كابسو مش مربوط' });
  const to = phoneIntl(body.to); if (!to) return json(res, 400, { ok: false, error: 'رقم الموبايل مش صحيح' });
  const v = body.vars || {}, ref = String(body.ref || '').slice(0, 80), kind = body.kind;
  let msg;
  if (kind === 'confirm') {
    const m = /^(S|D):(.+)$/.exec(ref); if (!m) return json(res, 400, { ok: false, error: 'ref غلط' });
    const P = (k, max) => ({ type: 'text', parameter_name: k, text: clean(v[k], max) });
    msg = { to, type: 'template', template: { name: 'order_confirm_ar', language: { code: 'ar' }, components: [
      { type: 'body', parameters: [P('customer_name', 60), P('store_name', 60), P('order_number', 30), P('products', 300), P('total', 20), P('address', 200)] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'CONFIRM:' + ref }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'CANCEL:' + ref }] }] } };
  } else if (kind === 'update') {
    const P = (k, max) => ({ type: 'text', parameter_name: k, text: clean(v[k], max) });
    msg = { to, type: 'template', template: { name: 'order_update_ar', language: { code: 'ar' }, components: [{ type: 'body', parameters: [P('order_number', 30), P('status', 80), P('waybill', 40)] }] } };
  } else if (kind === 'text') {
    msg = { to, type: 'text', text: { body: String(body.text || '').slice(0, 1500), preview_url: false } };
  } else return json(res, 400, { ok: false, error: 'نوع الرسالة غلط' });
  const r = await sendMsg(cfg, msg);
  if (!r.ok) return json(res, 502, { ok: false, error: errText(r) });
  const mid = r.data && ((r.data.messages && r.data.messages[0] && r.data.messages[0].id) || r.data.id);
  if (ref && kind === 'confirm') await kv.redis([['SET', 'shohnaty_kapso_last:' + to, ref, 'EX', 259200]]).catch(() => {});
  if (ref && kind === 'confirm') await refMerge(ref, { sent: Date.now(), mid, status: 'sent', kind, action: undefined, replyAt: undefined });
  if (ref && kind !== 'confirm') await refMerge(ref, { lastUpdateSent: Date.now(), lastUpdateKind: kind });
  if (mid && ref) await kv.redis([['HSET', MSGS, mid, JSON.stringify({ ref, kind })]]);
  json(res, 200, { ok: true, mid });
}

async function inbox(req, res, url) {
  const since = Number(url.searchParams.get('since') || 0);
  const [evs, refs] = await kv.redis([['LRANGE', EVENTS, 0, 199], ['HGETALL', REFS]]);
  const events = (evs || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(e => e && e.t > since);
  const map = {}; for (let i = 0; i < (refs || []).length; i += 2) { try { map[refs[i]] = JSON.parse(refs[i + 1]); } catch {} }
  json(res, 200, { now: Date.now(), events, refs: map });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const op = url.searchParams.get('op') || '';
  try {
    if (!kv.ready()) return json(res, 503, { error: 'no-database' });
    if (op === 'webhook') return await webhook(req, res);
    if (!authed(req)) return json(res, 401, { error: 'locked' });
    let body = {};
    if (req.method === 'POST') { try { body = JSON.parse((await rawBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'bad json' }); } }
    if (op === 'setup' && req.method === 'POST') return await setup(req, res, body);
    if (op === 'status') return await status(req, res);
    if (op === 'send' && req.method === 'POST') return await send(req, res, body);
    if (op === 'inbox') return await inbox(req, res, url);
    return json(res, 404, { error: 'unknown op' });
  } catch (e) { return json(res, 500, { error: String(e.message || e).slice(0, 160) }); }
};
module.exports.config = { api: { bodyParser: false } };
module.exports.TEMPLATES = TEMPLATES;
