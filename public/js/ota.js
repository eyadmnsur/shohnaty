// Phone app only: loads the app scripts either from the copy packaged in the APK or from a newer copy
// downloaded from the website ("over the air"), so updates arrive without reinstalling the app.
// Safety: files are checked against SHA-256 from the website's ota.json, and if a downloaded version
// ever fails to start, the app drops it and falls back to the packaged one.
(async () => {
  const SITE = window.OTA_SITE || 'https://shohnaty5.vercel.app';
  const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
  const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const addScript = (src, text) => new Promise((ok, no) => { const s = document.createElement('script'); s.async = false; if (text != null) { s.text = text; document.head.appendChild(s); ok(); } else { s.src = src; s.onload = ok; s.onerror = () => no(new Error('load ' + src)); document.head.appendChild(s); } });

  // ---- what to run ----
  const packaged = await (await fetch('ota.json')).json();
  let bundle = null;
  try { bundle = JSON.parse(LS.get('ota_bundle') || 'null'); } catch {}
  if (LS.get('ota_boot') === 'trying' && bundle) { LS.set('ota_bad', String(bundle.version)); LS.del('ota_bundle'); bundle = null; }   // last start of this version failed
  if (bundle && (bundle.version <= packaged.version || String(bundle.version) === LS.get('ota_bad'))) bundle = null;
  window.APP_BUILD = bundle ? bundle.version : packaged.version;

  if (bundle) {
    LS.set('ota_boot', 'trying');
    if (bundle.css) { const st = document.createElement('style'); st.textContent = bundle.css; document.head.appendChild(st); }
    for (const f of bundle.files) await addScript(null, f.code + '\n//# sourceURL=' + f.path);
  } else {
    LS.del('ota_boot');
    for (const f of packaged.files) await addScript(f.path);
  }
  // the app is up when its UI is on screen
  const app = document.getElementById('app');
  const done = () => app && app.querySelector('.login,.tabbar,#view');
  if (app) new MutationObserver((_, o) => { if (done()) { if (bundle) LS.set('ota_boot', 'ok'); o.disconnect(); } }).observe(app, { childList: true, subtree: true });

  // ---- look for a newer version on the website ----
  let busy = false;
  async function check() {
    if (busy || document.hidden) return; busy = true;
    try {
      const r = await fetch(SITE + '/ota.json?_=' + Date.now(), { cache: 'no-store' });
      const m = await r.json();
      const have = Math.max(window.APP_BUILD, Number(LS.get('ota_have') || 0));
      if (!m || !m.version || m.version <= have || String(m.version) === LS.get('ota_bad')) return;
      const get = async f => { const t = await (await fetch(SITE + '/' + f.path + '?v=' + m.version, { cache: 'no-store' })).text(); if ((await sha(t)) !== f.sha) throw new Error('hash ' + f.path); return t; };
      const files = []; for (const f of m.files) files.push({ path: f.path, code: await get(f) });
      const css = m.css ? await get(m.css) : '';
      LS.set('ota_bundle', JSON.stringify({ version: m.version, files, css })); LS.set('ota_have', String(m.version));
      banner();
    } catch {} finally { busy = false; }
  }
  function banner() {
    if (document.getElementById('otaBar')) return;
    const b = document.createElement('div'); b.id = 'otaBar';
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:84px;z-index:99998;background:#1a1a1a;color:#fff;border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;font:14px system-ui,sans-serif;direction:rtl;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    b.innerHTML = '<span style="flex:1">🔄 فيه تحديث جديد اتنزّل</span><button style="border:0;border-radius:8px;padding:8px 14px;background:#fff;color:#1a1a1a;font-weight:700">حدّث دلوقتي</button>';
    b.querySelector('button').onclick = () => location.reload();
    document.body.appendChild(b);
  }
  setTimeout(check, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(check, 1500); });
  setInterval(check, 30 * 60000);
})();
