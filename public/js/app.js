import * as api from './api.js';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cpu = (c) => (c == null ? '–' : c < 1 ? `${Math.round(c * 1000)}m` : `${c.toFixed(c < 10 ? 2 : 1)}`);
const mem = (g) => (g == null ? '–' : g < 1 ? `${Math.round(g * 1024)}Mi` : `${g.toFixed(g < 10 ? 2 : 1)}Gi`);
const usd = (v, d = 0) => `$${(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usdM = (v) => (v < 10 ? usd(v, 2) : usd(v));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const age = (iso) => { if (!iso) return '–'; const s = (Date.now() - new Date(iso)) / 1000; return s > 86400 ? `${Math.floor(s / 86400)}d` : s > 3600 ? `${Math.floor(s / 3600)}h` : `${Math.max(1, Math.floor(s / 60))}m`; };
const store = { get(k, d) { try { const v = localStorage.getItem('eksl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('eksl.' + k, JSON.stringify(v)); } catch {} } };

const S = {
  meta: null, clusters: [], current: null, snap: null, fleet: null, loading: false, error: null,
  view: store.get('view', 'ns'),
  f: { ns: '', workload: '', q: '', hideSystem: store.get('hideSystem', false), kind: '', status: '' },
  sort: { ns: ['monthly', -1], wl: ['monthly', -1], pods: ['monthly', -1], nodes: ['hourlyPrice', -1] },
  accounts: [], audit: [], cfgKind: store.get('cfgKind', 'secrets'), cfgRows: null, cfgKey: '', smRows: null, smKey: '', smRegion: '',
};
const PAGES = ['fleet', 'accounts', 'activity'];

// ------------------------------------------------------------------ boot
async function boot() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  const font = store.get('font', '');
  if (font) document.documentElement.dataset.font = font;
  $('#fontPick').value = font;
  $('#fontPick').addEventListener('change', (e) => { const v = e.target.value; if (v) document.documentElement.dataset.font = v; else delete document.documentElement.dataset.font; store.set('font', v); activeSession?.fit?.(); });
  S.meta = await api.meta();
  $('#modeTag').textContent = S.meta.static ? 'preview · sample data' : S.meta.demo ? 'demo mode' : '';
  $('#whoami').textContent = S.meta.user && S.meta.user !== 'anonymous' ? S.meta.user : '';
  S.clusters = await api.clusters();
  api.accounts.list().then((a) => { S.accounts = a; $('#acctCount').textContent = a.length; }).catch(() => {});
  renderTree();
  const last = store.get('cluster', null);
  select(S.clusters.find((c) => c.id === last) || PAGES.includes(last) ? last : (S.clusters.length ? 'fleet' : 'accounts'));
  setInterval(() => { if ($('#autoRefresh').checked && !['kubectl', 'config', 'awssec'].includes(S.view) && !PAGES.slice(1).includes(S.current) && $('#modal').hidden) refresh(false); }, 30_000);
}

function renderTree() {
  const by = {};
  for (const c of S.clusters) (by[c.account] ||= []).push(c);
  $('#fleetCount').textContent = S.clusters.filter((c) => c.endpoint !== undefined || c.status === 'ACTIVE').length;
  $('#tree').innerHTML = Object.entries(by).map(([acct, list]) => `
    <div class="acct" role="group">
      <div class="acct-h"><span>${esc(acct)}</span><span>${esc(list[0].accountId || '')}</span></div>
      ${list.map((c) => `
        <button class="cl ${S.current === c.id ? 'active' : ''}" data-id="${esc(c.id)}" role="treeitem" type="button" title="${esc(c.error || c.id)}">
          <span class="dot ${c.status === 'ACTIVE' ? '' : c.status === 'UPDATING' || c.status === 'CREATING' ? 'warn' : c.status === 'EMPTY' ? 'off' : 'err'}"></span>
          <span class="nm">${esc(c.name)}</span>
          <span class="meta">${c.status === 'ERROR' ? 'check the account' : c.status === 'EMPTY' ? esc(c.region) : `${esc(c.region)} · v${esc(c.version || '?')}`}</span>
        </button>`).join('')}
    </div>`).join('');
  $('#fleetBtn').classList.toggle('active', S.current === 'fleet');
  $('#accountsBtn').classList.toggle('active', S.current === 'accounts');
  $('#activityBtn').classList.toggle('active', S.current === 'activity');
}

async function select(id) {
  S.current = id; store.set('cluster', id);
  S.f.ns = ''; S.f.workload = '';
  $('#app').classList.remove('menu-open');
  renderTree();
  await refresh(false);
}

async function refresh(force) {
  S.loading = true; renderHeader();
  try {
    if (S.current === 'fleet') S.fleet = await api.fleet();
    else if (S.current === 'accounts') { S.accounts = await api.accounts.list(); $('#acctCount').textContent = S.accounts.length; }
    else if (S.current === 'activity') S.audit = await api.auditLog();
    else { S.snap = await api.snapshot(S.current, force); if (force) { S.cfgKey = ''; S.smKey = ''; } }
    S.error = null;
  } catch (e) { S.error = e.message; }
  S.loading = false;
  render();
}

// ------------------------------------------------------------------ header + layout
function renderHeader() {
  const c = S.clusters.find((x) => x.id === S.current);
  $('#crumbs').innerHTML = S.current === 'fleet'
    ? `<h1>Fleet overview</h1><span class="chip">${new Set(S.clusters.map((x) => x.account)).size} AWS accounts</span><span class="chip">${S.clusters.filter((x) => x.status === 'ACTIVE').length} EKS clusters</span>`
    : S.current === 'accounts' ? `<h1>AWS accounts</h1><span class="chip">${S.accounts.length} connected</span>`
    : S.current === 'activity' ? '<h1>Activity log</h1><span class="chip">who viewed or changed what</span>'
    : c ? `<h1>${esc(c.name)}</h1><span class="chip">${esc(c.account)} · ${esc(c.accountId)}</span><span class="chip">${esc(c.region)}</span><span class="chip">Kubernetes ${esc(c.version)}</span>` : '';
  $('#updated').textContent = S.loading ? 'Loading…' : S.snap && S.current !== 'fleet' ? `Updated ${new Date(S.snap.generatedAt).toLocaleTimeString()}` : '';
}

function render() {
  renderHeader();
  const el = $('#content');
  if (S.error) { el.innerHTML = `<div class="banner">Could not load data: ${esc(S.error)}. Check the account role, the EKS access entry for the dashboard role, and network reachability to the cluster endpoint.</div>`; return; }
  if (S.current === 'fleet') { el.innerHTML = renderFleet(); return; }
  if (S.current === 'accounts') { el.innerHTML = renderAccounts(); return; }
  if (S.current === 'activity') { el.innerHTML = renderActivity(); return; }
  if (!S.snap) { el.innerHTML = '<div class="empty">Loading cluster…</div>'; return; }
  const t = S.snap.totals;
  const demo = S.meta.demo ? `<div class="banner demo">${S.meta.static ? 'Preview with sample data. Logs, shell and kubectl are simulated. Deploy the server to connect real AWS accounts.' : 'Demo mode: sample data, simulated logs and shell.'}</div>` : '';
  const warns = S.snap.warnings.map((w) => `<div class="banner">${esc(w)}</div>`).join('');
  el.innerHTML = `${demo}${warns}
    <div class="strip">
      ${stat('Namespaces', t.namespaces, `<b>${t.userNamespaces}</b> workload · ${t.namespaces - t.userNamespaces} system`)}
      ${stat('Pods', t.pods, `<b>${t.runningPods}</b> running · <span style="color:${t.unhealthyPods ? 'var(--err)' : 'inherit'}">${t.unhealthyPods} need attention</span>`)}
      ${stat('Deployments', t.deployments, `${t.workloads} workloads incl. StatefulSet/DaemonSet`)}
      ${stat('Nodes', t.nodes, `${t.spotNodes} spot · ${t.nodes - t.spotNodes} on-demand`)}
      ${stat('CPU', `${pct(t.usageCpu, t.capCpu)}%`, `used ${cpu(t.usageCpu)} · requested ${cpu(t.reqCpu)} of ${cpu(t.capCpu)}`, meter(t.usageCpu, t.reqCpu, t.capCpu))}
      ${stat('Memory', `${pct(t.usageMemGiB, t.capMem)}%`, `used ${mem(t.usageMemGiB)} · requested ${mem(t.reqMemGiB)} of ${mem(t.capMem)}`, meter(t.usageMemGiB, t.reqMemGiB, t.capMem))}
      ${stat('Run-rate / month', usd(t.monthly), `${usd(t.hourly, 2)}/hr · idle ${usd(t.idleHourly * 730)}`, '', 'cost')}
    </div>
    ${S.view === 'ns' ? renderFindings() : ''}
    ${renderViewbar()}
    <div id="viewBody">${renderView()}</div>`;
}
const stat = (k, v, s, extra = '', cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div>${extra}</div>`;
const meter = (u, r, cap) => `<div class="meter"><i class="req" style="width:${Math.min(100, pct(r, cap))}%"></i><i style="width:${Math.min(100, pct(u, cap))}%"></i></div>`;

function renderFindings() {
  const list = S.snap.namespaces.flatMap((n) => n.flags.filter((f) => f.level !== 'info' || f.code === 'DEFAULT' || f.code === 'EMPTY').map((f) => ({ ns: n.name, ...f })));
  if (!list.length) return '';
  const order = { error: 0, warn: 1, info: 2 };
  list.sort((a, b) => order[a.level] - order[b.level]);
  return `<div class="findings"><h2>Findings · ${list.length}</h2>${list.slice(0, 8).map((f) => `
    <div class="finding ${f.level}"><span class="bar"></span><button class="ns" data-ns="${esc(f.ns)}" type="button">${esc(f.ns)}</button><span>${esc(f.text)}</span></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ view bar & filters
const VIEWS = [['ns', 'Namespaces'], ['wl', 'Deployments'], ['pods', 'Pods'], ['nodes', 'Nodes'], ['config', 'Config & Secrets'], ['awssec', 'AWS Secrets'], ['cost', 'Cost split'], ['kubectl', 'kubectl']];
function renderViewbar() {
  const nsOpts = S.snap.namespaces.map((n) => `<option value="${esc(n.name)}" ${S.f.ns === n.name ? 'selected' : ''}>${esc(n.name)}${n.isDefault ? ' (default)' : ''}</option>`).join('');
  const showFilters = ['ns', 'wl', 'pods'].includes(S.view);
  const createMenu = S.meta.canWrite ? `<div class="menu" style="margin-left:${showFilters ? '0' : 'auto'}"><button class="btn primary" id="createBtn" type="button" aria-haspopup="true">+ Create</button>
      <div class="menu-list" id="createMenu" hidden>
        <button type="button" data-create="deployment">Deployment<small>Image, replicas, port, resources</small></button>
        <button type="button" data-create="pod">Pod<small>A single pod (debug or one-off)</small></button>
        <button type="button" data-create="secret">Secret<small>Key/value pairs, stored base64</small></button>
        <button type="button" data-create="configmap">ConfigMap<small>Plain configuration values</small></button>
        <button type="button" data-create="namespace">Namespace<small>With team / owner labels</small></button>
        <button type="button" data-create="yaml">From YAML<small>Paste any manifest, validate, apply</small></button>
      </div></div>` : '';
  return `<div class="viewbar">
    <div class="seg" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" data-view="${k}" class="${S.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${showFilters ? '' : createMenu}
    ${showFilters ? `<div class="filters">
      ${S.f.workload ? `<span class="active-filter">${esc(S.f.workload.split('/').slice(1).join('/'))}<button class="ghost" data-clear="workload" type="button" aria-label="Clear workload filter">✕</button></span>` : ''}
      ${S.view !== 'ns' ? `<select id="fNs" aria-label="Namespace"><option value="">All namespaces</option>${nsOpts}</select>` : ''}
      ${S.view === 'wl' ? `<select id="fKind" aria-label="Kind"><option value="">All kinds</option>${['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Pod'].map((k) => `<option ${S.f.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>` : ''}
      ${S.view === 'pods' ? `<select id="fStatus" aria-label="Status"><option value="">Any status</option><option value="ok" ${S.f.status === 'ok' ? 'selected' : ''}>Healthy</option><option value="attn" ${S.f.status === 'attn' ? 'selected' : ''}>Needs attention</option></select>` : ''}
      <label class="switch"><input type="checkbox" id="fSys" ${S.f.hideSystem ? 'checked' : ''}> Hide system</label>
      <input type="search" id="fQ" placeholder="Filter by name or image" value="${esc(S.f.q)}" aria-label="Search">
      ${createMenu}
    </div>` : ''}
  </div>`;
}

function renderView() {
  return ({ ns: viewNamespaces, wl: viewWorkloads, pods: viewPods, nodes: viewNodes, config: viewConfig, awssec: viewAwsSecrets, cost: viewCost, kubectl: viewKubectl }[S.view] || viewNamespaces)();
}

function sortRows(rows, key) {
  const [col, dir] = S.sort[key];
  return [...rows].sort((a, b) => { const x = a[col] ?? -1; const y = b[col] ?? -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
}
const th = (key, col, label, num) => { const [c, d] = S.sort[key]; return `<th class="${num ? 'num' : ''}" data-sort="${key}:${col}">${label}${c === col ? `<span class="arrow"> ${d < 0 ? '↓' : '↑'}</span>` : ''}</th>`; };
const sysFilter = (ns) => !S.f.hideSystem || !S.snap.namespaces.find((n) => n.name === ns)?.isSystem;
const qMatch = (...xs) => !S.f.q || xs.some((x) => String(x || '').toLowerCase().includes(S.f.q.toLowerCase()));

function usage(u, r, l) {
  const top = Math.max(l || 0, r || 0, u || 0) * 1.1 || 1;
  const cls = l && u > l * 0.9 ? 'over' : r && u > r ? 'hot' : '';
  return `<div class="t">${u != null ? `<span class="u ${cls}" style="width:${Math.min(100, (u / top) * 100)}%"></span>` : ''}${r ? `<span class="rq" style="left:${(r / top) * 100}%" title="request"></span>` : ''}</div>`;
}
const useCell = (u, r, l, fmt) => `<td class="use"><div class="lbl"><b>${fmt(u)}</b><span>req ${r ? fmt(r) : '—'}${l ? ` · lim ${fmt(l)}` : ''}</span></div>${usage(u, r, l)}</td>`;
const shareCell = (v, total) => `<td><div class="share"><span class="t"><i style="width:${Math.max(1, pct(v, total))}%"></i></span><span class="num small">${pct(v, total)}%</span></div></td>`;

// ---- Namespace view
function viewNamespaces() {
  const rows = sortRows(S.snap.namespaces.filter((n) => (!S.f.hideSystem || !n.isSystem) && qMatch(n.name)), 'ns');
  const total = S.snap.totals.hourly;
  return `<div class="tbl-wrap"><table><thead><tr>
    ${th('ns', 'name', 'Namespace')}${th('ns', 'podCount', 'Pods', 1)}${th('ns', 'deployments', 'Deploy', 1)}<th class="num">STS / DS</th>${th('ns', 'restarts', 'Restarts', 1)}
    ${th('ns', 'usageCpu', 'CPU used')}${th('ns', 'usageMemGiB', 'Memory used')}${th('ns', 'monthly', 'Cost / month', 1)}<th>Share of cluster</th>
  </tr></thead><tbody>${rows.map((n) => `
    <tr class="click" data-goto-ns="${esc(n.name)}">
      <td><span class="name">${esc(n.name)}</span><span class="flags">${n.flags.map((f) => `<span class="flag ${f.level} ${f.code}" title="${esc(f.text)}">${f.code.replace(/_/g, ' ')}</span>`).join('')}</span>
        ${n.labels.team ? `<div class="name-sub">team=${esc(n.labels.team)}</div>` : ''}</td>
      <td class="num">${n.running}<span class="muted">/${n.podCount}</span>${n.failed ? ` <span class="pill error"></span>` : ''}</td>
      <td class="num">${n.deployments}</td><td class="num">${n.statefulSets} / ${n.daemonSets}</td>
      <td class="num ${n.restarts > 10 ? 'cost' : ''}">${n.restarts}</td>
      ${useCell(n.usageCpu, n.reqCpu, 0, cpu)}${useCell(n.usageMemGiB, n.reqMemGiB, 0, mem)}
      <td class="num cost">${usdM(n.monthly)}</td>${shareCell(n.hourly, total)}
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No namespaces match.</td></tr>'}</tbody></table></div>
    <p class="muted small">Click a namespace to see its pods. Hover a flag for details. Share is of the full cluster bill including idle capacity and the control plane.</p>`;
}

// ---- Deployment / workload view
function viewWorkloads() {
  const rows = sortRows(S.snap.workloads.filter((w) => (!S.f.ns || w.namespace === S.f.ns) && (!S.f.kind || w.kind === S.f.kind) && sysFilter(w.namespace) && qMatch(w.name, ...(w.images || []))), 'wl');
  return `<div class="tbl-wrap"><table><thead><tr>
    ${th('wl', 'name', 'Workload')}${th('wl', 'namespace', 'Namespace')}<th>Ready</th>${th('wl', 'podCount', 'Pods', 1)}${th('wl', 'restarts', 'Restarts', 1)}
    ${th('wl', 'usageCpu', 'CPU used')}${th('wl', 'usageMemGiB', 'Memory used')}${th('wl', 'monthly', 'Cost / month', 1)}<th class="num">Actions</th>
  </tr></thead><tbody>${rows.map((w) => `
    <tr class="click" data-goto-wl="${esc(`${w.namespace}/${w.kind}/${w.name}`)}">
      <td><span class="name">${esc(w.name)}</span><div class="name-sub">${esc(w.kind)}${w.images?.[0] ? ` · ${esc(w.images[0])}` : ''}</div></td>
      <td class="name">${esc(w.namespace)}</td>
      <td><span class="pill ${w.health}">${w.desired != null ? `${w.ready}/${w.desired}` : `${w.runningPods}/${w.podCount}`}</span></td>
      <td class="num">${w.podCount}</td><td class="num ${w.restarts > 10 ? 'cost' : ''}">${w.restarts}</td>
      ${useCell(w.usageCpu, w.reqCpu, 0, cpu)}${useCell(w.usageMemGiB, w.reqMemGiB, 0, mem)}
      <td class="num cost">${usdM(w.monthly)}</td>
      <td><div class="acts">${['Deployment', 'StatefulSet', 'DaemonSet'].includes(w.kind) ? `
        <button class="btn sm" data-yaml="${esc(KIND_KEY[w.kind])}|${esc(w.namespace)}|${esc(w.name)}" type="button">YAML</button>
        ${S.meta.canWrite && w.kind !== 'DaemonSet' ? `<button class="btn sm" data-scale="${esc(w.kind)}|${esc(w.namespace)}|${esc(w.name)}|${w.desired ?? 1}" type="button">Scale</button>` : ''}
        ${S.meta.canWrite ? `<button class="btn sm" data-restart="${esc(w.kind)}|${esc(w.namespace)}|${esc(w.name)}" type="button">Restart</button>` : ''}` : ''}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No workloads match.</td></tr>'}</tbody></table></div>
    <p class="muted small">Click a workload to list its pods. Restart does a rolling restart, like <code>kubectl rollout restart</code>.</p>`;
}

// ---- Pod view
function viewPods() {
  const pods = S.snap.pods.map((p) => ({ ...p, monthly: p.hourly * 730, status: p.containers.find((c) => c.state !== 'Running' && c.state !== 'Completed')?.state || p.phase }))
    .filter((p) => (!S.f.ns || p.namespace === S.f.ns) && (!S.f.workload || p.workload === S.f.workload) && sysFilter(p.namespace)
      && (!S.f.status || (S.f.status === 'ok' ? p.health === 'ok' : p.health === 'error' || p.health === 'warn'))
      && qMatch(p.name, p.node, ...p.containers.map((c) => c.image)));
  const rows = sortRows(pods, 'pods');
  return `<div class="tbl-wrap"><table><thead><tr>
    ${th('pods', 'name', 'Pod')}${th('pods', 'namespace', 'Namespace')}${th('pods', 'status', 'Status')}${th('pods', 'restarts', 'Restarts', 1)}
    ${th('pods', 'usageCpu', 'CPU')}${th('pods', 'usageMemGiB', 'Memory')}${th('pods', 'monthly', '$/mo', 1)}${th('pods', 'created', 'Age')}<th class="num">Actions</th>
  </tr></thead><tbody>${rows.slice(0, 500).map((p) => `
    <tr>
      <td><button class="ghost name" style="padding:0;text-align:left" data-pod="${esc(p.namespace)}/${esc(p.name)}" type="button">${esc(p.name)}</button>
        <div class="name-sub">${esc(p.ownerKind || 'Pod')}${p.ownerName ? ` ${esc(p.ownerName)}` : ''} · ${esc(p.node ? p.node.split('.')[0] : 'unscheduled')}${p.containers.length > 1 ? ` · ${p.containers.length} containers` : ''}</div></td>
      <td class="name">${esc(p.namespace)}</td>
      <td><span class="pill ${p.health}">${esc(p.status)}</span></td>
      <td class="num ${p.restarts > 5 ? 'cost' : ''}">${p.restarts}</td>
      ${useCell(p.usageCpu, p.reqCpu, p.limCpu, cpu)}${useCell(p.usageMemGiB, p.reqMemGiB, p.limMemGiB, mem)}
      <td class="num cost">${usdM(p.monthly)}</td><td class="num">${age(p.created)}</td>
      <td><div class="acts">
        <button class="btn sm" data-logs="${esc(p.namespace)}/${esc(p.name)}" type="button">Logs</button>
        <button class="btn sm" data-shell="${esc(p.namespace)}/${esc(p.name)}" type="button" ${p.phase !== 'Running' || !S.meta.canExec ? 'disabled' : ''}>Shell</button>
        <button class="btn sm" data-yaml="pods|${esc(p.namespace)}|${esc(p.name)}" type="button">YAML</button>
        ${S.meta.canWrite ? `<button class="btn sm danger" data-del="pods|${esc(p.namespace)}|${esc(p.name)}" type="button" title="Delete pod (its controller recreates it)">Delete</button>` : ''}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No pods match.</td></tr>'}</tbody></table></div>
    <p class="muted small">${rows.length} pods${rows.length > 500 ? ' (first 500 shown, narrow with filters)' : ''}. Bars show usage against the request marker; amber means above request, red means near the limit.</p>`;
}

// ---- Nodes
function viewNodes() {
  const rows = sortRows(S.snap.nodes.map((n) => ({ ...n, monthly: n.hourlyPrice * 730 })), 'nodes');
  return `<div class="tbl-wrap"><table><thead><tr>
    ${th('nodes', 'name', 'Node')}${th('nodes', 'instanceType', 'Instance')}${th('nodes', 'capacityType', 'Capacity')}${th('nodes', 'pods', 'Pods', 1)}
    ${th('nodes', 'usageCpu', 'CPU')}${th('nodes', 'usageMemGiB', 'Memory')}${th('nodes', 'hourlyPrice', '$/hr', 1)}<th>Price source</th>${th('nodes', 'idleCost', 'Idle $/mo', 1)}${th('nodes', 'created', 'Age')}
  </tr></thead><tbody>${rows.map((n) => `
    <tr><td><span class="name">${esc(n.name.split('.')[0])}</span><div class="name-sub">${esc(n.zone)} · ${esc(n.nodegroup || '–')} · ${esc(n.arch)}</div></td>
      <td class="mono">${esc(n.instanceType)}${n.priceEstimated ? ' <span class="flag warn" title="Price estimated">EST</span>' : ''}</td>
      <td><span class="chip">${esc(n.capacityType)}</span></td><td class="num">${n.pods}</td>
      ${useCell(n.usageCpu, n.reqCpu, n.allocCpu, cpu)}${useCell(n.usageMemGiB, n.reqMemGiB, n.allocMemGiB, mem)}
      <td class="num cost">${usd(n.hourlyPrice, 4)}</td><td class="small ${n.priceEstimated ? 'cost' : 'muted'}">${esc(n.priceSource || (n.priceEstimated ? 'Estimated' : 'Built-in table'))}</td><td class="num">${usd(n.idleCost * 730)}</td><td class="num">${age(n.created)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">For nodes the bar limit is the node's allocatable capacity.</p>`;
}

// ---- Cost split
const PALETTE = ['#5bb6d4', '#e1a94b', '#8fc27a', '#c58bd6', '#ef8b6c', '#6f8fe0', '#d6c35b', '#5fcfb0', '#d77fa1', '#9aa9b5'];
function viewCost() {
  const t = S.snap.totals;
  const ns = S.snap.namespaces.filter((n) => n.hourly > 0);
  const top = ns.slice(0, 9);
  const other = ns.slice(9).reduce((a, n) => a + n.hourly, 0);
  const parts = [...top.map((n, i) => ({ name: n.name, v: n.hourly, c: PALETTE[i] })), ...(other ? [{ name: 'other namespaces', v: other, c: PALETTE[9] }] : []),
    { name: 'idle node capacity', v: t.idleHourly, c: 'var(--line-2)' }, { name: 'EKS control plane', v: t.controlPlaneHourly, c: 'var(--faint)' }];
  const csv = ['namespace,pods,cpu_request_cores,cpu_used_cores,mem_request_gib,mem_used_gib,cost_hourly_usd,cost_monthly_usd,share_pct',
    ...S.snap.namespaces.map((n) => [n.name, n.podCount, n.reqCpu.toFixed(3), (n.usageCpu || 0).toFixed(3), n.reqMemGiB.toFixed(3), (n.usageMemGiB || 0).toFixed(3), n.hourly.toFixed(4), n.monthly.toFixed(2), (n.share * 100).toFixed(1)].join(',')),
    `_idle,,,,,,${t.idleHourly.toFixed(4)},${(t.idleHourly * 730).toFixed(2)},${pct(t.idleHourly, t.hourly)}`,
    `_control_plane,,,,,,${t.controlPlaneHourly.toFixed(4)},${(t.controlPlaneHourly * 730).toFixed(2)},${pct(t.controlPlaneHourly, t.hourly)}`].join('\n');
  window.__csv = csv;
  setTimeout(loadHistory, 0);
  return `<div class="cost-grid">
    <div class="card">
      <div class="section-h">Where the ${usd(t.monthly)} / month goes</div>
      <div class="stack" role="img" aria-label="Cost split by namespace">${parts.map((p) => `<i style="width:${(p.v / t.hourly) * 100}%;background:${p.c}" title="${esc(p.name)} ${usdM(p.v * 730)}"></i>`).join('')}</div>
      <div class="legend">${parts.map((p) => `<span><sw style="background:${p.c}"></sw><em>${esc(p.name)}</em><b class="num cost">${usdM(p.v * 730)}</b></span>`).join('')}</div>
      <div class="tbl-wrap" style="margin-top:14px"><table><thead><tr><th>Line item</th><th class="num">Per hour</th><th class="num">Per day</th><th class="num">Per month</th><th class="num">Share</th></tr></thead><tbody>
        ${S.snap.namespaces.map((n) => `<tr><td class="name">${esc(n.name)}</td><td class="num">${usd(n.hourly, 4)}</td><td class="num">${usd(n.hourly * 24, 2)}</td><td class="num cost">${usdM(n.monthly)}</td><td class="num">${(n.share * 100).toFixed(1)}%</td></tr>`).join('')}
        <tr><td class="name">idle node capacity</td><td class="num">${usd(t.idleHourly, 4)}</td><td class="num">${usd(t.idleHourly * 24, 2)}</td><td class="num cost">${usdM(t.idleHourly * 730)}</td><td class="num">${pct(t.idleHourly, t.hourly)}%</td></tr>
        <tr><td class="name">EKS control plane</td><td class="num">${usd(t.controlPlaneHourly, 4)}</td><td class="num">${usd(t.controlPlaneHourly * 24, 2)}</td><td class="num cost">${usdM(t.controlPlaneHourly * 730)}</td><td class="num">${pct(t.controlPlaneHourly, t.hourly)}%</td></tr>
      </tbody></table></div>
      <div style="margin-top:10px"><button class="btn sm" id="copyCsv" type="button">Copy as CSV</button> <span class="muted small" id="copyMsg"></span></div>
    </div>
    <div class="card method">
      <div class="section-h" style="margin-bottom:8px">How the split is calculated</div>
      <p>Each node's hourly price is divided into a per-vCPU rate and a per-GiB rate, with 1 vCPU-hour priced like ${S.meta.costModel?.cpuToMemCostRatio ?? 7.46} GiB-hours.</p>
      <p>Every running pod is charged <code>max(request, actual usage)</code> for CPU and memory at the rates of the node it runs on, so over-requesting and bursting are both visible.</p>
      <p>Capacity no pod claims is shown as <b>idle</b>. It is the main saving opportunity: right-size requests or let Karpenter consolidate.</p>
      <p>Node prices come from the <b>AWS Price List API</b> for the cluster's region, and spot nodes use the <b>latest real spot price</b> in their Availability Zone. The source of every price is shown on the Nodes tab. Your own rates (Savings Plans, RIs, EDP discount) can be set under <code>settings.costModel.instancePrices</code>.</p>
      <p>Figures are a live run-rate (this moment × 730 h), not an invoice. EBS volumes, load balancers, NAT gateways and data transfer are not included.</p>
      <div id="histBox"><div class="section-h" style="margin:14px 0 4px">Recorded daily cost</div><div class="muted small">Loading…</div></div>
      <p>For invoice-accurate chargeback, enable <b>Split cost allocation data for EKS</b> in your AWS Cost and Usage Report, which tags pod-level cost by namespace in the bill.</p>
    </div></div>`;
}

// ---- kubectl console
let kcSock = null; let kcHist = store.get('kcHist', []); let kcHistIdx = -1;
function viewKubectl() {
  return `<div class="kc"><div class="kc-out" id="kcOut"><span class="muted">kubectl against ${esc(S.snap.cluster.name)} using the dashboard's short-lived EKS token. Read verbs always work; ${S.meta.canWrite ? 'write verbs (scale, rollout, delete, label, create…) are enabled and audited.' : 'write verbs are disabled for you.'}\n\n</span></div>
    <form class="kc-in" id="kcForm"><span>$ kubectl</span><input id="kcIn" autocomplete="off" spellcheck="false" placeholder="get pods -A" aria-label="kubectl arguments"></form></div>
    <div class="hints">${['get ns', 'get pods -A', 'get deploy -A', 'top pods -A', 'top nodes', 'get nodes', 'version'].map((h) => `<button class="btn sm" data-kc="${h}" type="button">${h}</button>`).join('')}</div>`;
}
function kubectlRun(cmd) {
  const out = $('#kcOut'); if (!out) return;
  if (!kcSock || kcSock.cluster !== S.current) {
    kcSock?.close(); kcSock = api.openKubectl(S.current); kcSock.cluster = S.current;
    kcSock.onmessage = (d) => {
      const m = JSON.parse(d); const o = $('#kcOut'); if (!o) return;
      if (m.type === 'exit') { if (m.code) o.insertAdjacentHTML('beforeend', `<span class="err">exit ${m.code}</span>\n`); }
      else o.insertAdjacentHTML('beforeend', m.type === 'err' ? `<span class="err">${esc(m.data)}</span>` : esc(m.data));
      o.scrollTop = o.scrollHeight;
    };
    kcSock.onclose = () => { kcSock = null; };
  }
  out.insertAdjacentHTML('beforeend', `<span class="cmd">$ kubectl ${esc(cmd)}</span>\n`);
  kcHist = [cmd, ...kcHist.filter((x) => x !== cmd)].slice(0, 50); store.set('kcHist', kcHist); kcHistIdx = -1;
  kcSock.send({ type: 'run', cmd });
}

// ---- Fleet
function renderFleet() {
  if (!S.fleet) return '<div class="empty">Loading fleet…</div>';
  const ok = S.fleet.filter((c) => c.totals);
  const sum = (f) => ok.reduce((a, c) => a + f(c.totals), 0);
  return `${S.meta.static ? '<div class="banner demo">Preview with sample data from three AWS accounts. Deploy the server to connect real accounts.</div>' : ''}
    <div class="strip">
      ${stat('AWS accounts', new Set(S.fleet.map((c) => c.account)).size, '')}
      ${stat('EKS clusters', S.fleet.length, `${ok.length} reachable`)}
      ${stat('Namespaces', sum((t) => t.namespaces), `${sum((t) => t.userNamespaces)} workload`)}
      ${stat('Pods', sum((t) => t.pods), `${sum((t) => t.unhealthyPods)} need attention`)}
      ${stat('Nodes', sum((t) => t.nodes), `${sum((t) => t.spotNodes)} spot`)}
      ${stat('Run-rate / month', usd(sum((t) => t.monthly)), `idle ${usd(sum((t) => t.idleHourly) * 730)}`, '', 'cost')}
    </div>
    ${fleetAccountTable()}
    <div class="fleet">${S.fleet.filter((c) => c.status !== 'EMPTY').map((c) => `
      <button class="fcard" ${c.status === 'ACTIVE' ? `data-id="${esc(c.id)}"` : 'data-page="accounts"'} type="button">
        <div class="row"><h3>${esc(c.name)}</h3><span class="chip">${esc(c.account)}</span></div>
        <div class="row muted small"><span>${esc(c.region)} · Kubernetes ${esc(c.version || '?')}</span>${c.defaultInUse ? '<span class="flag warn DEFAULT_IN_USE">DEFAULT IN USE</span>' : ''}</div>
        ${c.totals ? `<div class="row"><span class="big">${usd(c.totals.monthly)}<span class="muted small"> /mo</span></span><span class="muted small" style="align-self:end">${usd(c.totals.idleHourly * 730)} idle</span></div>
        <div class="row small"><span>${c.totals.namespaces} ns · ${c.totals.deployments} deploy · ${c.totals.pods} pods</span><span>${c.totals.nodes} nodes</span></div>
        <div class="small muted">Top: ${c.topNamespaces.map((n) => `${esc(n.name)} ${usd(n.monthly)}`).join(' · ')}</div>`
          : `<div class="small" style="color:var(--err)">${esc(c.error || 'unreachable')}</div>`}
      </button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ pod drawer
async function openPod(ns, name) {
  const p = S.snap.pods.find((x) => x.namespace === ns && x.name === name); if (!p) return;
  $('#drawerTitle').textContent = p.name;
  const body = $('#drawerBody');
  body.innerHTML = `<dl class="kv">
      <dt>Namespace</dt><dd>${esc(p.namespace)}</dd><dt>Owner</dt><dd>${esc(p.ownerKind || 'Pod')} ${esc(p.ownerName || '')}</dd>
      <dt>Node</dt><dd>${esc(p.node || 'unscheduled')}</dd><dt>Pod IP</dt><dd>${esc(p.ip || '–')}</dd>
      <dt>Phase</dt><dd>${esc(p.phase)}${p.reason ? ` (${esc(p.reason)})` : ''}</dd><dt>QoS</dt><dd>${esc(p.qos || '–')}</dd>
      <dt>Cost</dt><dd class="cost">${usd(p.hourly, 4)}/hr · ${usdM(p.hourly * 730)}/mo</dd><dt>Age</dt><dd>${age(p.created)}</dd></dl>
    <div class="section-h">Containers</div>
    ${p.containers.map((c) => `<div class="ctr"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b class="mono">${esc(c.name)}</b><span class="pill ${/Running|Completed/.test(c.state) ? 'ok' : 'error'}">${esc(c.state)} · ${c.restarts} restarts</span></div>
      <div class="name-sub">${esc(c.image)}</div>
      <div class="use"><div class="lbl"><span>CPU <b>${cpu(c.usageCpu)}</b></span><span>req ${cpu(c.reqCpu)} · lim ${c.limCpu ? cpu(c.limCpu) : '—'}</span></div>${usage(c.usageCpu, c.reqCpu, c.limCpu)}</div>
      <div class="use"><div class="lbl"><span>Memory <b>${mem(c.usageMemGiB)}</b></span><span>req ${mem(c.reqMemGiB)} · lim ${c.limMemGiB ? mem(c.limMemGiB) : '—'}</span></div>${usage(c.usageMemGiB, c.reqMemGiB, c.limMemGiB)}</div>
      <div class="acts" style="justify-content:flex-start"><button class="btn sm" data-logs="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" type="button">Logs</button><button class="btn sm" data-logs="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" data-prev="1" type="button">Previous logs</button><button class="btn sm" data-shell="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" type="button" ${p.phase !== 'Running' || !S.meta.canExec ? 'disabled' : ''}>Shell</button></div>
    </div>`).join('')}
    <div class="section-h" style="margin-top:14px">Events</div><div id="evList" class="muted small">Loading…</div>`;
  $('#drawer').hidden = false;
  try {
    const ev = await api.events(S.current, ns, name);
    $('#evList').innerHTML = ev.length ? ev.map((e) => `<div class="ev ${esc(e.type)}"><b>${esc(e.reason)}</b> ×${e.count} · <span class="muted">${age(e.last)} ago</span><div>${esc(e.message)}</div></div>`).join('') : 'No recent events.';
  } catch (e) { $('#evList').textContent = e.message; }
}

// ------------------------------------------------------------------ dock: logs + shells
const sessions = []; let activeSession = null;
function dockShow() { $('#dock').hidden = !sessions.length; renderDockTabs(); }
function renderDockTabs() {
  $('#dockTabs').innerHTML = sessions.map((s) => `<span class="dtab ${s === activeSession ? 'on' : ''}" data-sid="${s.id}" role="tab" tabindex="0"><span class="kind ${s.kind === 'shell' ? 'sh' : ''}">${s.kind === 'shell' ? 'SH' : 'LOG'}</span>${esc(s.pod.length > 34 ? s.pod.slice(0, 32) + '…' : s.pod)}${s.container !== s.pod ? `<span class="muted">/${esc(s.container)}</span>` : ''}<button class="ghost x" data-close="${s.id}" type="button" aria-label="Close tab">✕</button></span>`).join('')
    + '<span class="dock-spacer"></span><button class="ghost" id="dockMin" type="button">Minimize</button>';
  for (const s of sessions) s.el.hidden = s !== activeSession;
}
function activate(s) { activeSession = s; renderDockTabs(); s.onShow?.(); }
function closeSession(id) {
  const i = sessions.findIndex((s) => s.id === id); if (i < 0) return;
  const s = sessions[i]; s.dispose(); s.el.remove(); sessions.splice(i, 1);
  activeSession = sessions[Math.max(0, i - 1)] || null; dockShow(); activeSession?.onShow?.();
}
let sid = 0;
function podContainers(ns, name) { const p = S.snap.pods.find((x) => x.namespace === ns && x.name === name); return p ? p.containers.map((c) => c.name) : []; }

function openLogs(ns, pod, container, previous = false) {
  const containers = podContainers(ns, pod); container ||= containers[0];
  const s = { id: ++sid, kind: 'logs', ns, pod, container, cluster: S.current };
  s.el = document.createElement('div'); s.el.className = 'pane';
  s.el.innerHTML = `<div class="pane-bar">
      <select data-k="container" aria-label="Container">${containers.map((c) => `<option ${c === container ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select data-k="mode" aria-label="Log source"><option value="live" ${!previous ? 'selected' : ''}>Live (follow)</option><option value="current">Current container</option><option value="previous" ${previous ? 'selected' : ''}>Previous container (before restart)</option></select>
      <select data-k="tail" aria-label="Lines"><option value="200">Last 200</option><option value="1000" selected>Last 1,000</option><option value="5000">Last 5,000</option></select>
      <label class="switch"><input type="checkbox" data-k="wrap"> Wrap</label>
      <input type="search" data-k="q" placeholder="Search logs" aria-label="Search logs">
      <span class="grow"></span><span class="live" data-k="live">LIVE</span>
      <button class="btn sm" data-k="pause" type="button">Pause</button><button class="btn sm" data-k="clear" type="button">Clear</button><button class="btn sm" data-k="copy" type="button">Copy</button>
    </div><div class="logs" data-k="out"></div>`;
  $('#dockBody').append(s.el);
  const q = (k) => s.el.querySelector(`[data-k="${k}"]`);
  let lines = []; let partial = ''; let paused = false; let sock = null; let pending = false;
  const paint = () => {
    pending = false; const out = q('out'); const needle = q('q').value.toLowerCase();
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const shown = (needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines).slice(-5000);
    out.innerHTML = shown.map((l) => { const lvl = (l.match(/\b(ERROR|WARN|DEBUG|FATAL)\b/) || [])[1] || ''; let h = esc(l); if (needle) h = h.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`); return `<div class="${lvl}">${h}</div>`; }).join('');
    if (atBottom || !needle) out.scrollTop = out.scrollHeight;
  };
  const schedule = () => { if (!pending && !paused) { pending = true; requestAnimationFrame(paint); } };
  const connect = () => {
    sock?.close(); lines = []; partial = ''; paint();
    const mode = q('mode').value;
    sock = api.openLogs({ cluster: s.cluster, ns, pod, container: q('container').value, follow: mode === 'live' ? '1' : '0', previous: mode === 'previous' ? '1' : '0', tail: q('tail').value });
    q('live').classList.toggle('on', mode === 'live');
    sock.onmessage = (d) => { const txt = partial + (typeof d === 'string' ? d : new TextDecoder().decode(d)); const parts = txt.split('\n'); partial = parts.pop(); lines.push(...parts); if (lines.length > 20000) lines = lines.slice(-15000); schedule(); };
    sock.onclose = () => { q('live').classList.remove('on'); if (partial) { lines.push(partial); partial = ''; schedule(); } if (!lines.length) { lines.push(mode === 'previous' ? '(no previous container: this container has not restarted, or its old logs were rotated. Use CloudWatch Logs for older history.)' : '(no log output)'); paint(); } };
  };
  ['container', 'mode', 'tail'].forEach((k) => q(k).addEventListener('change', connect));
  q('wrap').addEventListener('change', (e) => q('out').classList.toggle('wrap', e.target.checked));
  q('q').addEventListener('input', paint);
  q('pause').addEventListener('click', (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; if (!paused) schedule(); });
  q('clear').addEventListener('click', () => { lines = []; paint(); });
  q('copy').addEventListener('click', () => navigator.clipboard?.writeText(lines.join('\n')).catch(() => {}));
  s.dispose = () => sock?.close();
  sessions.push(s); dockShow(); activate(s); connect();
}

function openShell(ns, pod, container) {
  if (typeof Terminal === 'undefined') { alertBanner('Terminal library failed to load.'); return; }
  container ||= podContainers(ns, pod)[0];
  const s = { id: ++sid, kind: 'shell', ns, pod, container, cluster: S.current };
  s.el = document.createElement('div'); s.el.className = 'pane';
  s.el.innerHTML = `<div class="pane-bar"><span class="mono">kubectl exec -it -n ${esc(ns)} ${esc(pod)} -c ${esc(container)} -- sh</span><span class="grow"></span><span class="live" data-k="live">CONNECTING</span><button class="btn sm" data-k="re" type="button">Reconnect</button></div><div class="term" data-k="term"></div>`;
  $('#dockBody').append(s.el);
  const term = new Terminal({ cursorBlink: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, Menlo, monospace', fontSize: 13, theme: { background: '#060a11', foreground: '#e3ecf8', cursor: '#33a0ee', selectionBackground: '#0a2a6b' }, scrollback: 5000 });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(s.el.querySelector('[data-k="term"]'));
  let sock = null;
  const live = s.el.querySelector('[data-k="live"]');
  const connect = () => {
    sock?.close(); term.reset();
    sock = api.openExec({ cluster: s.cluster, ns, pod, container });
    live.textContent = 'CONNECTED'; live.classList.add('on');
    sock.onmessage = (d) => term.write(d);
    sock.onclose = () => { live.textContent = 'CLOSED'; live.classList.remove('on'); term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n'); };
    setTimeout(() => { try { fit.fit(); } catch {} sock.send({ type: 'resize', cols: term.cols, rows: term.rows }); term.focus(); }, 50);
  };
  term.onData((data) => sock?.send({ type: 'stdin', data }));
  term.onResize(({ cols, rows }) => sock?.send({ type: 'resize', cols, rows }));
  s.el.querySelector('[data-k="re"]').addEventListener('click', connect);
  s.onShow = () => setTimeout(() => { try { fit.fit(); } catch {} term.focus(); }, 30);
  s.fit = () => { try { fit.fit(); } catch {} };
  s.dispose = () => { sock?.close(); term.dispose(); };
  sessions.push(s); dockShow(); activate(s); connect();
}
function alertBanner(msg) { $('#content').insertAdjacentHTML('afterbegin', `<div class="banner">${esc(msg)}</div>`); }

// ================================================================== v0.2: manage
const KIND_KEY = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Pod: 'pods', Secret: 'secrets', ConfigMap: 'configmaps', Namespace: 'namespaces' };
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'ca-central-1', 'sa-east-1', 'me-central-1'];
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const nsOptions = (sel) => (S.snap?.namespaces || []).map((n) => `<option ${n.name === sel ? 'selected' : ''}>${esc(n.name)}</option>`).join('');

// ---- toasts & modal
function toast(msg, bad = false) {
  const el = document.createElement('div'); el.className = `toast ${bad ? 'bad' : ''}`; el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), bad ? 9000 : 4500);
}
let modalOnClose = null;
function openModal(html, { wide = false, onClose } = {}) {
  const card = $('#modalCard'); card.className = `modal-card ${wide ? 'wide' : ''}`; card.innerHTML = html;
  $('#modal').hidden = false; modalOnClose = onClose || null;
  setTimeout(() => card.querySelector('[autofocus], input:not([type=hidden]), textarea, select')?.focus(), 30);
  return card;
}
function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; modalOnClose?.(); modalOnClose = null; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
function confirmModal({ title, body, confirm = 'Confirm', danger = false, typeToConfirm }) {
  return new Promise((resolve) => {
    const card = openModal(`<header><h3>${esc(title)}</h3><button class="ghost" data-mclose type="button">Close</button></header>
      <div class="body"><p style="margin-top:0">${body}</p>${typeToConfirm ? `<label class="field"><span>Type <b class="mono">${esc(typeToConfirm)}</b> to confirm</span><input id="cfType" autocomplete="off" autofocus></label>` : ''}</div>
      <footer><button class="btn" data-mclose type="button">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="cfOk" type="button" ${typeToConfirm ? 'disabled' : ''}>${esc(confirm)}</button></footer>`,
    { onClose: () => resolve(false) });
    card.querySelector('#cfType')?.addEventListener('input', (e) => { card.querySelector('#cfOk').disabled = e.target.value !== typeToConfirm; });
    card.querySelector('#cfOk').addEventListener('click', () => { modalOnClose = null; closeModal(); resolve(true); });
  });
}

// ---- after a change: refresh the cluster data
async function afterChange(msg) {
  if (msg) toast(msg);
  S.cfgKey = ''; S.smKey = '';
  await refresh(true);
}

// ================================================================== Accounts page
function renderAccounts() {
  const list = S.accounts || [];
  const authLabel = { keys: 'Access key', profile: 'AWS CLI profile', default: 'Default credentials' };
  return `<div class="page-h"><div><h2>AWS accounts</h2><div class="muted small">Every account here is scanned for EKS clusters and shown together in the Fleet overview.</div></div>
      <button class="btn primary" data-acc-new type="button">+ Add AWS account</button></div>
    ${S.meta.static ? '<div class="banner demo">Browser preview: these are sample accounts. Run the app to add real ones.</div>' : ''}
    ${list.length ? `<div class="acc-grid">${list.map((a) => {
      const cl = S.clusters.filter((c) => c.account === a.name);
      const bad = cl.find((c) => c.status === 'ERROR');
      return `<div class="acc-card">
        <h3><span>${esc(a.name)}</span>${a.enabled ? (bad ? '<span class="pill error">Sign-in failed</span>' : '<span class="pill ok">Connected</span>') : '<span class="pill done">Disabled</span>'}</h3>
        <div class="row"><span>Account ID</span><span>${esc(a.accountId || '–')}</span></div>
        <div class="row"><span>Sign-in</span><span>${esc(authLabel[a.authType] || a.authType)}${a.profile ? ` · ${esc(a.profile)}` : ''}${a.accessKeyId ? ` · ${esc(a.accessKeyId)}` : ''}</span></div>
        ${a.roleArn ? `<div class="row"><span>Assumes role</span><span>${esc(a.roleArn.split('/').pop())}</span></div>` : ''}
        <div class="row"><span>Regions</span><span>${esc((a.regions || []).join(', '))}</span></div>
        <div class="row"><span>Clusters</span><span>${cl.filter((c) => c.status === 'ACTIVE').map((c) => esc(c.name)).join(', ') || (bad ? '–' : 'none found')}</span></div>
        ${bad ? `<div class="note warn">${esc(bad.error || 'Could not sign in')}</div>` : ''}
        <div class="acts">${a.source === 'db' ? `<button class="btn sm" data-acc-edit="${esc(a.id)}" type="button">Edit</button><button class="btn sm danger" data-acc-del="${esc(a.id)}" type="button">Remove</button>`
          : '<span class="muted small">From config/accounts.yaml</span>'}</div>
      </div>`;
    }).join('')}</div>` : `<div class="card empty">No AWS accounts yet. Add one with an access key or an AWS CLI profile.</div>`}
    <div class="card method" style="margin-top:16px">
      <div class="section-h" style="margin-bottom:8px">What each account needs</div>
      <p>An IAM user or role with read access to EKS (<code>eks:ListClusters</code>, <code>eks:DescribeCluster</code>), plus <code>pricing:GetProducts</code> and <code>ec2:DescribeSpotPriceHistory</code> for live prices, and <code>secretsmanager:ListSecrets</code> / <code>GetSecretValue</code> for the AWS Secrets tab.</p>
      <p>Inside each cluster the same identity needs an <b>EKS access entry</b> (for example <code>AmazonEKSClusterAdminPolicy</code>, or <code>AmazonEKSViewPolicy</code> for read only). See <code>docs/iam-access-key-policy.json</code>.</p>
      <p>Access keys are encrypted (AES-256) in the local database with the key in <code>data/secret.key</code>. Prefer short-lived SSO profiles where you can, and rotate access keys regularly.</p>
    </div>`;
}

function accountForm(a) {
  const isNew = !a;
  a ||= { authType: 'profile', profile: 'agenticai', regions: ['us-east-2'], enabled: true };
  const regs = new Set(a.regions || []);
  const card = openModal(`<header><h3>${isNew ? 'Add AWS account' : `Edit ${esc(a.name)}`}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <form class="body" id="accForm" autocomplete="off">
      <div class="form">
        <label class="field"><span>Display name</span><input name="name" value="${esc(a.name || '')}" placeholder="e.g. agenticai-prod" required></label>
        <label class="field"><span>AWS account ID <small>(optional)</small></span><input name="accountId" value="${esc(a.accountId || '')}" placeholder="203874373290" inputmode="numeric"></label>
        <div class="field full"><span>Sign-in method</span><div class="radio-row">
          <label><input type="radio" name="authType" value="keys" ${a.authType === 'keys' ? 'checked' : ''}> Access key and secret</label>
          <label><input type="radio" name="authType" value="profile" ${a.authType === 'profile' ? 'checked' : ''}> AWS CLI profile (SSO)</label>
          <label><input type="radio" name="authType" value="default" ${a.authType === 'default' ? 'checked' : ''}> Default credentials</label>
        </div></div>
        <label class="field" data-auth="keys"><span>Access key ID</span><input name="accessKeyId" placeholder="${a.accessKeyId ? `${esc(a.accessKeyId)} (leave blank to keep)` : 'AKIA…'}" spellcheck="false"></label>
        <label class="field" data-auth="keys"><span>Secret access key</span><input name="secretAccessKey" type="password" placeholder="${a.hasSecret ? '•••••••• (leave blank to keep)' : ''}" spellcheck="false"></label>
        <label class="field full" data-auth="keys"><span>Session token <small>(only for temporary keys)</small></span><input name="sessionToken" type="password" placeholder="${a.hasSessionToken ? '•••••••• (leave blank to keep)' : 'optional'}" spellcheck="false"></label>
        <label class="field full" data-auth="profile"><span>Profile name in ~/.aws/config</span><input name="profile" value="${esc(a.profile || '')}" placeholder="agenticai"><small>Run <code>aws sso login --profile &lt;name&gt;</code> on this machine first.</small></label>
        <label class="field" ><span>Role to assume <small>(optional)</small></span><input name="roleArn" value="${esc(a.roleArn || '')}" placeholder="arn:aws:iam::222222222222:role/eks-lens-spoke"></label>
        <label class="field"><span>External ID <small>(if the role needs one)</small></span><input name="externalId" value="${esc(a.externalId || '')}" placeholder="eks-lens"></label>
        <div class="field full"><span>Regions to scan</span>
          <div class="radio-row">${['all', ...REGIONS].map((r) => `<label><input type="checkbox" name="regions" value="${r}" ${regs.has(r) ? 'checked' : ''}> ${r === 'all' ? 'All enabled regions' : r}</label>`).join('')}</div>
          <small>"All enabled regions" checks every region (slower first load, needs ec2:DescribeRegions).</small></div>
        <label class="field full"><span>Only these clusters <small>(optional, comma-separated)</small></span><input name="clusters" value="${esc((a.clusters || []).join(', '))}" placeholder="leave empty to show every cluster"></label>
        <label class="switch full"><input type="checkbox" name="enabled" ${a.enabled !== false ? 'checked' : ''}> Enabled</label>
      </div>
      <div id="accTest" style="margin-top:12px"></div>
    </form>
    <footer><span class="grow muted small">Secrets stay on the server, encrypted.</span><button class="btn" id="accTestBtn" type="button">Test connection</button><button class="btn primary" id="accSave" type="button">${isNew ? 'Add account' : 'Save changes'}</button></footer>`, { wide: true });
  const form = card.querySelector('#accForm');
  const syncAuth = () => { const t = form.authType.value; card.querySelectorAll('[data-auth]').forEach((el) => { el.hidden = el.dataset.auth !== t; }); };
  form.addEventListener('change', syncAuth); syncAuth();
  form.roleArn.addEventListener('change', () => { if (form.roleArn.value.trim() && !form.externalId.value.trim()) form.externalId.value = 'eks-lens'; });
  const body = () => {
    const f = new FormData(form);
    return {
      id: a.id, name: (f.get('name') || '').trim(), accountId: (f.get('accountId') || '').trim(), authType: f.get('authType'),
      accessKeyId: (f.get('accessKeyId') || '').trim(), secretAccessKey: f.get('secretAccessKey') || '', sessionToken: f.get('sessionToken') || '',
      profile: (f.get('profile') || '').trim(), roleArn: (f.get('roleArn') || '').trim(), externalId: (f.get('externalId') || '').trim(),
      regions: f.getAll('regions'), clusters: (f.get('clusters') || '').split(',').map((x) => x.trim()).filter(Boolean), enabled: !!f.get('enabled'),
    };
  };
  card.querySelector('#accTestBtn').addEventListener('click', async (e) => {
    const out = card.querySelector('#accTest'); e.target.disabled = true; out.innerHTML = '<div class="note">Signing in and looking for clusters…</div>';
    try {
      const r = await api.accounts.test(body());
      out.innerHTML = `<div class="result">Signed in as ${esc(r.identity.arn)} (account ${esc(r.identity.account)})</div>
        ${r.clusterError ? `<div class="result bad">EKS: ${esc(r.clusterError)}</div>` : `<div class="result">${r.clusters.length ? `Found ${r.clusters.length} cluster(s): ${r.clusters.map((c) => `${esc(c.name)} (${esc(c.region)})`).join(', ')}` : `No EKS clusters in ${esc((r.regionsScanned || []).length > 4 ? `${r.regionsScanned.length} regions` : (r.regionsScanned || []).join(', '))}`}</div>`}`;
      if (!form.accountId.value) form.accountId.value = r.identity.account;
    } catch (err) { out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`; }
    e.target.disabled = false;
  });
  card.querySelector('#accSave').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const b = body();
      if (isNew) await api.accounts.create(b); else await api.accounts.update(a.id, b);
      closeModal(); toast(isNew ? `Added ${b.name}. Looking for clusters…` : `Saved ${b.name}`);
      S.clusters = await api.clusters(true); renderTree(); await refresh(false);
    } catch (err) { card.querySelector('#accTest').innerHTML = `<div class="result bad">${esc(err.message)}</div>`; }
    e.target.disabled = false;
  });
}

// ================================================================== Activity
function renderActivity() {
  const rows = S.audit || [];
  return `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>User</th><th>Event</th><th>Cluster</th><th>Details</th></tr></thead><tbody>
    ${rows.map((r) => { let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch {} const det = Object.entries(d).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      return `<tr><td class="num" style="text-align:left">${esc(fmtDate(r.ts))}</td><td class="mono small">${esc(r.user_name || '–')}</td><td><span class="chip">${esc(r.event)}</span></td><td class="mono small">${esc((r.cluster_id || '').split('/').pop())}</td><td class="mono small" style="word-break:break-all">${esc(det)}</td></tr>`; }).join('')
      || `<tr><td colspan="5" class="empty">${S.meta.static ? 'The activity log is kept by the server; run the app to see it.' : 'Nothing recorded yet.'}</td></tr>`}
  </tbody></table></div><p class="muted small">Every log view, shell session, secret reveal and change is recorded here and in the server's output.</p>`;
}

// ================================================================== Fleet: per-account summary
function fleetAccountTable() {
  const by = {};
  for (const c of S.fleet) {
    const a = (by[c.account] ||= { account: c.account, accountId: c.accountId, clusters: 0, ns: 0, pods: 0, attn: 0, nodes: 0, monthly: 0, idle: 0, errors: 0, findings: 0 });
    if (c.totals) { a.clusters++; a.ns += c.totals.namespaces; a.pods += c.totals.pods; a.attn += c.totals.unhealthyPods; a.nodes += c.totals.nodes; a.monthly += c.totals.monthly; a.idle += c.totals.idleHourly * 730; a.findings += c.findings || 0; }
    else if (c.status === 'ERROR' || c.error) a.errors++;
  }
  const rows = Object.values(by).sort((x, y) => y.monthly - x.monthly);
  if (rows.length < 2 && !rows.some((r) => r.errors)) return '';
  return `<div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr><th>AWS account</th><th class="num">Clusters</th><th class="num">Namespaces</th><th class="num">Pods</th><th class="num">Need attention</th><th class="num">Nodes</th><th class="num">Run-rate / month</th><th class="num">Idle / month</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><span class="name">${esc(r.account)}</span><div class="name-sub">${esc(r.accountId || '')}${r.errors ? ' · <span style="color:var(--err)">sign-in failed</span>' : ''}</div></td>
      <td class="num">${r.clusters}</td><td class="num">${r.ns}</td><td class="num">${r.pods}</td><td class="num ${r.attn ? 'cost' : ''}">${r.attn}</td><td class="num">${r.nodes}</td><td class="num cost">${usd(r.monthly)}</td><td class="num">${usd(r.idle)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ================================================================== Cost history
async function loadHistory() {
  const box = $('#histBox'); if (!box) return;
  try {
    const rows = await api.history(S.current, 30);
    if (!rows.length) { box.innerHTML = `<div class="section-h" style="margin:14px 0 4px">Recorded daily cost</div><div class="muted small">${S.meta.static || S.meta.demo ? 'Saved by the server when it runs against real clusters.' : 'Starts filling in now: one sample per hour while EKS Lens is running.'}</div>`; return; }
    const byHour = {}; for (const r of rows) byHour[r.ts] = (byHour[r.ts] || 0) + Number(r.hourly);
    const byDay = {}; for (const [ts, v] of Object.entries(byHour)) { const d = ts.slice(0, 10); (byDay[d] ||= []).push(v); }
    const days = Object.entries(byDay).map(([d, v]) => ({ d, cost: (v.reduce((a, x) => a + x, 0) / v.length) * 24, n: v.length }));
    const max = Math.max(...days.map((x) => x.cost));
    box.innerHTML = `<div class="section-h" style="margin:14px 0 4px">Recorded daily cost · last ${days.length} day(s)</div>
      <div class="bars">${days.map((x) => `<i style="height:${Math.max(2, (x.cost / max) * 100)}%" title="${x.d}: ${usd(x.cost, 2)} (${x.n} hourly samples)"></i>`).join('')}</div>
      <div class="bars-x"><span>${days[0].d}</span><span>max ${usd(max, 2)}/day</span><span>${days.at(-1).d}</span></div>
      <div class="muted small" style="margin-top:6px">Each day = average of the hourly samples × 24. Hours when EKS Lens was not running are not sampled.</div>`;
  } catch (e) { box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
}

// ================================================================== Config & Secrets view
const CFG_COLS = {
  secrets: [['Type', (r) => `<span class="mono small">${esc(r.type)}</span>`], ['Keys', (r) => keysCell(r.keys)], ['Used by', (r) => usedCell(r.usedBy)]],
  configmaps: [['Keys', (r) => keysCell(r.keys)], ['Used by', (r) => usedCell(r.usedBy)]],
  services: [['Type', (r) => `<span class="chip">${esc(r.type)}</span>`], ['Cluster IP', (r) => `<span class="mono small">${esc(r.clusterIP)}</span>`], ['Ports', (r) => `<span class="mono small">${esc(r.ports)}</span>`], ['External', (r) => `<span class="mono small">${esc(r.external || '–')}</span>`]],
  ingresses: [['Class', (r) => esc(r.className || '–')], ['Hosts', (r) => `<span class="mono small">${esc(r.hosts)}</span>`], ['Address', (r) => `<span class="mono small">${esc(r.address || 'pending')}</span>`], ['TLS', (r) => (r.tls ? 'yes' : 'no')]],
  pvcs: [['Status', (r) => `<span class="pill ${r.status === 'Bound' ? 'ok' : 'warn'}">${esc(r.status)}</span>`], ['Size', (r) => esc(r.capacity || '–')], ['Storage class', (r) => esc(r.storageClass || '–')], ['Access', (r) => `<span class="mono small">${esc(r.accessModes)}</span>`]],
  hpas: [['Target', (r) => `<span class="mono small">${esc(r.target)}</span>`], ['Min / max', (r) => `${r.min} / ${r.max}`], ['Current', (r) => `${r.current ?? '–'} → ${r.desired ?? '–'}`], ['Metrics', (r) => `<span class="mono small">${esc(r.metrics || '–')}</span>`]],
  cronjobs: [['Schedule', (r) => `<span class="mono small">${esc(r.schedule)}</span>`], ['Suspended', (r) => (r.suspend ? '<span class="pill warn">yes</span>' : 'no')], ['Active', (r) => r.active], ['Last run', (r) => (r.lastSchedule ? `${age(r.lastSchedule)} ago` : '–')]],
  jobs: [['Completions', (r) => esc(r.completions)], ['Failed', (r) => `<span class="${r.failed ? 'cost' : ''}">${r.failed}</span>`], ['Owner', (r) => `<span class="mono small">${esc(r.owner || '–')}</span>`]],
  serviceaccounts: [['IAM role (IRSA)', (r) => `<span class="mono small">${esc(r.roleArn || '–')}</span>`]],
  events: [['Type', (r) => `<span class="pill ${r.type === 'Warning' ? 'warn' : 'ok'}">${esc(r.type)}</span>`], ['Object', (r) => `<span class="mono small">${esc(r.object)}</span>`], ['Reason', (r) => esc(r.reason)], ['Message', (r) => `<span class="small">${esc(r.message)}</span>`], ['Count', (r) => r.count]],
};
const keysCell = (keys) => `<div class="keys">${(keys || []).slice(0, 6).map((k) => `<code>${esc(k)}</code>`).join('')}${keys?.length > 6 ? `<span class="muted small">+${keys.length - 6}</span>` : ''}</div>`;
const usedCell = (u) => (u?.length ? `<span class="small">${u.slice(0, 3).map(esc).join(', ')}${u.length > 3 ? ` +${u.length - 3}` : ''}</span>` : '<span class="muted small">not referenced</span>');

function viewConfig() {
  const key = `${S.current}|${S.cfgKind}|${S.f.ns}`;
  if (S.cfgKey !== key) { S.cfgKey = key; S.cfgRows = null; loadConfig(key); }
  const kinds = S.meta.kinds || {};
  const rows = (S.cfgRows || []).filter((r) => sysFilter(r.namespace) && qMatch(r.name, ...(r.keys || []), r.message));
  const cols = CFG_COLS[S.cfgKind] || [];
  const editable = !['events'].includes(S.cfgKind);
  return `<div class="kind-bar">${Object.entries(kinds).map(([k, l]) => `<button type="button" data-cfgkind="${k}" class="${S.cfgKind === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    <div class="viewbar"><div class="filters" style="margin-left:0">
      <select id="cfgNs" aria-label="Namespace"><option value="">All namespaces</option>${nsOptions(S.f.ns)}</select>
      <label class="switch"><input type="checkbox" id="fSys" ${S.f.hideSystem ? 'checked' : ''}> Hide system</label>
      <input type="search" id="fQ" placeholder="Filter by name or key" value="${esc(S.f.q)}" aria-label="Search">
      ${S.meta.canWrite && ['secrets', 'configmaps'].includes(S.cfgKind) ? `<button class="btn" data-create="${S.cfgKind === 'secrets' ? 'secret' : 'configmap'}" type="button">+ New ${S.cfgKind === 'secrets' ? 'secret' : 'ConfigMap'}</button>` : ''}
    </div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Namespace</th>${cols.map(([h]) => `<th>${h}</th>`).join('')}<th>${S.cfgKind === 'events' ? 'Last seen' : 'Age'}</th>${editable ? '<th class="num">Actions</th>' : ''}</tr></thead><tbody>
    ${S.cfgRows == null ? `<tr><td colspan="${cols.length + 4}" class="empty">Loading ${esc(kinds[S.cfgKind] || '')}…</td></tr>`
      : rows.map((r) => `<tr>
        <td>${editable ? `<button class="ghost name" style="padding:0;text-align:left" data-res="${esc(S.cfgKind)}|${esc(r.namespace || '')}|${esc(r.name)}" type="button">${esc(r.name)}</button>` : `<span class="name">${esc(r.object || r.name)}</span>`}</td>
        <td class="name">${esc(r.namespace || '–')}</td>
        ${cols.map(([, f]) => `<td>${f(r)}</td>`).join('')}
        <td class="num">${age(S.cfgKind === 'events' ? r.last : r.created)}</td>
        ${editable ? `<td><div class="acts">
          <button class="btn sm" data-res="${esc(S.cfgKind)}|${esc(r.namespace || '')}|${esc(r.name)}" type="button">${S.cfgKind === 'secrets' ? 'View' : 'YAML'}</button>
          ${S.meta.canWrite ? `<button class="btn sm danger" data-del="${esc(S.cfgKind)}|${esc(r.namespace || '')}|${esc(r.name)}" type="button">Delete</button>` : ''}
        </div></td>` : ''}
      </tr>`).join('') || `<tr><td colspan="${cols.length + 4}" class="empty">No ${esc(kinds[S.cfgKind] || 'items')} found.</td></tr>`}
    </tbody></table></div>
    <p class="muted small">${S.cfgKind === 'secrets' ? 'Secret values stay hidden until you click View → Show values. Every reveal is recorded in the Activity log.' : '&nbsp;'}</p>`;
}
async function loadConfig(key) {
  try {
    const rows = await api.resources(S.current, S.cfgKind, S.f.ns);
    if (S.cfgKey === key) { S.cfgRows = rows; rerenderBody(); }
  } catch (e) { if (S.cfgKey === key) { S.cfgRows = []; rerenderBody(); toast(e.message, true); } }
}

// ---- resource drawer (view / reveal / edit / delete)
async function openResource(kind, ns, name, reveal = false) {
  $('#drawerTitle').textContent = name;
  const body = $('#drawerBody');
  body.innerHTML = '<div class="muted" style="padding:14px 0">Loading…</div>';
  $('#drawer').hidden = false;
  let r;
  try { r = await api.resource(S.current, kind, ns, name, reveal); } catch (e) { body.innerHTML = `<div class="banner">${esc(e.message)}</div>`; return; }
  const o = r.object; const isSecret = kind === 'secrets'; const isCm = kind === 'configmaps';
  const vals = r.values || {};
  body.innerHTML = `<dl class="kv"><dt>Kind</dt><dd>${esc(o.kind)}</dd>${o.metadata?.namespace ? `<dt>Namespace</dt><dd>${esc(o.metadata.namespace)}</dd>` : ''}${o.type ? `<dt>Type</dt><dd>${esc(o.type)}</dd>` : ''}<dt>Created</dt><dd>${esc(fmtDate(o.metadata?.creationTimestamp))}</dd></dl>
    ${isSecret || isCm ? `<div class="section-h" style="display:flex;justify-content:space-between;align-items:center">${isSecret ? 'Values' : 'Data'}
        ${isSecret && r.masked && S.meta.canReveal ? '<button class="btn sm" id="resReveal" type="button">Show values</button>' : ''}</div>
      <div style="display:grid;gap:8px;margin:10px 0 16px">${Object.keys(isSecret ? o.data || {} : vals).map((k) => `<div><div class="mono small muted">${esc(k)}</div>
        <div class="reveal-val">${isSecret && r.masked ? '••••••••' : esc(vals[k] ?? '')}</div></div>`).join('') || '<span class="muted small">No keys.</span>'}</div>` : ''}
    <div class="acts" style="justify-content:flex-start;margin-bottom:12px;flex-wrap:wrap">
      ${S.meta.canWrite && (isSecret || isCm) && (!r.masked || !isSecret) ? `<button class="btn primary sm" id="resEditKv" type="button">Edit values</button>` : ''}
      ${S.meta.canWrite ? `<button class="btn sm" id="resEditYaml" type="button">Edit YAML</button>` : ''}
      <button class="btn sm" id="resCopy" type="button">Copy YAML</button>
      ${S.meta.canWrite ? `<button class="btn sm danger" data-del="${esc(kind)}|${esc(ns)}|${esc(name)}" type="button">Delete</button>` : ''}
    </div>
    ${isSecret && r.masked && S.meta.canWrite ? '<div class="note" style="margin-bottom:10px">Show the values first to edit them in a form.</div>' : ''}
    <textarea class="yaml" readonly aria-label="YAML">${esc(r.yaml)}</textarea>`;
  body.querySelector('#resReveal')?.addEventListener('click', () => openResource(kind, ns, name, true));
  body.querySelector('#resCopy')?.addEventListener('click', () => navigator.clipboard?.writeText(r.yaml).then(() => toast('YAML copied')).catch(() => toast('Copy blocked by the browser', true)));
  body.querySelector('#resEditYaml')?.addEventListener('click', () => {
    if (isSecret && r.masked) return toast('Click "Show values" first, so the YAML has the real values.', true);
    $('#drawer').hidden = true; yamlEditor({ title: `Edit ${o.kind} ${name}`, yaml: r.yaml, namespace: ns });
  });
  body.querySelector('#resEditKv')?.addEventListener('click', () => { $('#drawer').hidden = true; kvForm(isSecret ? 'secret' : 'configmap', { ns, name, type: o.type, values: vals }); });
}

// ---- YAML editor (validate = server dry run, apply = server-side apply)
function yamlEditor({ title, yaml, namespace, hint }) {
  const card = openModal(`<header><h3>${esc(title)}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body">${hint ? `<div class="note" style="margin-bottom:10px">${hint}</div>` : ''}
      <textarea class="yaml" id="yamlText" spellcheck="false" aria-label="YAML">${esc(yaml)}</textarea>
      <div id="yamlOut" style="margin-top:10px"></div></div>
    <footer><span class="grow muted small">Applies like <code>kubectl apply --server-side</code>. Several objects can be separated with <code>---</code>.</span>
      <button class="btn" id="yamlValidate" type="button">Validate</button><button class="btn primary" id="yamlApply" type="button">Apply to ${esc(S.snap?.cluster?.name || 'cluster')}</button></footer>`, { wide: true });
  const run = async (dryRun, btn) => {
    btn.disabled = true; const out = card.querySelector('#yamlOut'); out.innerHTML = '<div class="note">Sending to the cluster…</div>';
    try {
      const r = await api.apply(S.current, card.querySelector('#yamlText').value, { dryRun, namespace });
      out.innerHTML = r.results.map((x) => `<div class="result ${x.ok ? '' : 'bad'}">${esc(x.kind)} ${esc(x.namespace ? x.namespace + '/' : '')}${esc(x.name)}: ${x.ok ? esc(x.action) : esc(x.error)}</div>`).join('');
      if (!dryRun && r.results.every((x) => x.ok)) { closeModal(); await afterChange(`Applied ${r.results.map((x) => `${x.kind} ${x.name}`).join(', ')}${r.demo ? ' (demo)' : ''}`); }
    } catch (e) { out.innerHTML = `<div class="result bad">${esc(e.message)}</div>`; }
    btn.disabled = false;
  };
  card.querySelector('#yamlValidate').addEventListener('click', (e) => run(true, e.target));
  card.querySelector('#yamlApply').addEventListener('click', (e) => run(false, e.target));
  card.querySelector('#yamlText').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const p = t.selectionStart; t.setRangeText('  ', p, t.selectionEnd, 'end'); }
  });
}
const Y = (o) => api.toYaml(o).trimStart() + '\n';

// ---- create forms
const curNs = () => S.f.ns || (S.snap?.namespaces.find((n) => !n.isSystem && !n.isDefault)?.name) || 'default';
const dnsName = (v) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) && v.length <= 63;

function kvRowsHtml(values, area = false) {
  const entries = Object.entries(values || {}); if (!entries.length) entries.push(['', '']);
  return entries.map(([k, v]) => `<div class="kvrow"><input placeholder="KEY" value="${esc(k)}" data-kk spellcheck="false">${area || String(v).includes('\n') ? `<textarea placeholder="value" data-kv spellcheck="false">${esc(v)}</textarea>` : `<input placeholder="value" value="${esc(v)}" data-kv spellcheck="false">`}<button class="btn sm" data-kvdel type="button" aria-label="Remove row">✕</button></div>`).join('');
}
function readKv(card) {
  const out = {};
  card.querySelectorAll('.kvrow').forEach((r) => { const k = r.querySelector('[data-kk]').value.trim(); if (k) out[k] = r.querySelector('[data-kv]').value; });
  return out;
}
function wireKv(card) {
  card.addEventListener('click', (e) => {
    if (e.target.matches('[data-kvdel]')) e.target.closest('.kvrow').remove();
    if (e.target.matches('[data-kvadd]')) e.target.previousElementSibling.insertAdjacentHTML('beforeend', kvRowsHtml({ '': '' }));
  });
}

function kvForm(type, existing) {
  const isSecret = type === 'secret'; const ed = !!existing;
  const card = openModal(`<header><h3>${ed ? 'Edit' : 'New'} ${isSecret ? 'Secret' : 'ConfigMap'}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body"><div class="form">
      <label class="field"><span>Namespace</span><select id="kvNs" ${ed ? 'disabled' : ''}>${nsOptions(existing?.ns || curNs())}</select></label>
      <label class="field"><span>Name</span><input id="kvName" value="${esc(existing?.name || '')}" ${ed ? 'readonly' : ''} placeholder="${isSecret ? 'app-secrets' : 'app-config'}"></label>
      ${isSecret ? `<label class="field full"><span>Type</span><select id="kvType">${['Opaque', 'kubernetes.io/dockerconfigjson', 'kubernetes.io/tls', 'kubernetes.io/basic-auth'].map((t) => `<option ${t === (existing?.type || 'Opaque') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
      <div class="field full"><span>${isSecret ? 'Values (stored base64-encoded by Kubernetes)' : 'Data'}</span><div class="kvrows">${kvRowsHtml(existing?.values)}</div><button class="btn sm" data-kvadd type="button" style="justify-self:start">+ Add key</button></div>
    </div>${isSecret ? '<div class="note" style="margin-top:12px">Kubernetes Secrets are only base64-encoded unless the cluster has envelope encryption with KMS. For sensitive values, consider AWS Secrets Manager with the Secrets Store CSI driver.</div>' : ''}
    <div id="kvOut" style="margin-top:10px"></div></div>
    <footer><span class="grow"></span><button class="btn" id="kvYaml" type="button">Review as YAML</button><button class="btn primary" id="kvSave" type="button">${ed ? 'Save' : 'Create'}</button></footer>`, { wide: true });
  wireKv(card);
  const build = () => {
    const name = card.querySelector('#kvName').value.trim(); const ns = card.querySelector('#kvNs').value;
    if (!dnsName(name.replace(/\./g, 'a'))) throw new Error('Name: lowercase letters, numbers, - and . only.');
    const data = readKv(card);
    if (!Object.keys(data).length) throw new Error('Add at least one key.');
    const o = { apiVersion: 'v1', kind: isSecret ? 'Secret' : 'ConfigMap', metadata: { name, namespace: ns } };
    if (isSecret) { o.type = card.querySelector('#kvType').value; o.stringData = data; } else o.data = data;
    return { yaml: Y(o), ns };
  };
  card.querySelector('#kvYaml').addEventListener('click', () => { try { const b = build(); closeModal(); yamlEditor({ title: `${ed ? 'Edit' : 'New'} ${isSecret ? 'Secret' : 'ConfigMap'}`, yaml: b.yaml, namespace: b.ns }); } catch (e) { card.querySelector('#kvOut').innerHTML = `<div class="result bad">${esc(e.message)}</div>`; } });
  card.querySelector('#kvSave').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const b = build(); const nm = card.querySelector('#kvName').value.trim(); const r = await api.apply(S.current, b.yaml, { namespace: b.ns });
      const bad = r.results.find((x) => !x.ok); if (bad) throw new Error(bad.error);
      closeModal(); await afterChange(`${ed ? 'Saved' : 'Created'} ${isSecret ? 'Secret' : 'ConfigMap'} ${nm}${r.demo ? ' (demo)' : ''}`);
    } catch (err) { card.querySelector('#kvOut').innerHTML = `<div class="result bad">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}

function deploymentForm(podOnly = false) {
  const card = openModal(`<header><h3>New ${podOnly ? 'Pod' : 'Deployment'}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body"><div class="form">
      <label class="field"><span>Namespace</span><select id="dNs">${nsOptions(curNs())}</select></label>
      <label class="field"><span>Name</span><input id="dName" placeholder="my-app" autofocus></label>
      <label class="field full"><span>Container image</span><input id="dImage" placeholder="nginx:1.27 or 123456789012.dkr.ecr.us-east-2.amazonaws.com/app:1.0" spellcheck="false"></label>
      ${podOnly ? `<label class="field full"><span>Command <small>(optional, e.g. sleep 3600)</small></span><input id="dCmd" placeholder="sleep 3600" spellcheck="false"></label>`
        : `<label class="field"><span>Replicas</span><input id="dRep" type="number" min="0" max="100" value="2"></label>`}
      <label class="field"><span>Container port <small>(optional)</small></span><input id="dPort" type="number" min="1" max="65535" placeholder="8080"></label>
      <label class="field"><span>CPU request</span><input id="dCpu" value="100m"></label>
      <label class="field"><span>Memory request</span><input id="dMem" value="128Mi"></label>
      <label class="field"><span>Memory limit</span><input id="dMemL" value="256Mi"></label>
      <label class="field"><span>Image pull secret <small>(optional)</small></span><input id="dPull" placeholder="ecr-pull"></label>
      <div class="field full"><span>Environment variables <small>(optional)</small></span><div class="kvrows">${kvRowsHtml({})}</div><button class="btn sm" data-kvadd type="button" style="justify-self:start">+ Add variable</button></div>
      ${podOnly ? '' : `<label class="field"><span>Expose with a Service</span><select id="dSvc"><option value="">No Service</option><option>ClusterIP</option><option>LoadBalancer</option></select></label>`}
    </div><div id="dOut" style="margin-top:10px"></div></div>
    <footer><span class="grow muted small">Next you can review the YAML before anything is created.</span><button class="btn primary" id="dNext" type="button">Review YAML</button></footer>`, { wide: true });
  wireKv(card);
  card.querySelector('#dNext').addEventListener('click', () => {
    const v = (id) => card.querySelector(id)?.value.trim();
    const name = v('#dName'); const image = v('#dImage'); const ns = v('#dNs');
    const err = !dnsName(name || '') ? 'Name: lowercase letters, numbers and - only (max 63).' : !image ? 'Enter a container image.' : '';
    if (err) { card.querySelector('#dOut').innerHTML = `<div class="result bad">${esc(err)}</div>`; return; }
    const env = Object.entries(readKv(card)).map(([n, value]) => ({ name: n, value }));
    const port = Number(v('#dPort'));
    const container = { name, image, ...(podOnly && v('#dCmd') ? { command: ['/bin/sh', '-c', v('#dCmd')] } : {}),
      ...(port ? { ports: [{ containerPort: port }] } : {}), ...(env.length ? { env } : {}),
      resources: { requests: { cpu: v('#dCpu') || '100m', memory: v('#dMem') || '128Mi' }, limits: { memory: v('#dMemL') || '256Mi' } } };
    const podSpec = { containers: [container], ...(v('#dPull') ? { imagePullSecrets: [{ name: v('#dPull') }] } : {}) };
    const labels = { app: name, 'app.kubernetes.io/managed-by': 'eks-lens' };
    const docs = [];
    if (podOnly) docs.push({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels }, spec: { ...podSpec, restartPolicy: 'Never' } });
    else {
      docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels }, spec: { replicas: Number(v('#dRep') || 1), selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec: podSpec } } });
      if (v('#dSvc')) docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels }, spec: { type: v('#dSvc'), selector: { app: name }, ports: [{ port: 80, targetPort: port || 80 }] } });
    }
    closeModal();
    yamlEditor({ title: `New ${podOnly ? 'Pod' : 'Deployment'}: ${name}`, yaml: docs.map(Y).join('---\n'), namespace: ns, hint: 'Check the YAML, then click Validate to have the cluster check it without creating anything, or Apply to create it.' });
  });
}

function namespaceForm() {
  const card = openModal(`<header><h3>New namespace</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body"><div class="form">
      <label class="field full"><span>Name</span><input id="nName" placeholder="team-payments" autofocus></label>
      <label class="field"><span>Team label</span><input id="nTeam" placeholder="payments"></label>
      <label class="field"><span>Owner label</span><input id="nOwner" placeholder="mohan"></label>
      <label class="field"><span>Cost center <small>(optional)</small></span><input id="nCc" placeholder="cc-1042"></label>
    </div><div class="note" style="margin-top:12px">Team and owner labels clear the NO OWNER flag and let you charge the namespace's cost back.</div><div id="nOut" style="margin-top:10px"></div></div>
    <footer><span class="grow"></span><button class="btn primary" id="nNext" type="button">Review YAML</button></footer>`);
  card.querySelector('#nNext').addEventListener('click', () => {
    const v = (id) => card.querySelector(id).value.trim();
    if (!dnsName(v('#nName'))) { card.querySelector('#nOut').innerHTML = '<div class="result bad">Name: lowercase letters, numbers and - only (max 63).</div>'; return; }
    const labels = Object.fromEntries([['team', v('#nTeam')], ['owner', v('#nOwner')], ['cost-center', v('#nCc')]].filter(([, x]) => x));
    closeModal();
    yamlEditor({ title: `New namespace ${v('#nName')}`, yaml: Y({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: v('#nName'), ...(Object.keys(labels).length ? { labels } : {}) } }) });
  });
}

function scaleForm(kind, ns, name, current) {
  const card = openModal(`<header><h3>Scale ${esc(name)}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body"><label class="field"><span>Replicas (now ${esc(current)})</span><input id="scN" type="number" min="0" max="500" value="${esc(current)}" autofocus></label>
    <p class="muted small">0 stops every pod but keeps the ${esc(kind)}. If an autoscaler (HPA) manages it, the HPA may change this again.</p><div id="scOut"></div></div>
    <footer><button class="btn" data-mclose type="button">Cancel</button><button class="btn primary" id="scOk" type="button">Scale</button></footer>`);
  card.querySelector('#scOk').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api.workload(S.current, 'scale', kind, ns, name, Number(card.querySelector('#scN').value)); closeModal(); await afterChange(r.message); }
    catch (err) { card.querySelector('#scOut').innerHTML = `<div class="result bad">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}

async function deleteFlow(kind, ns, name) {
  const label = { pods: 'pod', secrets: 'Secret', configmaps: 'ConfigMap', services: 'Service', ingresses: 'Ingress', pvcs: 'volume claim', namespaces: 'namespace', deployments: 'Deployment' }[kind] || kind;
  const ok = await confirmModal({
    title: `Delete ${label} ${name}?`, danger: true, confirm: 'Delete',
    body: kind === 'pods' ? `If <b>${esc(name)}</b> belongs to a Deployment or StatefulSet, a new pod replaces it. A bare pod is gone for good.`
      : kind === 'pvcs' ? 'Deleting a volume claim can delete the disk and its data, depending on the storage class reclaim policy.'
        : `This removes <b>${esc(ns ? ns + '/' : '')}${esc(name)}</b> from <b>${esc(S.snap?.cluster?.name)}</b>. Workloads that use it may fail.`,
    typeToConfirm: kind === 'pods' ? null : name,
  });
  if (!ok) return;
  try { const r = await api.remove(S.current, kind, ns, name); $('#drawer').hidden = true; await afterChange(r.message || `Deleted ${name}`); } catch (e) { toast(e.message, true); }
}

// ================================================================== AWS Secrets Manager view
function viewAwsSecrets() {
  const region = S.smRegion || S.snap.cluster.region;
  const key = `${S.current}|${region}`;
  if (S.smKey !== key) { S.smKey = key; S.smRows = null; loadSm(key, region); }
  const rows = (S.smRows || []).filter((r) => qMatch(r.name, r.description));
  return `<div class="viewbar"><div class="filters" style="margin-left:0">
      <span class="chip">${esc(S.snap.cluster.account)}</span>
      <select id="smRegion" aria-label="Region">${[...new Set([S.snap.cluster.region, ...REGIONS])].map((r) => `<option ${r === region ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <input type="search" id="fQ" placeholder="Filter secrets" value="${esc(S.f.q)}" aria-label="Search">
      ${S.meta.canWrite ? '<button class="btn" id="smNew" type="button">+ New AWS secret</button>' : ''}
    </div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Secret</th><th>Rotation</th><th>Last changed</th><th>Last accessed</th><th>Encryption key</th><th>Tags</th><th class="num">Actions</th></tr></thead><tbody>
    ${S.smRows == null ? '<tr><td colspan="7" class="empty">Loading Secrets Manager…</td></tr>' : rows.map((r) => `<tr>
      <td><span class="name">${esc(r.name)}</span>${r.description ? `<div class="name-sub">${esc(r.description)}</div>` : ''}${r.owningService ? `<div class="name-sub">managed by ${esc(r.owningService)}</div>` : ''}</td>
      <td>${r.rotationEnabled ? '<span class="pill ok">on</span>' : '<span class="pill done">off</span>'}</td>
      <td class="num" style="text-align:left">${r.lastChanged ? `${age(r.lastChanged)} ago` : '–'}</td>
      <td class="num" style="text-align:left">${r.lastAccessed ? `${age(r.lastAccessed)} ago` : 'never'}</td>
      <td class="mono small">${esc(r.kmsKeyId)}</td>
      <td>${keysCell(Object.entries(r.tags || {}).map(([k, v]) => `${k}=${v}`))}</td>
      <td><div class="acts">${S.meta.canReveal ? `<button class="btn sm" data-smview="${esc(r.name)}" type="button">Show value</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No secrets in this region.</td></tr>'}
    </tbody></table></div>
    <p class="muted small">Listing is read-only. Each value you open costs AWS $0.05 per 10,000 requests and is recorded in the Activity log.</p>`;
}
async function loadSm(key, region) {
  try { const rows = await api.sm.list(S.current, region); if (S.smKey === key) { S.smRows = rows; rerenderBody(); } }
  catch (e) { if (S.smKey === key) { S.smRows = []; rerenderBody(); toast(`Secrets Manager: ${e.message}`, true); } }
}
async function smValueModal(id) {
  const region = S.smRegion || S.snap.cluster.region;
  const card = openModal(`<header><h3>${esc(id)}</h3><button class="ghost" data-mclose type="button">Close</button></header><div class="body"><div class="muted">Loading…</div></div>`, { wide: true });
  let v;
  try { v = await api.sm.value(S.current, region, id); } catch (e) { card.querySelector('.body').innerHTML = `<div class="banner">${esc(e.message)}</div>`; return; }
  const asText = v.json ? JSON.stringify(v.json, null, 2) : v.raw;
  card.innerHTML = `<header><h3>${esc(id)}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body">
      ${v.json ? `<div style="display:grid;gap:8px;margin-bottom:12px">${Object.entries(v.json).map(([k, x]) => `<div><div class="mono small muted">${esc(k)}</div><div class="reveal-val">${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</div></div>`).join('')}</div>` : ''}
      <label class="field"><span>${v.json ? 'Secret value (JSON)' : 'Secret value'}</span><textarea class="yaml" id="smText" style="min-height:180px" ${S.meta.canWrite && !v.binary ? '' : 'readonly'} spellcheck="false">${esc(asText)}</textarea></label>
      <div class="muted small" style="margin-top:6px">Version ${esc(v.versionId || '')} · ${esc((v.stages || []).join(', '))}</div><div id="smOut" style="margin-top:10px"></div></div>
    <footer><span class="grow"></span><button class="btn" id="smCopy" type="button">Copy</button>${S.meta.canWrite && !v.binary ? '<button class="btn primary" id="smSave" type="button">Save new version</button>' : ''}</footer>`;
  card.querySelector('#smCopy').addEventListener('click', () => navigator.clipboard?.writeText(card.querySelector('#smText').value).then(() => toast('Copied')).catch(() => toast('Copy blocked', true)));
  card.querySelector('#smSave')?.addEventListener('click', async (e) => {
    const val = card.querySelector('#smText').value;
    if (v.json) { try { JSON.parse(val); } catch { card.querySelector('#smOut').innerHTML = '<div class="result bad">This secret was JSON; the new value is not valid JSON.</div>'; return; } }
    e.target.disabled = true;
    try { await api.sm.update(S.current, region, id, v.json ? JSON.stringify(JSON.parse(val)) : val); closeModal(); toast(`Saved a new version of ${id}`); S.smKey = ''; rerenderBody(); }
    catch (err) { card.querySelector('#smOut').innerHTML = `<div class="result bad">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}
function smCreateModal() {
  const region = S.smRegion || S.snap.cluster.region;
  const card = openModal(`<header><h3>New AWS secret in ${esc(region)}</h3><button class="ghost" data-mclose type="button">Close</button></header>
    <div class="body"><div class="form">
      <label class="field full"><span>Name</span><input id="smName" placeholder="prod/my-app/db" autofocus></label>
      <label class="field full"><span>Description <small>(optional)</small></span><input id="smDesc"></label>
      <div class="field full"><span>Key/value pairs (stored as JSON)</span><div class="kvrows">${kvRowsHtml({ username: '', password: '' })}</div><button class="btn sm" data-kvadd type="button" style="justify-self:start">+ Add key</button></div>
    </div><div class="note warn" style="margin-top:12px">Each secret in AWS Secrets Manager costs about $0.40 per month.</div><div id="smcOut" style="margin-top:10px"></div></div>
    <footer><span class="grow"></span><button class="btn primary" id="smcOk" type="button">Create secret</button></footer>`, { wide: true });
  wireKv(card);
  card.querySelector('#smcOk').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api.sm.create(S.current, region, { name: card.querySelector('#smName').value.trim(), description: card.querySelector('#smDesc').value.trim(), value: JSON.stringify(readKv(card)) }); closeModal(); toast('Secret created'); S.smKey = ''; rerenderBody(); }
    catch (err) { card.querySelector('#smcOut').innerHTML = `<div class="result bad">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}

// ================================================================== click routing for v0.2 controls
function handleManageClick(t, e) {
  const d = t.dataset;
  if (t.id === 'accountsBtn') { select('accounts'); return true; }
  if (t.id === 'activityBtn') { select('activity'); return true; }
  if (d.mclose !== undefined) { closeModal(); return true; }
  if (t.id === 'createBtn') { const m = $('#createMenu'); m.hidden = !m.hidden; return true; }
  if (d.create) {
    $('#createMenu')?.setAttribute('hidden', '');
    ({ deployment: () => deploymentForm(false), pod: () => deploymentForm(true), secret: () => kvForm('secret'), configmap: () => kvForm('configmap'), namespace: namespaceForm,
      yaml: () => yamlEditor({ title: 'Apply YAML', namespace: curNs(), yaml: Y({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'example', namespace: curNs() }, data: { KEY: 'value' } }), hint: 'Paste one or more manifests. Objects without a namespace go to the selected namespace.' }) })[d.create]();
    return true;
  }
  if (d.accNew !== undefined) { accountForm(null); return true; }
  if (d.accEdit) { accountForm(S.accounts.find((a) => a.id === d.accEdit)); return true; }
  if (d.accDel) {
    const a = S.accounts.find((x) => x.id === d.accDel);
    confirmModal({ title: `Remove ${a.name}?`, body: 'EKS Lens stops showing this account and deletes its stored keys. Nothing changes in AWS.', confirm: 'Remove', danger: true }).then(async (ok) => {
      if (!ok) return;
      try { await api.accounts.remove(a.id); toast(`Removed ${a.name}`); S.clusters = await api.clusters(true); renderTree(); refresh(false); } catch (err) { toast(err.message, true); }
    });
    return true;
  }
  if (d.cfgkind) { S.cfgKind = d.cfgkind; store.set('cfgKind', S.cfgKind); rerenderBody(); return true; }
  if (d.res) { const [k, ns, name] = d.res.split('|'); openResource(k, ns, name); return true; }
  if (d.yaml) { const [k, ns, name] = d.yaml.split('|'); openResource(k, ns, name); return true; }
  if (d.del) { const [k, ns, name] = d.del.split('|'); deleteFlow(k, ns, name); return true; }
  if (d.scale) { const [k, ns, name, cur] = d.scale.split('|'); scaleForm(k, ns, name, cur); return true; }
  if (d.restart) {
    const [k, ns, name] = d.restart.split('|');
    confirmModal({ title: `Restart ${name}?`, body: `Pods of <b>${esc(name)}</b> are replaced one by one (rolling restart). Use it to pick up a changed Secret or ConfigMap.`, confirm: 'Restart' })
      .then(async (ok) => { if (!ok) return; try { const r = await api.workload(S.current, 'restart', k, ns, name); await afterChange(r.message); } catch (err) { toast(err.message, true); } });
    return true;
  }
  if (d.smview) { smValueModal(d.smview); return true; }
  if (t.id === 'smNew') { smCreateModal(); return true; }
  return false;
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('#createMenu')?.setAttribute('hidden', ''); }, true);
document.addEventListener('change', (e) => {
  if (e.target.id === 'cfgNs') { S.f.ns = e.target.value; rerenderBody(); }
  if (e.target.id === 'smRegion') { S.smRegion = e.target.value; rerenderBody(); }
});

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-goto-ns], [data-goto-wl], th[data-sort], .dtab');
  if (!t) return;
  if (t.dataset.close) { e.stopPropagation(); return closeSession(Number(t.dataset.close)); }
  if (t.classList.contains('dtab')) return activate(sessions.find((s) => s.id === Number(t.dataset.sid)));
  if (t.id === 'dockMin') { $('#dock').hidden = true; return; }
  if (handleManageClick(t, e)) return;
  if (t.dataset.id) return select(t.dataset.id);
  if (t.id === 'fleetBtn') return select('fleet');
  if (t.id === 'refreshBtn') return refresh(true);
  if (t.id === 'menuBtn') return $('#app').classList.toggle('menu-open');
  if (t.id === 'themeBtn') { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; store.set('theme', nx); return; }
  if (t.id === 'drawerClose') { $('#drawer').hidden = true; return; }
  if (t.id === 'copyCsv') { navigator.clipboard?.writeText(window.__csv).then(() => { $('#copyMsg').textContent = 'Copied'; }).catch(() => { $('#copyMsg').textContent = 'Copy blocked by the browser'; }); return; }
  if (t.dataset.view) { S.view = t.dataset.view; store.set('view', S.view); return render(); }
  if (t.dataset.page) return select(t.dataset.page);
  if (t.dataset.sort) { const [key, col] = t.dataset.sort.split(':'); const [c, d] = S.sort[key]; S.sort[key] = [col, c === col ? -d : col === 'name' || col === 'namespace' ? 1 : -1]; return rerenderBody(); }
  if (t.dataset.clear) { S.f[t.dataset.clear] = ''; return render(); }
  if (t.dataset.kc) { kubectlRun(t.dataset.kc); return; }
  if (t.dataset.gotoNs || t.dataset.ns) { S.f.ns = t.dataset.gotoNs || t.dataset.ns; S.f.workload = ''; S.view = 'pods'; return render(); }
  if (t.dataset.gotoWl) { S.f.workload = t.dataset.gotoWl; S.f.ns = t.dataset.gotoWl.split('/')[0]; S.view = 'pods'; return render(); }
  if (t.dataset.pod) { const [ns, ...rest] = t.dataset.pod.split('/'); return openPod(ns, rest.join('/')); }
  if (t.dataset.logs) { const [ns, ...rest] = t.dataset.logs.split('/'); $('#drawer').hidden = true; return openLogs(ns, rest.join('/'), t.dataset.c, t.dataset.prev === '1'); }
  if (t.dataset.shell) { const [ns, ...rest] = t.dataset.shell.split('/'); $('#drawer').hidden = true; return openShell(ns, rest.join('/'), t.dataset.c); }
});
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') $('#drawer').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else $('#drawer').hidden = true; $('#createMenu')?.setAttribute('hidden', ''); }
  if (e.target.id === 'kcIn' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); kcHistIdx = Math.max(-1, Math.min(kcHist.length - 1, kcHistIdx + (e.key === 'ArrowUp' ? 1 : -1))); e.target.value = kcHistIdx < 0 ? '' : kcHist[kcHistIdx];
  }
  if (e.target.classList?.contains('dtab') && e.key === 'Enter') activate(sessions.find((s) => s.id === Number(e.target.dataset.sid)));
});
document.addEventListener('submit', (e) => { if (e.target.id === 'kcForm') { e.preventDefault(); const v = $('#kcIn').value.trim(); if (v) kubectlRun(v); $('#kcIn').value = ''; } });
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'fNs') { S.f.ns = e.target.value; S.f.workload = ''; render(); }
  if (id === 'fKind') { S.f.kind = e.target.value; rerenderBody(); }
  if (id === 'fStatus') { S.f.status = e.target.value; rerenderBody(); }
  if (id === 'fSys') { S.f.hideSystem = e.target.checked; store.set('hideSystem', S.f.hideSystem); rerenderBody(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'fQ') { S.f.q = e.target.value; rerenderBody(); } });
function rerenderBody() {
  const b = $('#viewBody'); if (!b) return;
  const a = document.activeElement; const id = a?.id; const pos = a?.selectionStart;
  b.innerHTML = renderView();
  if (id && b.contains(document.getElementById(id))) { const el = document.getElementById(id); el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch {} }
}

// dock resize
(() => {
  const grip = $('#dockGrip'); let y0 = 0; let h0 = 0;
  const move = (e) => { const h = Math.max(160, Math.min(window.innerHeight * 0.8, h0 + (y0 - e.clientY))); $('#dock').style.height = h + 'px'; activeSession?.fit?.(); };
  grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; h0 = $('#dock').offsetHeight; grip.setPointerCapture(e.pointerId); grip.addEventListener('pointermove', move); });
  grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', move));
  window.addEventListener('resize', () => activeSession?.fit?.());
})();

boot();
