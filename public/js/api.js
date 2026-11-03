// Transport layer. Talks to the EKS Lens server; if no server answers (static preview),
// falls back to the same sample data the server's DEMO_MODE uses, entirely in the browser.
import { analyze } from './shared/model.js';
import { DEMO_CLUSTERS, demoInventory, demoLogLine, demoShell } from './shared/mock.js';
import { fakeKubectl } from './shared/kubectl-demo.js';

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
    return { demo: true, static: true, readOnly: false, user: 'preview', accounts: [...new Set(DEMO_CLUSTERS.map((c) => c.account))] };
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
