// Links to shipments on hazem-halan.com open inside the app (Android: "open with شحناتي").
// Also works by pasting / sharing such a link into the app search box.
function shipmentIdFromUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (!/(^|\.)hazem-halan\.com$/i.test(x.hostname)) return null;
    return (x.searchParams.get('id') || '').replace(/\D/g, '') || null;
  } catch { return null; }
}
async function openFromUrl(url) {
  const id = shipmentIdFromUrl(url);
  if (!id) return false;
  if (!Hazem.creds) { state.pendingUrl = url; return true; }   // after login
  try { openShipment(await Hazem.byId(id)); } catch (e) { handleErr(e); }
  return true;
}
(() => {
  const App = window.Capacitor?.Plugins?.App;
  App?.addListener?.('appUrlOpen', e => openFromUrl(e.url));
  App?.getLaunchUrl?.().then(r => { if (r?.url) setTimeout(() => openFromUrl(r.url), 1200); }).catch(() => {});
  // Anything that finished starting up with a link waiting.
  setInterval(() => { if (state.pendingUrl && Hazem.creds && $('#view')) { const u = state.pendingUrl; state.pendingUrl = null; openFromUrl(u); } }, 800);
})();
