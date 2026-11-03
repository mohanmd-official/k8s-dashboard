// Simulated kubectl output from a snapshot, used only in DEMO_MODE / static preview.
const age = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s > 86400 ? `${Math.floor(s / 86400)}d` : s > 3600 ? `${Math.floor(s / 3600)}h` : `${Math.max(1, Math.floor(s / 60))}m`;
};
function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i] + 3)).join('').trimEnd()).join('\n') + '\n';
}
const RES = { po: 'pods', pod: 'pods', pods: 'pods', ns: 'ns', namespace: 'ns', namespaces: 'ns', deploy: 'deploy', deployment: 'deploy', deployments: 'deploy', no: 'nodes', node: 'nodes', nodes: 'nodes' };

export function fakeKubectl(snap, args) {
  const [verb, res0, ...rest] = args;
  const flags = [res0, ...rest].filter(Boolean);
  const nsIdx = flags.findIndex((a) => a === '-n' || a === '--namespace');
  const all = flags.includes('-A') || flags.includes('--all-namespaces');
  const ns = nsIdx >= 0 ? flags[nsIdx + 1] : 'default';
  const res = RES[res0];
  const name = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '-n' && rest[i - 1] !== '--namespace');
  const inNs = (x) => all || x.namespace === ns;

  if (verb === 'version') return `Client Version: v1.31.2\nServer Version: v${snap.cluster.version}.2-eks-7f9249a\n`;
  if (verb === 'cluster-info') return `Kubernetes control plane is running at https://${snap.cluster.name}.gr7.${snap.cluster.region}.eks.amazonaws.com\n`;
  if (verb === 'get' && res === 'ns') return table([['NAME', 'STATUS', 'AGE'], ...snap.namespaces.map((n) => [n.name, 'Active', age(n.created)])]);
  if (verb === 'get' && res === 'nodes') return table([['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', 'INSTANCE-TYPE', 'CAPACITY'], ...snap.nodes.map((n) => [n.name, n.ready ? 'Ready' : 'NotReady', '<none>', age(n.created), n.kubeletVersion, n.instanceType, n.capacityType])]);
  if (verb === 'get' && res === 'pods') {
    const pods = snap.pods.filter(inNs);
    if (!pods.length) return `No resources found in ${ns} namespace.\n`;
    return table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(flags.includes('wide') || flags.includes('-owide') ? ['IP', 'NODE'] : [])],
      ...pods.map((p) => [...(all ? [p.namespace] : []), p.name, `${p.containers.filter((c) => c.ready).length}/${p.containers.length}`, p.containers.find((c) => c.state !== 'Running')?.state || p.phase, p.restarts, age(p.created), ...(flags.includes('wide') || flags.includes('-owide') ? [p.ip || '<none>', p.node || '<none>'] : [])])]);
  }
  if (verb === 'get' && res === 'deploy') {
    const d = snap.workloads.filter((w) => w.kind === 'Deployment' && inNs(w));
    if (!d.length) return `No resources found in ${ns} namespace.\n`;
    return table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], ...d.map((w) => [...(all ? [w.namespace] : []), w.name, `${w.ready}/${w.desired}`, w.desired, w.ready, age(w.created)])]);
  }
  if (verb === 'top' && res === 'pods') {
    const pods = snap.pods.filter(inNs).filter((p) => p.usageCpu != null);
    return table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)'], ...pods.map((p) => [...(all ? [p.namespace] : []), p.name, `${Math.round(p.usageCpu * 1000)}m`, `${Math.round(p.usageMemGiB * 1024)}Mi`])]);
  }
  if (verb === 'top' && res === 'nodes') return table([['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%'], ...snap.nodes.map((n) => [n.name, `${Math.round(n.usageCpu * 1000)}m`, `${Math.round((n.usageCpu / n.allocCpu) * 100)}%`, `${Math.round(n.usageMemGiB * 1024)}Mi`, `${Math.round((n.usageMemGiB / n.allocMemGiB) * 100)}%`])]);
  if (verb === 'describe' && res === 'pods' && name) {
    const p = snap.pods.find((x) => x.name === name && (x.namespace === ns || nsIdx < 0));
    if (!p) return `Error from server (NotFound): pods "${name}" not found\n`;
    return [`Name:         ${p.name}`, `Namespace:    ${p.namespace}`, `Node:         ${p.node || '<none>'}`, `Status:       ${p.phase}`, `IP:           ${p.ip || ''}`, `QoS Class:    ${p.qos}`, `Controlled By: ${p.ownerKind || '-'}/${p.ownerName || '-'}`, 'Containers:',
      ...p.containers.flatMap((c) => [`  ${c.name}:`, `    Image:    ${c.image}`, `    State:    ${c.state}`, `    Restart Count: ${c.restarts}`, `    Requests: cpu=${Math.round(c.reqCpu * 1000)}m memory=${Math.round(c.reqMemGiB * 1024)}Mi`, `    Limits:   cpu=${Math.round(c.limCpu * 1000)}m memory=${Math.round(c.limMemGiB * 1024)}Mi`])].join('\n') + '\n';
  }
  return `[demo] "${args.join(' ')}" is simulated only for: get ns|pods|deploy|nodes, top pods|nodes, describe pod <name>, version, cluster-info.\n`;
}
