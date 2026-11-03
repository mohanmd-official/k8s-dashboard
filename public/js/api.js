// Transport layer. Talks to the EKS Lens server; if no server answers (static preview),
// falls back to the same sample data the server's DEMO_MODE uses, entirely in the browser.
import { analyze } from './shared/model.js';
import { DEMO_CLUSTERS, demoInventory, demoLogLine, demoShell } from './shared/mock.js';
import { fakeKubectl } from './shared/kubectl-demo.js';
import { demoResources, demoReadObject, DEMO_SM, demoSmValue } from './shared/mock-extra.js';

let staticMode = false;
const tokenQS = () => { const t = new URLSearchParams(location.search).get('token'); return t ? `token=${encodeURIComponent(t)}&` : ''; };

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${r.statusText}`);
  return r.json();
}

export async function meta() {
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`/api/meta?${tokenQS()}`, { signal: ctrl.signal });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('no server');
    return await r.json();
  } catch {
    staticMode = true;
    return { demo: true, static: true, readOnly: false, user: 'preview', canExec: true, canWrite: true, canReveal: true, db: 'browser preview',
      costModel: { cpuToMemCostRatio: 7.46, spotDiscount: 0.65 }, accounts: [...new Set(DEMO_CLUSTERS.map((c) => c.account))],
      kinds: { secrets: 'Secrets', configmaps: 'ConfigMaps', services: 'Services', ingresses: 'Ingresses', pvcs: 'Volumes (PVC)', hpas: 'Autoscalers (HPA)', cronjobs: 'CronJobs', jobs: 'Jobs', serviceaccounts: 'Service accounts', events: 'Events' } };
  }
}

export const clusters = (refresh) => (staticMode ? Promise.resolve(DEMO_CLUSTERS) : getJSON(`/api/clusters?${tokenQS()}${refresh ? 'refresh=1' : ''}`));
export const snapshot = (id, refresh) => (staticMode ? Promise.resolve(analyze(demoInventory(id))) : getJSON(`/api/snapshot?${tokenQS()}cluster=${encodeURIComponent(id)}${refresh ? '&refresh=1' : ''}`));
export async function fleet() {
  if (!staticMode) return getJSON(`/api/fleet?${tokenQS()}`);
  return DEMO_CLUSTERS.map((c) => {
    const s = analyze(demoInventory(c.id));
    return { ...c, totals: s.totals, topNamespaces: s.namespaces.slice(0, 3).map((n) => ({ name: n.name, monthly: n.monthly })), defaultInUse: s.namespaces.some((n) => n.flags.some((f) => f.code === 'DEFAULT_IN_USE')) };
  });
}
export function events(cluster, ns, pod) {
  if (staticMode) {
    return Promise.resolve(/orders-consumer/.test(pod) ? [{ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container orders-consumer', count: 412, last: new Date().toISOString() }]
      : /preview/.test(pod) ? [{ type: 'Warning', reason: 'FailedScheduling', message: '0/6 nodes are available: 6 Insufficient cpu.', count: 88, last: new Date().toISOString() }]
        : [{ type: 'Normal', reason: 'Started', message: 'Started container', count: 1, last: new Date().toISOString() }]);
  }
  return getJSON(`/api/events?${tokenQS()}cluster=${encodeURIComponent(cluster)}&ns=${encodeURIComponent(ns)}&pod=${encodeURIComponent(pod)}`);
}

const wsURL = (path, params) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?${tokenQS()}${new URLSearchParams(params)}`;

/** A socket-like object: { send(obj), close(), onmessage(data), onclose() } */
function fakeSocket() {
  const s = { onmessage: null, onclose: null, timers: [], closed: false };
  s.emit = (d) => !s.closed && s.onmessage?.(d);
  s.close = () => { if (s.closed) return; s.closed = true; s.timers.forEach(clearInterval); s.onclose?.(); };
  return s;
}

export function openLogs(params) {
  if (!staticMode) return realSocket(wsURL('/ws/logs', params));
  const s = fakeSocket();
  setTimeout(() => {
    const prev = params.previous === '1';
    const lines = [];
    for (let i = 0; i < Math.min(Number(params.tail), 200); i++) { const l = demoLogLine(params.pod, params.container, i, prev); if (l) lines.push(l); }
    s.emit(lines.join('\n') + '\n');
    if (params.follow === '1' && !prev) { let i = 200; s.timers.push(setInterval(() => s.emit(demoLogLine(params.pod, params.container, i++).replace(/^\S+/, new Date().toISOString()) + '\n'), 900)); }
  }, 150);
  s.send = () => {};
  return s;
}

export function openExec(params) {
  if (!staticMode) return realSocket(wsURL('/ws/exec', params), true);
  const s = fakeSocket();
  const prompt = `\x1b[32m${params.container}@${params.pod.slice(0, 28)}\x1b[0m:\x1b[34m/app\x1b[0m$ `;
  let buf = '';
  setTimeout(() => s.emit(`\x1b[90m[preview] simulated shell for ${params.ns}/${params.pod}. Type "help".\x1b[0m\r\n${prompt}`), 100);
  s.send = (m) => {
    if (m.type !== 'stdin') return;
    for (const ch of m.data) {
      if (ch === '\r') { const out = demoShell(params.pod, params.container, buf); buf = ''; if (out === null) { s.emit('\r\nexit\r\n'); return s.close(); } s.emit('\r\n' + (out ? out.replace(/\n/g, '\r\n') + '\r\n' : '') + prompt); }
      else if (ch === '\x7f') { if (buf) { buf = buf.slice(0, -1); s.emit('\b \b'); } }
      else if (ch === '\x03') { buf = ''; s.emit('^C\r\n' + prompt); }
      else if (ch >= ' ') { buf += ch; s.emit(ch); }
    }
  };
  return s;
}

export function openKubectl(cluster) {
  if (!staticMode) return realSocket(wsURL('/ws/kubectl', { cluster }));
  const s = fakeSocket();
  s.send = async (m) => {
    const snap = await snapshot(cluster);
    let args = m.cmd.trim().split(/\s+/); if (args[0] === 'kubectl') args = args.slice(1);
    setTimeout(() => { s.emit(JSON.stringify({ type: 'out', data: fakeKubectl(snap, args) })); s.emit(JSON.stringify({ type: 'exit', code: 0 })); }, 120);
  };
  return s;
}

function realSocket(url, binary = false) {
  const ws = new WebSocket(url);
  if (binary) ws.binaryType = 'arraybuffer';
  const s = { onmessage: null, onclose: null, queue: [] };
  ws.onopen = () => { s.queue.forEach((m) => ws.send(m)); s.queue = []; };
  ws.onmessage = (e) => s.onmessage?.(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
  ws.onclose = () => s.onclose?.();
  s.send = (obj) => { const m = JSON.stringify(obj); ws.readyState === 1 ? ws.send(m) : s.queue.push(m); };
  s.close = () => ws.close();
  return s;
}


// ------------------------------------------------------------------ v0.2: accounts, resources, writes, Secrets Manager
async function send(method, url, body) {
  const sep = url.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${tokenQS() ? sep + tokenQS().slice(0, -1) : ''}`, { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

const previewAccounts = DEMO_CLUSTERS.reduce((acc, c) => {
  if (!acc.find((a) => a.name === c.account)) acc.push({ id: `preview:${c.account}`, source: 'db', name: c.account, accountId: c.accountId, authType: c.account === 'cd-shared' ? 'profile' : 'keys', profile: c.account === 'cd-shared' ? 'cd-shared' : undefined, accessKeyId: c.account === 'cd-shared' ? undefined : 'AKIA…7Q2D', hasSecret: c.account !== 'cd-shared', regions: [c.region], clusters: null, enabled: true, roleArn: '' });
  return acc;
}, []);
const notInPreview = () => Promise.reject(new Error('This is the browser preview. Run the app (npm start) to connect real AWS accounts.'));

export const accounts = {
  list: () => (staticMode ? Promise.resolve(previewAccounts) : send('GET', '/api/accounts')),
  test: (body) => (staticMode ? notInPreview() : send('POST', '/api/accounts/test', body)),
  create: (body) => (staticMode ? notInPreview() : send('POST', '/api/accounts', body)),
  update: (id, body) => (staticMode ? notInPreview() : send('PUT', `/api/accounts/${encodeURIComponent(id)}`, body)),
  remove: (id) => (staticMode ? notInPreview() : send('DELETE', `/api/accounts/${encodeURIComponent(id)}`)),
};

export async function resources(cluster, kind, ns) {
  if (staticMode) return demoResources(await snapshot(cluster), kind, ns);
  return send('GET', `/api/resources?${q({ cluster, kind, ns })}`);
}
export async function resource(cluster, kind, ns, name, reveal) {
  if (staticMode) { const r = demoReadObject(kind, ns, name, reveal); return { ...r, yaml: toYaml(r.object).trimStart() + "\n" }; }
  return send('GET', `/api/resource?${q({ cluster, kind, ns, name, reveal: reveal ? '1' : '' })}`);
}
export function apply(cluster, yaml, { dryRun = false, namespace } = {}) {
  if (staticMode) {
    const docs = yaml.split(/^---\s*$/m).filter((d) => d.trim());
    return Promise.resolve({ demo: true, results: docs.map((d) => ({ kind: (d.match(/^kind:\s*(\S+)/m) || [])[1] || '?', name: (d.match(/^\s+name:\s*(\S+)/m) || [])[1] || '?', namespace: (d.match(/^\s+namespace:\s*(\S+)/m) || [])[1] || namespace || 'default', ok: true, action: dryRun ? 'validated (preview)' : 'applied (preview, nothing changed)' })) });
  }
  return send('POST', '/api/apply', { cluster, yaml, dryRun, namespace });
}
export const remove = (cluster, kind, ns, name) => (staticMode ? Promise.resolve({ ok: true, demo: true, message: `Deleted ${kind} ${name} (preview, nothing changed)` }) : send('POST', '/api/delete', { cluster, kind, ns, name }));
export const workload = (cluster, action, kind, ns, name, replicas) => (staticMode ? Promise.resolve({ ok: true, demo: true, message: `${action} ${kind} ${name} (preview, nothing changed)` }) : send('POST', '/api/workload', { cluster, action, kind, ns, name, replicas }));
export const sm = {
  list: (cluster, region) => (staticMode ? Promise.resolve(DEMO_SM) : send('GET', `/api/sm?${q({ cluster, region })}`)),
  value: (cluster, region, id) => (staticMode ? Promise.resolve(demoSmValue(id)) : send('GET', `/api/sm/value?${q({ cluster, region, id })}`)),
  update: (cluster, region, id, value) => (staticMode ? Promise.resolve({ ok: true, demo: true }) : send('POST', '/api/sm/value', { cluster, region, id, value })),
  create: (cluster, region, body) => (staticMode ? Promise.resolve({ ok: true, demo: true }) : send('POST', '/api/sm/create', { cluster, region, ...body })),
};
export const history = (cluster, days = 30) => (staticMode ? Promise.resolve([]) : send('GET', `/api/history?${q({ cluster, days })}`));
export const auditLog = () => (staticMode ? Promise.resolve([]) : send('GET', '/api/audit?limit=300'));
export const isStatic = () => staticMode;

// Minimal YAML writer for the preview (the server uses the yaml package).
export function toYaml(v, ind = '') {
  if (v == null) return 'null';
  if (Array.isArray(v)) return v.length ? v.map((x) => `\n${ind}- ${typeof x === 'object' && x ? toYaml(x, ind + '  ').trimStart() : scalar(x)}`).join('') : '[]';
  if (typeof v === 'object') {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!ks.length) return '{}';
    return ks.map((k) => { const x = v[k]; return typeof x === 'object' && x && (Array.isArray(x) ? x.length : Object.keys(x).length) ? `\n${ind}${k}:${toYaml(x, ind + '  ')}` : `\n${ind}${k}: ${typeof x === 'object' ? toYaml(x) : scalar(x)}`; }).join('');
  }
  return scalar(v);
  function scalar(x) { if (typeof x === 'string') return /^[\w./:@-]+$/.test(x) && !/^(true|false|null|\d+)$/.test(x) ? x : JSON.stringify(x); return String(x); }
}
