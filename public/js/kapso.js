// WhatsApp Business API (Kapso) — the app side. The API key lives only on the website's server;
// the app asks the server to send, and polls it for customers' replies and messages.
const Kapso = {
  on: false, name: '', templates: [], refs: {}, msgs: [], since: 0, ready: false,

  async conf() {
    if (window.SYNC_BASE) return { base: window.SYNC_BASE, headers: {} };
    const c = await Sync.config?.();
    return c && c.url && c.password ? { base: c.url.replace(/\/+$/, ''), headers: { Authorization: 'Bearer ' + c.password } } : null;
  },
  async call(path, method = 'GET', body) {
    const c = await this.conf(); if (!c) throw new Error('فعّل المزامنة مع الموقع الأول (المزيد ← المزامنة)');
    const r = await fetch(c.base + '/api/kapso/' + path, { method, cache: 'no-store', credentials: 'include', headers: { ...c.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return j;
  },
  async prefs() { return { autoConfirm: true, autoCancel: false, notifyShipped: false, notifyDelivered: false, ...(await Store.get('kapso_prefs', {})) }; },

  // ---- connection state ----
  async refresh() {
    try { const s = await this.call('status'); this.on = !!s.connected; this.name = s.name || ''; this.templates = s.templates || []; }
    catch { this.on = false; }
    this.ready = true; return this.on;
  },
  confirmReady() { return this.templates.some(t => t.name === 'order_confirm_ar' && t.status === 'APPROVED'); },

  // ---- sending ----
  async storeName() { return (await WA.cfg()).store || state.shopName || (await shopName().catch(() => '')) || 'متجرنا'; },
  async send(body) { return this.call('send', 'POST', body); },
  async confirmOrder(o) {
    const s = orderToShipment(o, state.sectors || []);
    return this.send({ kind: 'confirm', to: s.phone_1, ref: 'S:' + String(o.name).replace(/\D/g, ''), vars: { customer_name: firstName(s.client_name) || s.client_name, store_name: await this.storeName(), order_number: String(o.name).replace('#', ''), products: s.product_name, total: s.price, address: s.address } });
  },
  async confirmDraft(d) {
    return this.send({ kind: 'confirm', to: d.s.phone_1, ref: 'D:' + d.id, vars: { customer_name: firstName(d.s.client_name) || d.s.client_name, store_name: await this.storeName(), order_number: d.shop ? d.shop.name.replace('#', '') : (d.s.order_id || '—'), products: d.s.product_name, total: d.s.price, address: d.s.address } });
  },
  // Shipment status message to the customer. Automatic ones are sent once per shipment + status.
  async notify(ship, text, auto = true) {
    if (!this.on || !ship?.phone1) return false;
    const key = `${ship.waybill}|${text}`;
    const done = await Store.get('kapso_notified', {});
    if (auto && done[key]) return false;
    await this.send({ kind: 'update', to: ship.phone1, ref: 'U:' + ship.waybill, vars: { order_number: ship.order_id || ship.waybill, status: text, waybill: ship.waybill } });
    done[key] = Date.now();
    const keep = Object.entries(done).sort((a, b) => b[1] - a[1]).slice(0, 400); await Store.set('kapso_notified', Object.fromEntries(keep));
    return true;
  },
  // Many confirmations, one after another with a short pause.
  bulkConfirm(list, kind = 'order', after = () => {}) {
    if (!list.length) return;
    if (!confirm(`هتتبعت ${list.length} رسالة تأكيد من رقم واتساب Business عبر كابسو. كل رسالة قالب بزرارين (تأكيد / إلغاء) وبتتحاسب من ميتا.\nنكمّل؟`)) return;
    const sh = sheet('إرسال التأكيدات', `<div class="card card-pad"><div class="progress"><span id="kpPg" style="width:0"></span></div><div class="log" id="kpLog" style="margin-top:10px"></div></div>`, [['تم', () => { sh.close(); after(); }]]);
    const log = t => $('#kpLog', sh.el)?.insertAdjacentHTML('beforeend', `<div>${t}</div>`);
    (async () => {
      let ok = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i], nm = kind === 'draft' ? it.s.client_name : (it.shippingAddress?.name || it.name);
        try { await (kind === 'draft' ? this.confirmDraft(it) : this.confirmOrder(it)); await markWa(kind === 'draft' ? 'WA:' + it.id : it.name, 'confirm'); log(`✅ ${esc(nm)}`); ok++; }
        catch (e) { log(`❌ ${esc(nm)}: ${esc(e.message)}`); }
        const pg = $('#kpPg', sh.el); if (pg) pg.style.width = ((i + 1) / list.length * 100) + '%';
        if (i < list.length - 1) await new Promise(r => setTimeout(r, 1200));
      }
      const h = $('.sheet-h h3', sh.el); if (h) h.textContent = `اتبعت ${ok} من ${list.length}`;
    })();
  },

  // ---- replies / messages ----
  badge(ref) {
    const r = this.refs[ref]; if (!r) return '';
    if (r.action === 'CONFIRM') return `<span class="badge success">✅ العميل أكّد من واتساب${r.applied ? ' · اتعلّم تلقائي' : ''}</span>`;
    if (r.action === 'CANCEL') return `<span class="badge critical">❌ العميل طلب الإلغاء${r.cancelled ? ' · اتلغى' : ''}</span>`;
    if (r.status === 'failed') return `<span class="badge critical" title="${esc(r.error || '')}">⚠️ الرسالة ماوصلتش</span>`;
    if (r.status === 'read') return '<span class="badge info">👀 اتقرت — مستني ردّه</span>';
    if (r.status === 'delivered') return '<span class="badge info">✓✓ وصلت — مستني ردّه</span>';
    if (r.sent) return '<span class="badge info">📨 اتبعتت</span>';
    return '';
  },
  async poll() {
    if (!this.on || document.hidden) return;
    try {
      const d = await this.call('inbox?since=' + this.since);
      const first = !this.since; this.refs = d.refs || {};
      const fresh = (d.events || []).sort((a, b) => a.t - b.t);
      let changed = false;
      for (const e of fresh) {
        if (e.kind === 'message') { this.msgs = [e, ...this.msgs.filter(x => x.mid !== e.mid)].slice(0, 100); }
        if (first) continue; // don't alert about old history the first time
        changed = true;
        if (e.kind === 'reply') localAlert({ type: 'wa_reply', title: e.action === 'CONFIRM' ? `✅ ${e.name || e.phone} أكّد الأوردر` : `❌ ${e.name || e.phone} طلب إلغاء الأوردر`, body: (e.action === 'CONFIRM' ? (e.applied ? 'اتعلّم Fulfilled تلقائي على شوبيفاي ✓' : 'راجع الأوردر') : 'علّمناه «طلب إلغاء» — راجعه واتخذ القرار') + (e.note ? '\n' + e.note : ''), ref: e.ref });
        else if (e.kind === 'message') localAlert({ type: 'wa_reply', title: `💬 رسالة من ${e.name || e.phone}`, body: e.text, ref: 'M:' + e.phone });
        else if (e.kind === 'failed') localAlert({ type: 'wa_reply', title: '⚠️ رسالة واتساب ماوصلتش', body: (e.error || '') + ' · ' + e.phone, ref: e.ref });
      }
      this.since = d.now; await Store.set('kapso_since', this.since); await Store.set('kapso_msgs', this.msgs);
      if (changed && !sheetStack.length && !state.selMode && $('#view') && state.tab === 'shop') refreshTab().catch(() => {});
      updateBell?.();
    } catch (e) { if (e.status === 401 || e.status === 503) this.on = false; }
  },
  async init() {
    this.since = (await Store.get('kapso_since', 0)) || 0; this.msgs = (await Store.get('kapso_msgs', [])) || [];
    await this.refresh();
    if (this.on) { await this.poll(); }
  },
};

// Appends an item to the alert center (the bell). Local to this device.
async function localAlert(a) {
  const log = (await Store.get('alerts_log', [])) || [];
  log.unshift({ t: Date.now(), type: a.type, title: a.title, body: a.body || '', waybill: a.waybill || '', ref: a.ref || '' });
  await Store.set('alerts_log', log.slice(0, 200));
}

// ---------- settings sheet ----------
async function openKapsoSettings() {
  const sh = sheet('واتساب API (كابسو)', loading(), []);
  const body = $('.sheet-b', sh.el);
  const st = { PENDING: ['⏳ مستني مراجعة ميتا', 'attention'], APPROVED: ['✅ معتمد وجاهز', 'success'], REJECTED: ['❌ ميتا رفضه', 'critical'], MISSING: ['مش موجود', 'warning'], ERROR: ['تعذر الفحص', 'warning'], DISABLED: ['⛔ موقوف', 'critical'], UNKNOWN: ['؟', ''] };
  let showForm = false;
  const paint = async () => {
    await Kapso.refresh();
    if (!Kapso.on || showForm) {
      body.innerHTML = `
        <div class="banner info small" style="display:block">ربط رقم واتساب Business (من كابسو) بالتطبيق: التأكيدات بتتبعت أوتوماتيك بزرارين <b>تأكيد الطلب / إلغاء الطلب</b>، وردّ العميل بيتنفّذ لوحده. الـ API Key بيتخزّن <b>مشفّر على سيرفر موقعك</b> بس، مش على الموبايل.</div>
        <div class="card card-pad">
          <div class="field"><label>Kapso API Key</label><input id="kpKey" class="ltr" type="password" autocomplete="off" placeholder="من Kapso ← Integrations ← API keys"></div>
          <div class="field"><label>Phone Number ID</label><input id="kpPid" class="ltr" inputmode="numeric" placeholder="من Kapso ← WhatsApp ← Phone numbers"></div>
          <button class="btn primary block" id="kpGo">ربط وتفعيل</button><div id="kpRes" class="small" style="margin-top:10px"></div>
        </div>`;
      $('#kpGo', sh.el).onclick = async () => {
        const btn = $('#kpGo', sh.el); btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';
        try {
          const r = await Kapso.call('setup', 'POST', { apiKey: $('#kpKey', sh.el).value.trim(), phoneNumberId: $('#kpPid', sh.el).value.trim() });
          toast(`اتربط ✅${r.name ? ' — ' + r.name : ''}`, 'ok'); showForm = false; await paint();
        } catch (e) { btn.disabled = false; btn.textContent = 'ربط وتفعيل'; $('#kpRes', sh.el).innerHTML = `<span style="color:var(--critical)">${esc(e.message)}</span>`; }
      };
      return;
    }
    const p = await Kapso.prefs();
    const sw = (k, t, d) => `<label class="item" style="align-items:center"><span class="grow"><b>${t}</b><div class="tiny">${d}</div></span><input type="checkbox" class="switch" data-kp="${k}" ${p[k] ? 'checked' : ''}></label>`;
    body.innerHTML = `
      <div class="banner success small" style="display:block">✅ متصل${Kapso.name ? ' — <b>' + esc(Kapso.name) + '</b>' : ''}. ردود العملاء بتوصل تلقائي.</div>
      <div class="section-title">القوالب</div>
      <div class="list">${Kapso.templates.map(t => { const [l, c] = st[t.status] || st.UNKNOWN; return `<div class="item"><div class="grow"><b class="ltr">${esc(t.name)}</b>${t.reason ? `<div class="tiny">${esc(t.reason)}</div>` : ''}</div><span class="badge ${c}">${l}</span></div>`; }).join('')}</div>
      <div class="tiny" style="margin:6px 4px">ميتا بتراجع القالب (غالبًا خلال ساعات، وأحيانًا لحد 24 ساعة). لحد ما يتعتمد، التأكيد بيفضل بالطريقة العادية.</div>
      <button class="btn block" id="kpRef">🔄 تحديث حالة القوالب</button>
      <div class="section-title">لما العميل يرد</div>
      <div class="list menu">${sw('autoConfirm', 'تأكيد الأوردر تلقائي', 'لما يدوس «تأكيد الطلب» الأوردر يتعمل Fulfilled على شوبيفاي لوحده')}${sw('autoCancel', 'إلغاء الأوردر تلقائي', 'لما يدوس «إلغاء الطلب». لو مقفول بنعلّم الأوردر «طلب إلغاء» وإنت تقرر')}</div>
      <div class="section-title">رسائل حالة الشحنة للعميل</div>
      <div class="list menu">${sw('notifyShipped', 'لما الأوردر يتبعت لحازم', 'رسالة «الشحنة اتسجلت» مع رقم البوليصة')}${sw('notifyDelivered', 'لما الشحنة تتسلّم', 'رسالة «تم التسليم بنجاح»')}</div>
      <div class="tiny" style="margin:6px 4px">كل رسالة قالب بتتحاسب من ميتا حسب الدولة (فئة Utility).</div>
      <button class="btn block" id="kpAgain" style="margin-top:8px">إعادة الربط بمفتاح جديد</button>`;
    $('#kpRef', sh.el).onclick = paint;
    $('#kpAgain', sh.el).onclick = () => { showForm = true; paint(); };
    $$('[data-kp]', sh.el).forEach(c => c.onchange = async () => { const q = await Kapso.prefs(); q[c.dataset.kp] = c.checked; await Store.set('kapso_prefs', q); toast(c.checked ? 'اتفعّل' : 'اتقفل'); });
  };
  await paint();
}

// ---------- customers' messages -> new orders ----------
function openKapsoInbox() {
  const by = {};
  for (const m of Kapso.msgs) (by[m.phone] ||= { name: m.name, phone: m.phone, items: [] }).items.push(m);
  const people = Object.values(by);
  const sh = sheet('رسائل العملاء الواردة', people.length ? `<div class="list">${people.map((p, i) => `<button class="item" data-i="${i}"><div class="grow"><div class="row between"><b>${esc(p.name || p.phone)}</b><span class="tiny ltr">${esc(p.phone)}</span></div><div class="small" style="white-space:pre-line">${esc(p.items.slice(0, 3).map(x => x.text).reverse().join('\n'))}</div><div class="tiny">${p.items.length} رسالة · دوس عشان تحوّلها لأوردر</div></div></button>`).join('')}</div>`
    : `<div class="card empty">${ic('whatsapp')}<div>مفيش رسائل واردة لسه</div><div class="small" style="margin-top:6px">أي عميل يكتب لرقم واتساب Business هتلاقي رسالته هنا</div></div>`);
  $$('.item[data-i]', sh.el).forEach(b => b.onclick = () => { const p = people[b.dataset.i]; sh.close(); openWaOrders({ text: p.items.slice().reverse().map(x => x.text).join('\n'), phone: p.phone, name: p.name }); });
}

// refresh the badge column + keep polling
setInterval(() => Kapso.poll(), 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) Kapso.poll(); });
window.Capacitor?.Plugins?.App?.addListener?.('resume', () => Kapso.poll());
