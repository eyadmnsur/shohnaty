// Customer history: everything Hazem knows about the person behind a phone number —
// what they received, what they refused, WHY they refused, and whether they paid the return shipping.
// Opens from any "رفض قبل كده / استلم قبل كده" badge and shows inside the order sheet.
const Customer = {
  cache: {},
  async load(phone) {
    const c = this.cache[phone]; if (c && Date.now() - c.t < 5 * 60000) return c.v;
    const all = await Hazem.shipments({ phone, items: 100 });
    const mine = all.filter(r => findPhones(r.phone1, r.phone2).includes(phone) && r.waybill).sort((a, b) => dtVal(b.date) - dtVal(a.date));
    const delivered = mine.filter(r => r.category === 'delivered' || STATUS.full.includes(Number(r.statusId)));
    const returned = mine.filter(r => isFailed(r));
    const open = mine.filter(r => ['active', 'postponed'].includes(r.category) && !isFailed(r));
    // reasons + return-shipping for the latest refusals
    const recent = returned.slice(0, 8);
    await pool(recent, 3, async s => { s.rInfo = await reasonFor(s); });
    let fees = {}; try { fees = await Hazem.returnFees(recent.map(s => s.waybill)); } catch {}
    recent.forEach(s => { s.fee = fees[s.waybill] || null; });
    const v = { mine, delivered, returned, open, recent, spent: delivered.reduce((a, r) => a + num(r.cod), 0), lostFees: recent.reduce((a, s) => a + (s.fee ? Math.max(0, s.fee.fee - s.fee.paid) : 0), 0) };
    v.assess = this.assess(v);
    this.cache[phone] = { t: Date.now(), v }; return v;
  },
  // A plain-language read of the customer, from the facts above.
  assess(v) {
    const d = v.delivered.length, r = v.returned.length, why = v.recent.map(s => `${s.rInfo?.reason || ''} ${s.rInfo?.note || ''}`).join(' ');
    const notOrdered = /لم يطلب|مطلبش|ما طلب|مش طالب|غير جاد|لا يعرف|مش عارف/.test(why);
    const refused = /رفض|مش عاي|لغ[ىي]|غير مناسب/.test(why);
    const day = 864e5, now = Date.now();
    const lastD = v.delivered[0] ? dtVal(v.delivered[0].date) : 0, burst = v.mine.filter(x => now - dtVal(x.date) < 14 * day && x.category !== 'cancelled').length;
    const notes = [];
    if (burst > 1) notes.push(`طلب ${burst} شحنات في آخر 14 يوم — شوف لو الأوردر مكرر.`);
    if (d && lastD && now - lastD < 30 * day) notes.push(`استلم آخر أوردر من ${Math.max(1, Math.round((now - lastD) / day))} يوم وبيطلب تاني.`);
    if (v.lostFees > 0) notes.push(`رجّع من غير ما يدفع شحن المرتجع (خسارة ${money(v.lostFees)} ج.م).`);
    let level = 'new', head = 'عميل جديد — مفيش تاريخ سابق على حازم.';
    if (!r && d) { level = 'good'; head = `✅ عميل مضمون: استلم ${d} ${d > 1 ? 'مرات' : 'مرة'} ومارفضش ولا مرة.`; }
    else if (r && !d) {
      if (r >= 2 || notOrdered) { level = 'high'; head = `🚩 خطر عالي: رفض ${r} ${r > 1 ? 'مرات' : 'مرة'} ومستلمش ولا أوردر${notOrdered ? ' — وسبب الرفض «العميل لم يطلب»، ده مؤشر إن الأوردر غير جاد (ممكن حد تاني اتسمّى عليه أو طلب من غير قصد)' : ''}.`; }
      else { level = 'medium'; head = `⚠️ رفض مرة ومستلمش قبل كده${refused ? ' (رفض الاستلام)' : ''}. اتأكد منه بمكالمة قبل ما تشحن.`; }
    } else if (r && d) { level = r > d ? 'high' : 'medium'; head = `⚠️ استلم ${d} ورفض ${r}. راجع سبب الرفض تحت قبل ما تشحن.`; }
    return { level, head, notes };
  },
  html(v) {
    const lv = { good: 'success', medium: 'warning', high: 'critical', new: 'info' }[v.assess.level];
    const stat = (n, l, c) => `<div class="stat"><div class="lbl">${l}</div><div class="num" style="color:${c || 'inherit'}">${n}</div></div>`;
    const rows = v.mine.slice(0, 15).map(s => {
      const isRet = isFailed(s), why = s.rInfo ? [s.rInfo.reason, s.rInfo.note].filter(x => x && !/^[-_—\s]+$/.test(x)).join(' — ') : '';
      return `<button class="item" data-cs="${esc(s.waybill)}"><div class="grow">
        <div class="row between"><span class="title ltr">${esc(s.waybill)}</span><span class="amount">${money(s.cod)} <span class="tiny">ج.م</span></span></div>
        <div class="row between wrap" style="gap:6px;margin-top:4px">${statusBadge(s)}<span class="tiny">${esc(dt(s.date))}</span></div>
        ${isRet ? `<div class="reason">${ic('alert', 'width="14"')}<b>سبب الرفض:</b> ${esc(why || 'مش مكتوب سبب')}${s.rInfo?.by ? ` <span class="tiny">· ${esc(s.rInfo.by)}</span>` : ''}</div>${s.fee ? `<div style="margin-top:4px">${feeBadge(s.fee)}</div>` : ''}` : ''}
      </div></button>`;
    }).join('');
    return `<div class="banner ${v.assess.level === 'good' ? 'success' : v.assess.level === 'high' ? 'critical' : v.assess.level === 'medium' ? 'warning' : 'info'}" style="display:block"><b>${esc(v.assess.head)}</b>${v.assess.notes.map(n => `<div class="small" style="margin-top:4px">• ${esc(n)}</div>`).join('')}</div>
      <div class="stats" style="margin:8px 0">${stat(v.delivered.length, 'استلم', '#1f8a4c')}${stat(v.returned.length, 'رفض / مرتجع', v.returned.length ? '#c0392b' : 'inherit')}${stat(v.open.length, 'مفتوح دلوقتي')}${stat(money(v.spent), 'إجمالي اللي استلمه')}</div>
      ${rows ? `<div class="section-title">آخر ${Math.min(15, v.mine.length)} شحنة (الأحدث الأول)</div><div class="list">${rows}</div>` : ''}`;
  },
  bind(root) { $$('[data-cs]', root).forEach(b => b.onclick = e => { e.stopPropagation(); const s = (this._last || []).find(x => x.waybill === b.dataset.cs); if (s) openShipment(s); }); },
  // Fills `el` with the customer's history (used inside the order sheet).
  async inline(phone, el) {
    if (!phone || !el) return;
    el.innerHTML = `<div class="card card-pad"><div class="small muted">بفحص سجل العميل على حازم…</div></div>`;
    try { const v = await this.load(phone); this._last = v.mine; if (!v.mine.length) { el.innerHTML = ''; return; } el.innerHTML = `<div class="card card-pad"><div class="h2" style="margin-bottom:8px">سجل العميل</div>${this.html(v)}</div>`; this.bind(el); }
    catch { el.innerHTML = ''; }
  },
};
async function openCustomerHistory(phone, name = '') {
  const sh = sheet('سجل العميل' + (name ? ' — ' + name : ''), loading());
  try { const v = await Customer.load(phone); Customer._last = v.mine; $('.sheet-b', sh.el).innerHTML = `<div class="small muted ltr" style="text-align:right;margin-bottom:6px">${esc(phone)}</div>` + (v.mine.length ? Customer.html(v) : '<div class="card empty"><div>مفيش شحنات سابقة لنفس الرقم على حازم</div></div>'); Customer.bind(sh.el); }
  catch (e) { sh.close(); handleErr(e); }
}
// Tapping a "refused before / received before" badge anywhere opens the history.
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-hist]'); if (!b) return;
  e.stopImmediatePropagation(); e.preventDefault(); openCustomerHistory(b.dataset.hist);
}, true);
