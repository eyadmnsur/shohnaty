// "الأوردرات اللي اتضافت" — every order the app created on Shopify (chat / sheet orders, tag wa-app) in the last day / 3 days / week,
// newest first. Long-press (or tap the box) to select, then delete: it is removed from Shopify and from the app.
Shopify.deleteOrder = async function (id) {
  const del = async () => { const d = await this.gql(`mutation($id:ID!){ orderDelete(orderId:$id){ deletedId userErrors { message } } }`, { id }); return d.orderDelete.userErrors?.[0]?.message || ''; };
  let err = await del(); if (!err) return;
  // Shopify only deletes cancelled / test-style orders: cancel first (no refund, no email, stock back), then delete.
  try { await this.cancel(id); } catch (e) { if (!/already|cancel/i.test(e.message)) throw new Error(e.message); }
  for (let i = 0; i < 4 && err; i++) { await new Promise(r => setTimeout(r, 1500)); err = await del(); }
  if (err) throw new Error(err);
};

async function openRecentOrders() {
  await waLoad();
  const sel = new Set(); let days = 1, items = [];
  const sh = sheet('الأوردرات اللي اتضافت', '<div class="card card-pad"><div class="spinner"></div></div>');
  const body = $('.sheet-b', sh.el);
  const startOf = d => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (d - 1)); return x; };
  const hm = iso => { const x = new Date(iso); return x.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short' }) + ' ' + x.toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' }); };
  async function load() {
    body.innerHTML = '<div class="card card-pad"><div class="spinner"></div></div>';
    const from = startOf(days), list = [];
    if (Shopify.ready) {
      const d = await Shopify.gql(`query($q:String!){ orders(first:100, sortKey:CREATED_AT, reverse:true, query:$q){ nodes { id name createdAt tags cancelledAt displayFulfillmentStatus totalPriceSet { shopMoney { amount } } shippingAddress { name phone } } } }`, { q: `tag:${TAG_WA} created_at:>=${from.toISOString()}` });
      for (const o of d.orders.nodes) list.push({ key: o.id, shopId: o.id, name: o.name, at: o.createdAt, cust: o.shippingAddress?.name || '', phone: o.shippingAddress?.phone || '', total: o.totalPriceSet?.shopMoney?.amount, sent: (o.tags || []).some(t => /^HZM-|^hazem-sent$/.test(t)) ? ((o.tags || []).find(t => /^HZM-/.test(t)) || 'اتبعت لحازم') : '', cancelled: !!o.cancelledAt });
    }
    // drafts that are not on Shopify (or whose Shopify order is not in the list above)
    for (const x of state.waDrafts) {
      const at = new Date(Number(String(x.id).slice(0, 13))); if (!(at >= from)) continue;
      if (x.shop && list.some(l => l.shopId === x.shop.id)) continue;
      list.push({ key: 'd' + x.id, draftId: x.id, shopId: x.shop?.id, name: x.shop?.name || 'مسودة', at: at.toISOString(), cust: x.s.client_name, phone: x.s.phone_1, total: x.s.price, sent: '' });
    }
    items = list.sort((a, b) => new Date(b.at) - new Date(a.at)); sel.clear(); paint();
  }
  function paint() {
    const seg = [[1, 'النهارده'], [3, 'آخر 3 أيام'], [7, 'آخر أسبوع']].map(([d, t]) => `<button data-d="${d}" class="${days === d ? 'on' : ''}">${t}</button>`).join('');
    body.innerHTML = `<div class="seg" id="rcSeg" style="margin-bottom:8px">${seg}</div>
      <div class="small muted" style="margin:0 4px 8px">${items.length} أوردر · الأحدث الأول · دوس مطوّل على أوردر عشان تحدده</div>
      ${items.length ? `<div class="list">${items.map((o, i) => `<div class="item ${sel.has(o.key) ? 'selected' : ''}" data-k="${i}">${sel.size ? `<span class="check ${sel.has(o.key) ? 'on' : ''}"></span>` : ''}<div class="grow">
        <div class="row between"><span class="title"><span class="serial">${i + 1}</span>${esc(o.cust || 'بدون اسم')}</span><span class="amount">${o.total ? money(o.total) + ' <span class="tiny">ج.م</span>' : '—'}</span></div>
        <div class="row between wrap" style="gap:6px;margin-top:4px"><span class="small"><b>${esc(o.name)}</b> <span class="ltr">${esc(o.phone || '')}</span></span><span class="tiny">${esc(hm(o.at))}</span></div>
        ${o.sent ? `<div style="margin-top:4px"><span class="badge canary">📦 اتبعت لحازم (${esc(o.sent)})</span></div>` : ''}${o.cancelled ? '<div style="margin-top:4px"><span class="badge warning">ملغي على شوبيفاي</span></div>' : ''}
      </div></div>`).join('')}</div>` : '<div class="card empty"><div>مفيش أوردرات في الفترة دي</div></div>'}
      ${sel.size ? `<div class="sel-bar" style="position:sticky;bottom:0;margin:10px -4px 0;border-radius:12px"><div class="row between" style="margin-bottom:8px"><b>تم تحديد ${sel.size}</b><span class="row" style="gap:6px"><button class="btn sm" id="rcAll">${sel.size === items.length ? 'إلغاء الكل' : 'تحديد الكل'}</button><button class="icon-btn" id="rcX">${ic('close')}</button></span></div>
        <button class="btn danger block" id="rcDel">🗑️ امسح ${sel.size} من شوبيفاي ومن التطبيق</button></div>` : ''}`;
    $$('#rcSeg button', body).forEach(b => b.onclick = () => { days = +b.dataset.d; load().catch(e => { body.innerHTML = `<div class="banner critical">${esc(e.message)}</div>`; }); });
    $$('.item[data-k]', body).forEach(it => {
      const o = items[it.dataset.k]; let t = null, long = false;
      const toggle = () => { sel.has(o.key) ? sel.delete(o.key) : sel.add(o.key); paint(); };
      it.addEventListener('touchstart', () => { long = false; t = setTimeout(() => { long = true; navigator.vibrate?.(30); toggle(); }, 480); }, { passive: true });
      it.addEventListener('touchend', () => clearTimeout(t)); it.addEventListener('touchmove', () => clearTimeout(t), { passive: true });
      it.addEventListener('contextmenu', e => { e.preventDefault(); if (!long) toggle(); long = true; });
      it.addEventListener('click', () => { if (long) { long = false; return; } if (sel.size) toggle(); });
    });
    $('#rcX', body)?.addEventListener('click', () => { sel.clear(); paint(); });
    $('#rcAll', body)?.addEventListener('click', () => { if (sel.size === items.length) sel.clear(); else items.forEach(o => sel.add(o.key)); paint(); });
    $('#rcDel', body)?.addEventListener('click', del);
  }
  async function del() {
    const pick = items.filter(o => sel.has(o.key)), sent = pick.filter(o => o.sent);
    if (!confirm(`هتمسح ${pick.length} أوردر من شوبيفاي ومن التطبيق.${sent.length ? `\n\n⚠️ منهم ${sent.length} اتبعتوا لحازم — الشحنة هناك مش هتتمسح، لازم تلغيها من حازم بنفسك.` : ''}\n\nالمسح مش بيترجّع. تكمّل؟`)) return;
    const p = sheet('مسح الأوردرات', `<div class="card card-pad"><div class="progress"><span id="rpg" style="width:0"></span></div><div class="log" id="rlog" style="margin-top:10px"></div></div>`, [['تم', () => { p.close(); load().catch(() => {}); }, 'primary']]);
    let ok = 0;
    for (let i = 0; i < pick.length; i++) {
      const o = pick[i], log = t => $('#rlog', p.el).insertAdjacentHTML('beforeend', `<div>${t}</div>`);
      try {
        if (o.shopId) await Shopify.deleteOrder(o.shopId);
        state.waDrafts = state.waDrafts.filter(x => !(String(x.id) === String(o.draftId) || (o.shopId && x.shop?.id === o.shopId)));
        log(`✅ ${esc(o.name)} ${esc(o.cust)}`); ok++;
      } catch (e) { log(`❌ ${esc(o.name)}: ${esc(e.message)}`); }
      $('#rpg', p.el).style.width = ((i + 1) / pick.length * 100) + '%';
    }
    await Store.set('wa_drafts', state.waDrafts);
    $('.sheet-h h3', p.el).textContent = `اتمسح ${ok} من ${pick.length}`;
    if (state.tab === 'shop') refreshTab().catch(() => {});
  }
  load().catch(e => { body.innerHTML = `<div class="banner critical">${esc(/access|scope|permission/i.test(e.message) ? 'صلاحية شوبيفاي مش بتسمح بمسح الأوردرات (محتاج write_orders)' : e.message)}</div>`; });
}
