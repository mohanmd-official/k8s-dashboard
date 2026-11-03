// Account registry: accounts from config/accounts.yaml (read-only in the UI) plus accounts
// added in the UI (stored in the database, secrets encrypted). Secrets never leave the server.
import crypto from 'node:crypto';
import { db } from './db.js';
import { encrypt, decrypt } from './crypto.js';

let fileAccounts = [];
export function setFileAccounts(list) {
  fileAccounts = list.map((a) => ({ ...a, id: `file:${a.name}`, source: 'file', authType: a.profile ? 'profile' : 'default', enabled: true }));
}

const fromRow = (r) => ({
  id: r.id, source: 'db', name: r.name, accountId: r.account_id || '', authType: r.auth_type,
  profile: r.profile || undefined, accessKeyId: r.access_key_id || undefined,
  secretAccessKey: r.secret_enc ? decrypt(r.secret_enc) : undefined,
  sessionToken: r.session_token_enc ? decrypt(r.session_token_enc) : undefined,
  roleArn: r.role_arn || '', externalId: r.external_id || undefined,
  regions: JSON.parse(r.regions || '[]'), clusters: r.clusters ? JSON.parse(r.clusters) : null,
  enabled: !!Number(r.enabled), createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function listAccounts({ includeDisabled = false } = {}) {
  const rows = (await db.all('SELECT * FROM accounts ORDER BY name')).map(fromRow);
  const names = new Set(rows.map((r) => r.name));
  const all = [...fileAccounts.filter((a) => !names.has(a.name)), ...rows];
  return includeDisabled ? all : all.filter((a) => a.enabled);
}

/** Safe view for the browser: no secret material. */
export function publicAccount(a) {
  return {
    id: a.id, source: a.source, name: a.name, accountId: a.accountId, authType: a.authType,
    profile: a.profile, accessKeyId: a.accessKeyId ? `${a.accessKeyId.slice(0, 4)}…${a.accessKeyId.slice(-4)}` : undefined,
    hasSecret: !!a.secretAccessKey, hasSessionToken: !!a.sessionToken,
    roleArn: a.roleArn, externalId: a.externalId, regions: a.regions, clusters: a.clusters, enabled: a.enabled,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

export function validateInput(b) {
  const errs = [];
  if (!b.name || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/.test(b.name)) errs.push('Name: letters, numbers, space . _ - (max 63).');
  if (!['keys', 'profile', 'default'].includes(b.authType)) errs.push('Sign-in method must be keys, profile or default.');
  if (b.authType === 'profile' && !b.profile) errs.push('Profile name is required.');
  if (b.accountId && !/^\d{12}$/.test(b.accountId)) errs.push('AWS account ID must be 12 digits.');
  if (b.roleArn && !/^arn:aws[\w-]*:iam::\d{12}:role\/.+/.test(b.roleArn)) errs.push('Role ARN looks wrong (arn:aws:iam::123456789012:role/Name).');
  if (!Array.isArray(b.regions) || !b.regions.length) errs.push('Pick at least one region, or "all".');
  return errs;
}

export async function saveAccount(b, existingId) {
  const now = new Date().toISOString();
  const prev = existingId ? (await db.all('SELECT * FROM accounts WHERE id = $1', [existingId]))[0] : null;
  // Blank secret on edit = keep the stored one.
  const secretEnc = b.authType === 'keys' ? (b.secretAccessKey ? encrypt(b.secretAccessKey) : prev?.secret_enc) : null;
  const tokenEnc = b.authType === 'keys' ? (b.sessionToken ? encrypt(b.sessionToken) : b.clearSessionToken ? null : prev?.session_token_enc) : null;
  const accessKeyId = b.authType === 'keys' ? (b.accessKeyId || prev?.access_key_id) : null;
  if (b.authType === 'keys' && (!accessKeyId || !secretEnc)) throw Object.assign(new Error('Access key ID and secret access key are required.'), { status: 400 });
  const id = existingId || crypto.randomUUID();
  const vals = [id, b.name.trim(), b.accountId || null, b.authType, b.authType === 'profile' ? b.profile : null, accessKeyId, secretEnc, tokenEnc,
    b.roleArn || null, b.externalId || null, JSON.stringify(b.regions), b.clusters?.length ? JSON.stringify(b.clusters) : null, b.enabled === false ? 0 : 1, prev?.created_at || now, now];
  await db.run(`INSERT INTO accounts (id, name, account_id, auth_type, profile, access_key_id, secret_enc, session_token_enc, role_arn, external_id, regions, clusters, enabled, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, account_id=excluded.account_id, auth_type=excluded.auth_type, profile=excluded.profile,
      access_key_id=excluded.access_key_id, secret_enc=excluded.secret_enc, session_token_enc=excluded.session_token_enc, role_arn=excluded.role_arn,
      external_id=excluded.external_id, regions=excluded.regions, clusters=excluded.clusters, enabled=excluded.enabled, updated_at=excluded.updated_at`, vals);
  return id;
}

export async function deleteAccount(id) {
  await db.run('DELETE FROM accounts WHERE id = $1', [id]);
}

/** Turn a not-yet-saved form into an account object (for "Test connection"). */
export async function draftAccount(b, existingId) {
  let prev = null;
  if (existingId) prev = (await listAccounts({ includeDisabled: true })).find((a) => a.id === existingId);
  return {
    id: existingId || 'draft', source: 'draft', name: b.name || 'draft', accountId: b.accountId || '', authType: b.authType,
    profile: b.profile, accessKeyId: b.accessKeyId || prev?.accessKeyId, secretAccessKey: b.secretAccessKey || prev?.secretAccessKey,
    sessionToken: b.sessionToken || (b.clearSessionToken ? undefined : prev?.sessionToken),
    roleArn: b.roleArn || '', externalId: b.externalId?.trim() || undefined, regions: b.regions?.length ? b.regions : ['us-east-1'], clusters: b.clusters?.length ? b.clusters : null,
  };
}
