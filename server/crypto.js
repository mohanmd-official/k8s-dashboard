// Encrypts stored AWS secret keys (AES-256-GCM). The key comes from EKSL_SECRET_KEY
// (32 bytes, base64) or is generated once into data/secret.key with 0600 permissions.
// Keep that file out of git and back it up with the database: without it the stored
// secrets cannot be decrypted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let key = null;
function getKey() {
  if (key) return key;
  if (process.env.EKSL_SECRET_KEY) {
    key = Buffer.from(process.env.EKSL_SECRET_KEY, 'base64');
  } else {
    const file = path.resolve(process.env.SECRET_KEY_FILE || 'data/secret.key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error('EKSL_SECRET_KEY must be 32 bytes, base64 encoded');
  return key;
}

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
