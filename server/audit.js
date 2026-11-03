// Audit trail: one JSON line to stdout (ship to CloudWatch) and a row in the database.
import { db } from './db.js';

export function audit(entry) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, audit: true, ...entry }));
  const { event, user, cluster, ...rest } = entry;
  if (db.dialect) db.run('INSERT INTO audit_log (ts, user_name, event, cluster_id, detail) VALUES ($1,$2,$3,$4,$5)', [ts, user || null, event, cluster || null, JSON.stringify(rest)]).catch(() => {});
}

/** Identity of the caller. Behind an ALB with OIDC auth, the ALB injects x-amzn-oidc-* headers. */
export function userOf(req) {
  const h = req.headers;
  if (h['x-amzn-oidc-data']) {
    try {
      const payload = JSON.parse(Buffer.from(h['x-amzn-oidc-data'].split('.')[1], 'base64url').toString());
      return payload.email || payload.preferred_username || payload.sub;
    } catch { /* fall through */ }
  }
  return h['x-amzn-oidc-identity'] || h['x-forwarded-email'] || h['x-forwarded-user'] || process.env.LOCAL_USER || 'local';
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowed = (envName, user) => { const a = list(process.env[envName]); return !a.length || a.includes(user); };

/** Pod shell. READ_ONLY disables it; EXEC_ALLOWED_USERS restricts it. */
export function canExec(cfg, user) {
  return !cfg.settings.readOnly && allowed('EXEC_ALLOWED_USERS', user);
}
/** Create / edit / delete / scale. READ_ONLY or WRITE_ENABLED=false disables; WRITE_ALLOWED_USERS restricts. */
export function canWrite(cfg, user) {
  return !cfg.settings.readOnly && process.env.WRITE_ENABLED !== 'false' && allowed('WRITE_ALLOWED_USERS', user);
}
/** Showing secret values (Kubernetes Secrets and Secrets Manager). REVEAL_SECRETS=false disables. */
export function canReveal(cfg, user) {
  return process.env.REVEAL_SECRETS !== 'false' && allowed('REVEAL_ALLOWED_USERS', user);
}
