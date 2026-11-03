import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as k8s from '@kubernetes/client-node';
import { loadConfig } from './config.js';
import { discoverClusters } from './aws.js';
import { collectInventory, kubeConfigFor } from './kube.js';
import { analyze } from '../public/js/shared/model.js';
import { DEMO_CLUSTERS, demoInventory } from '../public/js/shared/mock.js';
import { handleLogs, handleExec, handleKubectl } from './stream.js';
import { audit, userOf } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const PORT = Number(process.env.PORT || 8080);
const app = express();

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

// ---- cluster registry
let clusterCache = { at: 0, list: [] };
async function clusters(force = false) {
  if (cfg.demo) return DEMO_CLUSTERS;
  if (!force && Date.now() - clusterCache.at < 5 * 60_000 && clusterCache.list.length) return clusterCache.list;
  const results = await Promise.allSettled(cfg.accounts.map((a) => discoverClusters(a)));
  const list = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') list.push(...r.value);
    else list.push({ id: `${cfg.accounts[i].name}/-/error`, account: cfg.accounts[i].name, accountId: cfg.accounts[i].accountId, region: '-', name: '(account unreachable)', status: 'ERROR', error: r.reason?.message });
  });
  clusterCache = { at: Date.now(), list };
  return list;
}
export async function resolveCluster(id) {
  const list = await clusters();
  const c = list.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error(`unknown cluster ${id}`), { status: 404 });
  return { cluster: c, account: cfg.accounts.find((a) => a.name === c.account) };
}
export async function kcFor(id) {
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
  return data;
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status || e.code || 500).json({ error: e.body?.message || e.message });
});

app.get('/api/meta', (req, res) => res.json({
  demo: cfg.demo, readOnly: cfg.settings.readOnly, user: userOf(req),
  accounts: cfg.demo ? [...new Set(DEMO_CLUSTERS.map((c) => c.account))] : cfg.accounts.map((a) => a.name),
  costModel: cfg.settings.costModel,
}));
app.get('/api/clusters', wrap(async (req, res) => {
  const list = await clusters(req.query.refresh === '1');
  res.json(list.map(({ caData, endpoint, ...c }) => c));
}));
app.get('/api/snapshot', wrap(async (req, res) => res.json(await snapshot(req.query.cluster, req.query.refresh === '1'))));

// Summary across every cluster (fleet view)
app.get('/api/fleet', wrap(async (_req, res) => {
  const list = (await clusters()).filter((c) => c.status === 'ACTIVE');
  const rows = await Promise.allSettled(list.map((c) => snapshot(c.id)));
  res.json(rows.map((r, i) => (r.status === 'fulfilled'
    ? { ...list[i], caData: undefined, endpoint: undefined, totals: r.value.totals, topNamespaces: r.value.namespaces.slice(0, 3).map((n) => ({ name: n.name, monthly: n.monthly })), defaultInUse: r.value.namespaces.some((n) => n.flags.some((f) => f.code === 'DEFAULT_IN_USE')) }
    : { ...list[i], caData: undefined, endpoint: undefined, error: r.reason?.message })));
}));

// Pod events (kubectl describe-style)
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

// ---- WebSockets: logs, exec, kubectl console
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

server.listen(PORT, () => {
  audit({ event: 'startup', demo: cfg.demo, accounts: cfg.accounts.length, readOnly: cfg.settings.readOnly });
  console.log(`EKS Lens listening on http://localhost:${PORT}${cfg.demo ? '  (DEMO_MODE)' : ''}`);
});
