import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as k8s from '@kubernetes/client-node';
import { loadConfig } from './config.js';
import { initDb, db } from './db.js';
import { setFileAccounts, listAccounts, publicAccount, validateInput, saveAccount, deleteAccount, draftAccount } from './accounts.js';
import { discoverClusters, whoAmI, forgetAccount, resolveRegions } from './aws.js';
import { collectInventory, kubeConfigFor, clearKubeClients } from './kube.js';
import { KINDS, listResources, readResource, applyManifests, deleteResource, workloadAction, usageIndex } from './resources.js';
import * as SM from './secretsmanager.js';
import { analyze } from '../public/js/shared/model.js';
import { DEMO_CLUSTERS, demoInventory } from '../public/js/shared/mock.js';
import { demoResources, demoReadObject, DEMO_SM, demoSmValue } from '../public/js/shared/mock-extra.js';
import { handleLogs, handleExec, handleKubectl } from './stream.js';
import { audit, userOf, canExec, canWrite, canReveal } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
await initDb();
setFileAccounts(cfg.accounts);
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1'; // local by default; the container sets 0.0.0.0
const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- optional shared-token auth (put the app behind ALB + OIDC/Cognito/SSO for real auth)
const AUTH_TOKEN = process.env.AUTH_TOKEN;
function authed(req) {
  if (!AUTH_TOKEN) return true;
  const h = req.headers.authorization || '';
  const q = new URL(req.url, 'http://x').searchParams.get('token');
  return h === `Bearer ${AUTH_TOKEN}` || q === AUTH_TOKEN || req.headers.cookie?.includes(`eksl_token=${AUTH_TOKEN}`);
}
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'unauthorized' })));
app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.send('ok'));

const err = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (/^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN)$/.test(e.code || '')) return res.status(502).json({ error: `Could not reach ${e.hostname || 'AWS'} (${e.code}). Check your internet connection or proxy.` });
  if (e.name === 'CredentialsProviderError' || /expired|ExpiredToken/i.test(e.name || '')) return res.status(401).json({ error: `${e.message} If this is an SSO profile, run: aws sso login --profile <name>` });
  const status = e.status || e.statusCode || e.$metadata?.httpStatusCode || (typeof e.code === 'number' ? e.code : 500);
  if (status >= 500) console.error(e);
  res.status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500).json({ error: e.body?.message || e.message });
});
const needWrite = (req) => { if (!canWrite(cfg, userOf(req))) throw err(403, 'Changes are disabled for your user (READ_ONLY, WRITE_ENABLED=false or WRITE_ALLOWED_USERS).'); };
const needReveal = (req) => { if (!canReveal(cfg, userOf(req))) throw err(403, 'Showing secret values is disabled for your user (REVEAL_SECRETS / REVEAL_ALLOWED_USERS).'); };

// ---- cluster registry
let clusterCache = { at: 0, list: [] };
async function clusters(force = false) {
  if (cfg.demo) return DEMO_CLUSTERS;
  if (!force && Date.now() - clusterCache.at < 5 * 60_000 && clusterCache.at) return clusterCache.list;
  const accounts = await listAccounts();
  const results = await Promise.allSettled(accounts.map((a) => discoverClusters(a)));
  const list = [];
  results.forEach((r, i) => {
    const a = accounts[i];
    if (r.status === 'fulfilled') {
      list.push(...r.value);
      if (!r.value.length) list.push({ id: `${a.name}/-/none`, account: a.name, accountKey: a.id, accountId: a.accountId, region: a.regions.join(','), name: '(no EKS clusters found)', status: 'EMPTY' });
    } else {
      list.push({ id: `${a.name}/-/error`, account: a.name, accountKey: a.id, accountId: a.accountId, region: '-', name: '(sign-in failed)', status: 'ERROR', error: r.reason?.message });
    }
  });
  clusterCache = { at: Date.now(), list };
  return list;
}
const invalidateClusters = () => { clusterCache = { at: 0, list: [] }; snapCache.clear(); clearKubeClients(); };

async function resolveCluster(id) {
  const c = (await clusters()).find((x) => x.id === id);
  if (!c) throw err(404, `Unknown cluster ${id}. Refresh the page.`);
  if (cfg.demo) return { cluster: c, account: null };
  const account = (await listAccounts()).find((a) => a.id === c.accountKey || a.name === c.account);
  if (!c.endpoint) throw err(502, c.error || 'Cluster is not reachable.');
  return { cluster: c, account };
}
async function kcFor(id) {
  const { cluster, account } = await resolveCluster(id);
  return kubeConfigFor(cluster, account);
}

const snapCache = new Map();
async function snapshot(id, force) {
  const hit = snapCache.get(id);
  if (!force && hit && Date.now() - hit.at < cfg.settings.refreshSeconds * 1000) return hit.data;
  let raw;
  if (cfg.demo) raw = demoInventory(id);
  else {
    const { cluster, account } = await resolveCluster(id);
    raw = await collectInventory(cluster, account, cfg.settings);
  }
  const data = analyze(raw, cfg.settings.costModel);
  snapCache.set(id, { at: Date.now(), data });
  if (!cfg.demo) recordSnapshot(id, data).catch((e) => console.warn('[db] snapshot not saved:', e.message));
  return data;
}

/** Keep one cost sample per cluster/namespace per hour so trends can be shown later. */
async function recordSnapshot(id, s) {
  const hour = new Date(); hour.setUTCMinutes(0, 0, 0);
  const ts = hour.toISOString();
  const up = `INSERT INTO cost_snapshots (ts, cluster_id, namespace, hourly, cpu_req, cpu_used, mem_req_gib, mem_used_gib, pods) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (ts, cluster_id, namespace) DO UPDATE SET hourly=excluded.hourly, cpu_req=excluded.cpu_req, cpu_used=excluded.cpu_used, mem_req_gib=excluded.mem_req_gib, mem_used_gib=excluded.mem_used_gib, pods=excluded.pods`;
  for (const n of s.namespaces) await db.run(up, [ts, id, n.name, n.hourly, n.reqCpu, n.usageCpu || 0, n.reqMemGiB, n.usageMemGiB || 0, n.podCount]);
  await db.run(up, [ts, id, '_idle', s.totals.idleHourly, 0, 0, 0, 0, 0]);
  await db.run(up, [ts, id, '_control_plane', s.totals.controlPlaneHourly, 0, 0, 0, 0, 0]);
}

// ---------------------------------------------------------------- meta & accounts
app.get('/api/meta', wrap(async (req, res) => {
  const user = userOf(req);
  res.json({
    demo: cfg.demo, readOnly: cfg.settings.readOnly, user,
    canExec: canExec(cfg, user), canWrite: canWrite(cfg, user), canReveal: canReveal(cfg, user),
    accounts: cfg.demo ? [...new Set(DEMO_CLUSTERS.map((c) => c.account))] : (await listAccounts()).map((a) => a.name),
    costModel: cfg.settings.costModel, db: db.dialect, kinds: Object.fromEntries(Object.entries(KINDS).filter(([, v]) => !v.hidden).map(([k, v]) => [k, v.label])),
  });
}));

app.get('/api/accounts', wrap(async (_req, res) => res.json((await listAccounts({ includeDisabled: true })).map(publicAccount))));

app.post('/api/accounts/test', wrap(async (req, res) => {
  const errs = validateInput({ ...req.body, name: req.body.name || 'test' });
  if (errs.length) throw err(400, errs.join(' '));
  const a = await draftAccount(req.body, req.body.id);
  if (a.authType === 'keys' && (!a.accessKeyId || !a.secretAccessKey)) throw err(400, 'Enter the access key ID and secret access key.');
  const identity = await whoAmI(a);
  let clustersFound = []; let clusterError = null;
  try { clustersFound = (await discoverClusters(a)).map((c) => ({ name: c.name, region: c.region, version: c.version, status: c.status })); } catch (e) { clusterError = e.message; }
  let regions = null;
  try { regions = await resolveRegions(a); } catch { /* ignore */ }
  res.json({ identity, clusters: clustersFound, clusterError, regionsScanned: regions });
}));

app.post('/api/accounts', wrap(async (req, res) => {
  const errs = validateInput(req.body);
  if (errs.length) throw err(400, errs.join(' '));
  const existing = await listAccounts({ includeDisabled: true });
  if (existing.some((a) => a.name === req.body.name.trim())) throw err(409, `An account named "${req.body.name}" already exists.`);
  const id = await saveAccount(req.body);
  audit({ event: 'account.create', user: userOf(req), name: req.body.name, authType: req.body.authType });
  invalidateClusters();
  res.json({ id });
}));

app.put('/api/accounts/:id', wrap(async (req, res) => {
  const all = await listAccounts({ includeDisabled: true });
  const cur = all.find((a) => a.id === req.params.id);
  if (!cur) throw err(404, 'Account not found.');
  if (cur.source !== 'db') throw err(400, 'This account comes from config/accounts.yaml. Edit that file, or add it again here.');
  const errs = validateInput(req.body);
  if (errs.length) throw err(400, errs.join(' '));
  if (all.some((a) => a.name === req.body.name.trim() && a.id !== cur.id)) throw err(409, `An account named "${req.body.name}" already exists.`);
  await saveAccount(req.body, cur.id);
  forgetAccount(cur);
  audit({ event: 'account.update', user: userOf(req), name: req.body.name });
  invalidateClusters();
  res.json({ ok: true });
}));

app.delete('/api/accounts/:id', wrap(async (req, res) => {
  const cur = (await listAccounts({ includeDisabled: true })).find((a) => a.id === req.params.id);
  if (!cur) throw err(404, 'Account not found.');
  if (cur.source !== 'db') throw err(400, 'This account comes from config/accounts.yaml. Remove it from that file.');
  await deleteAccount(cur.id);
  forgetAccount(cur);
  audit({ event: 'account.delete', user: userOf(req), name: cur.name });
  invalidateClusters();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- inventory
app.get('/api/clusters', wrap(async (req, res) => {
  const list = await clusters(req.query.refresh === '1');
  res.json(list.map(({ caData, endpoint, ...c }) => c));
}));
app.get('/api/snapshot', wrap(async (req, res) => res.json(await snapshot(req.query.cluster, req.query.refresh === '1'))));

app.get('/api/fleet', wrap(async (_req, res) => {
  const list = await clusters();
  const active = list.filter((c) => c.status === 'ACTIVE');
  const rows = await Promise.allSettled(active.map((c) => snapshot(c.id)));
  const byId = Object.fromEntries(active.map((c, i) => [c.id, rows[i]]));
  res.json(list.map(({ caData, endpoint, ...c }) => {
    const r = byId[c.id];
    if (!r) return c;
    return r.status === 'fulfilled'
      ? { ...c, totals: r.value.totals, topNamespaces: r.value.namespaces.slice(0, 3).map((n) => ({ name: n.name, monthly: n.monthly })), defaultInUse: r.value.namespaces.some((n) => n.flags.some((f) => f.code === 'DEFAULT_IN_USE')), findings: r.value.namespaces.reduce((a, n) => a + n.flags.filter((f) => f.level !== 'info').length, 0) }
      : { ...c, error: r.reason?.message };
  }));
}));

app.get('/api/history', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days || 30), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.all('SELECT ts, namespace, hourly FROM cost_snapshots WHERE cluster_id = $1 AND ts >= $2 ORDER BY ts', [req.query.cluster, since]);
  res.json(rows);
}));

app.get('/api/events', wrap(async (req, res) => {
  const { cluster, ns, pod } = req.query;
  if (cfg.demo) {
    const t = new Date().toISOString();
    return res.json(/orders-consumer/.test(pod)
      ? [{ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container orders-consumer', count: 412, last: t }]
      : /preview/.test(pod) ? [{ type: 'Warning', reason: 'FailedScheduling', message: '0/6 nodes are available: 6 Insufficient cpu. preemption: 0/6 nodes are available.', count: 88, last: t }]
        : [{ type: 'Normal', reason: 'Started', message: 'Started container', count: 1, last: t }]);
  }
  const core = (await kcFor(cluster)).makeApiClient(k8s.CoreV1Api);
  const ev = await core.listNamespacedEvent({ namespace: ns, fieldSelector: `involvedObject.name=${pod}` });
  res.json(ev.items.map((e) => ({ type: e.type, reason: e.reason, message: e.message, count: e.count || 1, last: e.lastTimestamp || e.eventTime || e.metadata.creationTimestamp }))
    .sort((a, b) => String(b.last).localeCompare(String(a.last))));
}));

// ---------------------------------------------------------------- config & storage resources
app.get('/api/resources', wrap(async (req, res) => {
  const { cluster, kind, ns } = req.query;
  const snap = await snapshot(cluster).catch(() => null);
  if (cfg.demo) return res.json(demoResources(snap, kind, ns));
  res.json(await listResources(await kcFor(cluster), kind, ns, usageIndex(snap)));
}));

app.get('/api/resource', wrap(async (req, res) => {
  const { cluster, kind, ns, name } = req.query;
  const reveal = req.query.reveal === '1';
  if (reveal) { needReveal(req); audit({ event: 'secret.reveal', user: userOf(req), cluster, ns, name, kind }); }
  if (cfg.demo) {
    const r = demoReadObject(kind, ns, name, reveal);
    const { default: YAML } = await import('yaml');
    return res.json({ ...r, yaml: YAML.stringify(r.object) });
  }
  res.json(await readResource(await kcFor(cluster), kind, ns, name, reveal));
}));

app.post('/api/apply', wrap(async (req, res) => {
  const { cluster, yaml, dryRun, namespace } = req.body;
  if (!dryRun) needWrite(req);
  if (!yaml?.trim()) throw err(400, 'YAML is empty.');
  audit({ event: dryRun ? 'apply.dryrun' : 'apply', user: userOf(req), cluster, bytes: yaml.length, kinds: (yaml.match(/^kind:\s*(\S+)/gm) || []).map((s) => s.split(':')[1].trim()) });
  if (cfg.demo) {
    const { parseManifests } = await import('./resources.js');
    const docs = parseManifests(yaml);
    return res.json({ demo: true, results: docs.map((o) => ({ kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace || namespace || 'default', ok: true, action: dryRun ? 'validated (demo)' : 'applied (demo, nothing changed)' })) });
  }
  const results = await applyManifests(await kcFor(cluster), yaml, { dryRun: !!dryRun, defaultNamespace: namespace || 'default' });
  if (!dryRun) snapCache.delete(cluster);
  res.json({ results });
}));

app.post('/api/delete', wrap(async (req, res) => {
  needWrite(req);
  const { cluster, kind, ns, name } = req.body;
  audit({ event: 'delete', user: userOf(req), cluster, kind, ns, name });
  if (cfg.demo) return res.json({ ok: true, demo: true, message: `Deleted ${kind} ${name} (demo, nothing changed)` });
  await deleteResource(await kcFor(cluster), kind, ns, name);
  snapCache.delete(cluster);
  res.json({ ok: true, message: `Deleted ${kind} ${ns ? ns + '/' : ''}${name}` });
}));

app.post('/api/workload', wrap(async (req, res) => {
  needWrite(req);
  const { cluster, action, kind, ns, name, replicas } = req.body;
  audit({ event: `workload.${action}`, user: userOf(req), cluster, kind, ns, name, replicas });
  if (cfg.demo) return res.json({ ok: true, demo: true, message: `${action} ${kind} ${name}${action === 'scale' ? ` to ${replicas}` : ''} (demo, nothing changed)` });
  const r = await workloadAction(await kcFor(cluster), { action, kind, namespace: ns, name, replicas });
  snapCache.delete(cluster);
  res.json(r);
}));

// ---------------------------------------------------------------- AWS Secrets Manager (per cluster's account + region)
async function smTarget(req) {
  const id = req.query.cluster || req.body?.cluster;
  const { cluster, account } = await resolveCluster(id);
  return { account, region: req.query.region || req.body?.region || cluster.region, cluster };
}
app.get('/api/sm', wrap(async (req, res) => {
  if (cfg.demo) return res.json(DEMO_SM);
  const { account, region } = await smTarget(req);
  res.json(await SM.listSecrets(account, region));
}));
app.get('/api/sm/value', wrap(async (req, res) => {
  needReveal(req);
  audit({ event: 'sm.reveal', user: userOf(req), cluster: req.query.cluster, secret: req.query.id, region: req.query.region });
  if (cfg.demo) return res.json(demoSmValue(req.query.id));
  const { account, region } = await smTarget(req);
  res.json(await SM.getSecretValue(account, region, req.query.id));
}));
app.post('/api/sm/value', wrap(async (req, res) => {
  needWrite(req);
  audit({ event: 'sm.update', user: userOf(req), cluster: req.body.cluster, secret: req.body.id, region: req.body.region });
  if (cfg.demo) return res.json({ ok: true, demo: true });
  const { account, region } = await smTarget(req);
  res.json(await SM.putSecretValue(account, region, req.body.id, req.body.value));
}));
app.post('/api/sm/create', wrap(async (req, res) => {
  needWrite(req);
  audit({ event: 'sm.create', user: userOf(req), cluster: req.body.cluster, secret: req.body.name, region: req.body.region });
  if (cfg.demo) return res.json({ ok: true, demo: true });
  const { account, region } = await smTarget(req);
  res.json(await SM.createSecret(account, region, req.body));
}));

app.get('/api/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  res.json(await db.all(`SELECT ts, user_name, event, cluster_id, detail FROM audit_log ORDER BY ts DESC LIMIT ${limit}`));
}));

// ---------------------------------------------------------------- WebSockets: logs, exec, kubectl console
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!authed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const ctx = { cfg, kcFor, user: userOf(req), q, snapshot };
    const route = { '/ws/logs': handleLogs, '/ws/exec': handleExec, '/ws/kubectl': handleKubectl }[url.pathname];
    if (!route) return ws.close(1008, 'unknown route');
    route(ws, ctx).catch((e) => {
      try { ws.send(`\r\n\x1b[31m[eks-lens] ${e.body?.message || e.message}\x1b[0m\r\n`); ws.close(1011); } catch {}
    });
  });
});

server.listen(PORT, HOST, async () => {
  const n = (await listAccounts().catch(() => [])).length;
  audit({ event: 'startup', demo: cfg.demo, accounts: n, readOnly: cfg.settings.readOnly, db: db.dialect });
  console.log(`EKS Lens listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${cfg.demo ? '  (DEMO_MODE)' : ''}  · database: ${db.dialect}${db.file ? ` (${db.file})` : ''}`);
});
