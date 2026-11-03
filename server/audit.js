// Structured audit log to stdout (ship to CloudWatch with Fluent Bit / Container Insights).
export function audit(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), audit: true, ...entry }));
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
  return h['x-amzn-oidc-identity'] || h['x-forwarded-email'] || h['x-forwarded-user'] || 'anonymous';
}

/** Exec allowed? READ_ONLY disables it; EXEC_ALLOWED_USERS restricts it to a list. */
export function canExec(cfg, user) {
  if (cfg.settings.readOnly) return false;
  const allow = (process.env.EXEC_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allow.length || allow.includes(user);
}
