// Redis (Upstash REST) helpers shared by the server functions.
const db = require('./db');

async function redis(cmds) {
  const r = await fetch(db.url() + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + db.token(), 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const ready = () => !!(db.url() && db.token());

// The app's synced settings live in one hash ("shohnaty"): field -> {v: <JSON string>, t: ms}
const STORE = 'shohnaty';
async function storeGet(key, def = null) {
  const [raw] = await redis([['HGET', STORE, key]]);
  if (!raw) return def;
  try { const e = JSON.parse(raw); return e.v == null ? def : JSON.parse(e.v); } catch { return def; }
}
async function storeSet(key, value) {
  await redis([['HSET', STORE, key, JSON.stringify({ v: JSON.stringify(value), t: Date.now() })]]);
}
module.exports = { redis, ready, storeGet, storeSet };
