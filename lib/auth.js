const crypto = require('crypto');
const secret = () => process.env.APP_SECRET || ('s:' + (process.env.APP_PASSWORD || ''));
const sign = exp => crypto.createHmac('sha256', secret()).update('ok:' + exp).digest('hex');
exports.token = (days = 365) => { const exp = Date.now() + days * 864e5; return `${exp}.${sign(exp)}`; };
exports.valid = req => {
  if (!process.env.APP_PASSWORD) return false;           // refuse to run without a password
  const m = /(?:^|;\s*)app_auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const same = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
// Spaces around the password (paste / keyboard) never decide: both sides are trimmed.
exports.checkPassword = p => { const want = String(process.env.APP_PASSWORD || '').trim(); return !!want && same(String(p || '').trim(), want); };
exports.authed = req => {
  if (exports.valid(req)) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  let pw = m[1];
  // Header values can't carry Arabic letters etc., so the app sends "b64.<base64 of the UTF-8 password>".
  if (pw.startsWith('b64.')) { try { pw = Buffer.from(pw.slice(4), 'base64').toString('utf8'); } catch { return false; } }
  return exports.checkPassword(pw);
};
