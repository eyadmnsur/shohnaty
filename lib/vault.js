// Encrypts secrets (the Kapso API key) before they are written to Redis. Key = scrypt(APP_SECRET || APP_PASSWORD).
const crypto = require('crypto');
const key = () => crypto.scryptSync(process.env.APP_SECRET || process.env.APP_PASSWORD || 'no-secret', 'shohnaty-vault', 32);

exports.seal = obj => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
};
exports.open = s => {
  try {
    const [iv, tag, enc] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch { return null; }
};
