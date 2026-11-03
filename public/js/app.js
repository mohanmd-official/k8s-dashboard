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
};

// ------------------------------------------------------------------ boot
async function boot() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  S.meta = await api.meta();
  $('#modeTag').textContent = S.meta.static ? 'preview · sample data' : S.meta.demo ? 'demo mode' : '';
  $('#whoami').textContent = S.meta.user && S.meta.user !== 'anonymous' ? S.meta.user : '';
  S.clusters = await api.clusters();
  renderTree();
  const last = store.get('cluster', null);
  select(S.clusters.find((c) => c.id === last) ? last : 'fleet');
  setInterval(() => { if ($('#autoRefresh').checked && S.view !== 'kubectl') refresh(false); }, 30_000);
}

function renderTree() {
  const by = {};
  for (const c of S.clusters) (by[c.account] ||= []).push(c);
  $('#fleetCount').textContent = `${S.clusters.length} clusters`;
  $('#tree').innerHTML = Object.entries(by).map(([acct, list]) => `
    <div class="acct" role="group">
      <div class="acct-h"><span>${esc(acct)}</span><span>${esc(list[0].accountId || '')}</span></div>
      ${list.map((c) => `
        <button class="cl ${S.current === c.id ? 'active' : ''}" data-id="${esc(c.id)}" role="treeitem" type="button" title="${esc(c.error || c.id)}">
          <span class="dot ${c.status === 'ACTIVE' ? '' : c.status === 'UPDATING' ? 'warn' : 'err'}"></span>
          <span class="nm">${esc(c.name)}</span>
          <span class="meta">${esc(c.region)} · v${esc(c.version || '?')}</span>
        </button>`).join('')}
    </div>`).join('');
  $('#fleetBtn').classList.toggle('active', S.current === 'fleet');
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
    else S.snap = await api.snapshot(S.current, force);
    S.error = null;
  } catch (e) { S.error = e.message; }
  S.loading = false;
  render();
}

// ------------------------------------------------------------------ header + layout
function renderHeader() {
  const c = S.clusters.find((x) => x.id === S.current);
  $('#crumbs').innerHTML = S.current === 'fleet'
    ? `<h1>Fleet overview</h1><span class="chip">${S.meta.accounts.length} AWS accounts</span><span class="chip">${S.clusters.length} EKS clusters</span>`
    : c ? `<h1>${esc(c.name)}</h1><span class="chip">${esc(c.account)} · ${esc(c.accountId)}</span><span class="chip">${esc(c.region)}</span><span class="chip">Kubernetes ${esc(c.version)}</span>` : '';
  $('#updated').textContent = S.loading ? 'Loading…' : S.snap && S.current !== 'fleet' ? `Updated ${new Date(S.snap.generatedAt).toLocaleTimeString()}` : '';
}

function render() {
  renderHeader();
  const el = $('#content');
  if (S.error) { el.innerHTML = `<div class="banner">Could not load data: ${esc(S.error)}. Check the account role, the EKS access entry for the dashboard role, and network reachability to the cluster endpoint.</div>`; return; }
  if (S.current === 'fleet') { el.innerHTML = renderFleet(); return; }
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
const VIEWS = [['ns', 'Namespaces'], ['wl', 'Deployments'], ['pods', 'Pods'], ['nodes', 'Nodes'], ['cost', 'Cost split'], ['kubectl', 'kubectl']];
function renderViewbar() {
  const nsOpts = S.snap.namespaces.map((n) => `<option value="${esc(n.name)}" ${S.f.ns === n.name ? 'selected' : ''}>${esc(n.name)}${n.isDefault ? ' (default)' : ''}</option>`).join('');
  const showFilters = ['ns', 'wl', 'pods'].includes(S.view);
  return `<div class="viewbar">
    <div class="seg" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" data-view="${k}" class="${S.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${showFilters ? `<div class="filters">
      ${S.f.workload ? `<span class="active-filter">${esc(S.f.workload.split('/').slice(1).join('/'))}<button class="ghost" data-clear="workload" type="button" aria-label="Clear workload filter">✕</button></span>` : ''}
      ${S.view !== 'ns' ? `<select id="fNs" aria-label="Namespace"><option value="">All namespaces</option>${nsOpts}</select>` : ''}
      ${S.view === 'wl' ? `<select id="fKind" aria-label="Kind"><option value="">All kinds</option>${['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Pod'].map((k) => `<option ${S.f.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>` : ''}
      ${S.view === 'pods' ? `<select id="fStatus" aria-label="Status"><option value="">Any status</option><option value="ok" ${S.f.status === 'ok' ? 'selected' : ''}>Healthy</option><option value="attn" ${S.f.status === 'attn' ? 'selected' : ''}>Needs attention</option></select>` : ''}
      <label class="switch"><input type="checkbox" id="fSys" ${S.f.hideSystem ? 'checked' : ''}> Hide system</label>
      <input type="search" id="fQ" placeholder="Filter by name or image" value="${esc(S.f.q)}" aria-label="Search">
    </div>` : ''}
  </div>`;
}

function renderView() {
  return ({ ns: viewNamespaces, wl: viewWorkloads, pods: viewPods, nodes: viewNodes, cost: viewCost, kubectl: viewKubectl }[S.view])();
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
    ${th('wl', 'usageCpu', 'CPU used')}${th('wl', 'usageMemGiB', 'Memory used')}${th('wl', 'monthly', 'Cost / month', 1)}
  </tr></thead><tbody>${rows.map((w) => `
    <tr class="click" data-goto-wl="${esc(`${w.namespace}/${w.kind}/${w.name}`)}">
      <td><span class="name">${esc(w.name)}</span><div class="name-sub">${esc(w.kind)}${w.images?.[0] ? ` · ${esc(w.images[0])}` : ''}</div></td>
      <td class="name">${esc(w.namespace)}</td>
      <td><span class="pill ${w.health}">${w.desired != null ? `${w.ready}/${w.desired}` : `${w.runningPods}/${w.podCount}`}</span></td>
      <td class="num">${w.podCount}</td><td class="num ${w.restarts > 10 ? 'cost' : ''}">${w.restarts}</td>
      ${useCell(w.usageCpu, w.reqCpu, 0, cpu)}${useCell(w.usageMemGiB, w.reqMemGiB, 0, mem)}
      <td class="num cost">${usdM(w.monthly)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No workloads match.</td></tr>'}</tbody></table></div>
    <p class="muted small">Click a workload to list its pods.</p>`;
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
        <button class="btn sm" data-shell="${esc(p.namespace)}/${esc(p.name)}" type="button" ${p.phase !== 'Running' || S.meta.readOnly ? 'disabled' : ''}>Shell</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">No pods match.</td></tr>'}</tbody></table></div>
    <p class="muted small">${rows.length} pods${rows.length > 500 ? ' (first 500 shown, narrow with filters)' : ''}. Bars show usage against the request marker; amber means above request, red means near the limit.</p>`;
}

// ---- Nodes
function viewNodes() {
  const rows = sortRows(S.snap.nodes.map((n) => ({ ...n, monthly: n.hourlyPrice * 730 })), 'nodes');
  return `<div class="tbl-wrap"><table><thead><tr>
    ${th('nodes', 'name', 'Node')}${th('nodes', 'instanceType', 'Instance')}${th('nodes', 'capacityType', 'Capacity')}${th('nodes', 'pods', 'Pods', 1)}
    ${th('nodes', 'usageCpu', 'CPU')}${th('nodes', 'usageMemGiB', 'Memory')}${th('nodes', 'hourlyPrice', '$/hr', 1)}${th('nodes', 'idleCost', 'Idle $/mo', 1)}${th('nodes', 'created', 'Age')}
  </tr></thead><tbody>${rows.map((n) => `
    <tr><td><span class="name">${esc(n.name.split('.')[0])}</span><div class="name-sub">${esc(n.zone)} · ${esc(n.nodegroup || '–')} · ${esc(n.arch)}</div></td>
      <td class="mono">${esc(n.instanceType)}${n.priceEstimated ? ' <span class="flag warn" title="Price estimated">EST</span>' : ''}</td>
      <td><span class="chip">${esc(n.capacityType)}</span></td><td class="num">${n.pods}</td>
      ${useCell(n.usageCpu, n.reqCpu, n.allocCpu, cpu)}${useCell(n.usageMemGiB, n.reqMemGiB, n.allocMemGiB, mem)}
      <td class="num cost">${usd(n.hourlyPrice, 3)}</td><td class="num">${usd(n.idleCost * 730)}</td><td class="num">${age(n.created)}</td></tr>`).join('')}</tbody></table></div>
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
      <p>Spot nodes are priced at the configured discount unless you set an explicit price. Figures are a live run-rate (this moment × 730 h), not an invoice. EBS volumes, load balancers, NAT and data transfer are not included.</p>
      <p>For invoice-accurate chargeback, enable <b>Split cost allocation data for EKS</b> in your AWS Cost and Usage Report, which tags pod-level cost by namespace in the bill.</p>
    </div></div>`;
}

// ---- kubectl console
let kcSock = null; let kcHist = store.get('kcHist', []); let kcHistIdx = -1;
function viewKubectl() {
  return `<div class="kc"><div class="kc-out" id="kcOut"><span class="muted">kubectl against ${esc(S.snap.cluster.name)} using the dashboard's short-lived EKS token. Read verbs are allowed; write verbs need KUBECTL_WRITE=true on the server.\n\n</span></div>
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
    <div class="fleet">${S.fleet.map((c) => `
      <button class="fcard" data-id="${esc(c.id)}" type="button">
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
      <div class="acts" style="justify-content:flex-start"><button class="btn sm" data-logs="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" type="button">Logs</button><button class="btn sm" data-logs="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" data-prev="1" type="button">Previous logs</button><button class="btn sm" data-shell="${esc(ns)}/${esc(name)}" data-c="${esc(c.name)}" type="button" ${p.phase !== 'Running' || S.meta.readOnly ? 'disabled' : ''}>Shell</button></div>
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
  const term = new Terminal({ cursorBlink: true, fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace', fontSize: 13, theme: { background: '#0a0e11', foreground: '#d7e0e5', cursor: '#5bb6d4' }, scrollback: 5000 });
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

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-goto-ns], [data-goto-wl], th[data-sort], .dtab');
  if (!t) return;
  if (t.dataset.close) { e.stopPropagation(); return closeSession(Number(t.dataset.close)); }
  if (t.classList.contains('dtab')) return activate(sessions.find((s) => s.id === Number(t.dataset.sid)));
  if (t.id === 'dockMin') { $('#dock').hidden = true; return; }
  if (t.dataset.id) return select(t.dataset.id);
  if (t.id === 'fleetBtn') return select('fleet');
  if (t.id === 'refreshBtn') return refresh(true);
  if (t.id === 'menuBtn') return $('#app').classList.toggle('menu-open');
  if (t.id === 'themeBtn') { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; store.set('theme', nx); return; }
  if (t.id === 'drawerClose') { $('#drawer').hidden = true; return; }
  if (t.id === 'copyCsv') { navigator.clipboard?.writeText(window.__csv).then(() => { $('#copyMsg').textContent = 'Copied'; }).catch(() => { $('#copyMsg').textContent = 'Copy blocked by the browser'; }); return; }
  if (t.dataset.view) { S.view = t.dataset.view; store.set('view', S.view); return render(); }
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
  if (e.key === 'Escape') $('#drawer').hidden = true;
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
function rerenderBody() { const b = $('#viewBody'); if (b) b.innerHTML = renderView(); }

// dock resize
(() => {
  const grip = $('#dockGrip'); let y0 = 0; let h0 = 0;
  const move = (e) => { const h = Math.max(160, Math.min(window.innerHeight * 0.8, h0 + (y0 - e.clientY))); $('#dock').style.height = h + 'px'; activeSession?.fit?.(); };
  grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; h0 = $('#dock').offsetHeight; grip.setPointerCapture(e.pointerId); grip.addEventListener('pointermove', move); });
  grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', move));
  window.addEventListener('resize', () => activeSession?.fit?.());
})();

boot();
