// Shared, dependency-free analysis used by both the server and the browser preview.
// Input: a normalized raw cluster inventory. Output: the snapshot the UI renders,
// including the per-namespace / per-workload cost split.
//
// Cost model (same idea as OpenCost/Kubecost "allocation"):
//   node $/hr is split into a per-vCPU and a per-GiB rate using cpuToMemCostRatio
//   (1 vCPU-hr = R GiB-hr). Each pod is charged for max(request, actual usage)
//   of CPU and memory on the node it runs on. Whatever is left on a node is "idle".
//   The EKS control plane fee is shown as its own line.

export const SYSTEM_NAMESPACES = /^(kube-system|kube-public|kube-node-lease|amazon-.*|aws-.*|karpenter|kube-.*)$/;
export const CONTROL_PLANE_HOURLY = { standard: 0.10, extended: 0.60 };

const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export function analyze(raw, opts = {}) {
  const ratio = opts.cpuToMemCostRatio ?? 7.46;
  const hoursPerMonth = opts.hoursPerMonth ?? 730;
  const controlPlane = raw.cluster?.supportType === 'EXTENDED' ? CONTROL_PLANE_HOURLY.extended : CONTROL_PLANE_HOURLY.standard;

  // ---- per-node unit rates
  const nodes = raw.nodes.map((n) => {
    const cpuRate = n.hourlyPrice / (n.cpu + n.memGiB / ratio);
    return { ...n, cpuRate, memRate: cpuRate / ratio, allocatedCost: 0, pods: 0, reqCpu: 0, reqMemGiB: 0 };
  });
  const nodeByName = Object.fromEntries(nodes.map((n) => [n.name, n]));

  // ---- per-pod cost
  const pods = raw.pods.map((p) => {
    const node = nodeByName[p.node];
    const reqCpu = sum(p.containers, (c) => c.reqCpu);
    const reqMemGiB = sum(p.containers, (c) => c.reqMemGiB);
    const limCpu = sum(p.containers, (c) => c.limCpu);
    const limMemGiB = sum(p.containers, (c) => c.limMemGiB);
    const usageCpu = p.usageCpu ?? sum(p.containers, (c) => c.usageCpu);
    const usageMemGiB = p.usageMemGiB ?? sum(p.containers, (c) => c.usageMemGiB);
    const restarts = sum(p.containers, (c) => c.restarts);
    let hourly = 0;
    const running = p.phase === 'Running';
    if (node && running) {
      hourly = node.cpuRate * Math.max(reqCpu, usageCpu || 0) + node.memRate * Math.max(reqMemGiB, usageMemGiB || 0);
      node.allocatedCost += hourly;
      node.pods += 1;
      node.reqCpu += reqCpu;
      node.reqMemGiB += reqMemGiB;
    }
    const noRequests = p.containers.some((c) => !c.reqCpu && !c.reqMemGiB);
    const crash = p.containers.some((c) => /CrashLoopBackOff|Error|OOMKilled|ImagePullBackOff|ErrImagePull/.test(c.state || ''));
    return {
      ...p, reqCpu, reqMemGiB, limCpu, limMemGiB, usageCpu, usageMemGiB, restarts, hourly, noRequests,
      health: crash ? 'error' : p.phase === 'Pending' ? 'warn' : p.phase === 'Failed' ? 'error' : p.phase === 'Succeeded' ? 'done' : 'ok',
    };
  });

  for (const n of nodes) {
    n.allocatedCost = Math.min(n.allocatedCost, n.hourlyPrice);
    n.idleCost = Math.max(0, n.hourlyPrice - n.allocatedCost);
  }

  // ---- workloads (Deployment / StatefulSet / DaemonSet / Job / bare Pod)
  const wlKey = (ns, kind, name) => `${ns}/${kind}/${name}`;
  const workloads = new Map();
  for (const w of raw.workloads) {
    workloads.set(wlKey(w.namespace, w.kind, w.name), { ...w, pods: [], hourly: 0 });
  }
  for (const p of pods) {
    const kind = p.ownerKind || 'Pod';
    const name = p.ownerName || p.name;
    const k = wlKey(p.namespace, kind, name);
    if (!workloads.has(k)) workloads.set(k, { kind, name, namespace: p.namespace, desired: null, ready: null, created: p.created, images: [], pods: [], hourly: 0 });
    const w = workloads.get(k);
    w.pods.push(p.name);
    w.hourly += p.hourly;
    p.workload = k;
  }
  const wlList = [...workloads.values()].map((w) => {
    const wp = pods.filter((p) => p.workload === wlKey(w.namespace, w.kind, w.name));
    return {
      ...w,
      podCount: wp.length,
      runningPods: wp.filter((p) => p.phase === 'Running').length,
      restarts: sum(wp, (p) => p.restarts),
      reqCpu: sum(wp, (p) => p.reqCpu), usageCpu: sum(wp, (p) => p.usageCpu),
      reqMemGiB: sum(wp, (p) => p.reqMemGiB), usageMemGiB: sum(wp, (p) => p.usageMemGiB),
      monthly: w.hourly * hoursPerMonth,
      health: wp.some((p) => p.health === 'error') ? 'error' : (w.desired != null && w.ready < w.desired) || wp.some((p) => p.health === 'warn') ? 'warn' : 'ok',
    };
  });

  // ---- namespaces
  const nodesHourly = sum(nodes, (n) => n.hourlyPrice);
  const idleHourly = sum(nodes, (n) => n.idleCost);
  const totalHourly = nodesHourly + controlPlane;

  const namespaces = raw.namespaces.map((ns) => {
    const np = pods.filter((p) => p.namespace === ns.name);
    const nw = wlList.filter((w) => w.namespace === ns.name);
    const hourly = sum(np, (p) => p.hourly);
    const flags = [];
    const isSystem = SYSTEM_NAMESPACES.test(ns.name);
    if (ns.name === 'default') {
      flags.push(np.length
        ? { code: 'DEFAULT_IN_USE', level: 'warn', text: `Default namespace has ${np.length} pod(s). Move workloads to a dedicated namespace for isolation, RBAC and cost ownership.` }
        : { code: 'DEFAULT', level: 'info', text: 'Kubernetes default namespace (empty).' });
    }
    if (isSystem) flags.push({ code: 'SYSTEM', level: 'info', text: 'System / add-on namespace.' });
    if (!np.length && ns.name !== 'default' && !isSystem) flags.push({ code: 'EMPTY', level: 'info', text: 'No pods running. Candidate for clean-up.' });
    const noReq = np.filter((p) => p.noRequests).length;
    if (noReq) flags.push({ code: 'NO_REQUESTS', level: 'warn', text: `${noReq} pod(s) without CPU/memory requests. Cost is based on actual usage only and scheduling is unpredictable.` });
    const bad = np.filter((p) => p.health === 'error').length;
    if (bad) flags.push({ code: 'UNHEALTHY', level: 'error', text: `${bad} pod(s) failing (CrashLoop / Error / ImagePull).` });
    const pend = np.filter((p) => p.phase === 'Pending').length;
    if (pend) flags.push({ code: 'PENDING', level: 'warn', text: `${pend} pod(s) stuck Pending (unschedulable or waiting for capacity).` });
    if (!ns.labels || !Object.keys(ns.labels).some((k) => /team|owner|cost-center|app/.test(k)) ) {
      if (!isSystem && ns.name !== 'default') flags.push({ code: 'NO_OWNER', level: 'info', text: 'No team/owner/cost-center label. Add one for chargeback.' });
    }
    return {
      name: ns.name, created: ns.created, status: ns.status, labels: ns.labels || {},
      isSystem, isDefault: ns.name === 'default', flags,
      podCount: np.length,
      running: np.filter((p) => p.phase === 'Running').length,
      pending: np.filter((p) => p.phase === 'Pending').length,
      failed: np.filter((p) => p.health === 'error').length,
      restarts: sum(np, (p) => p.restarts),
      deployments: nw.filter((w) => w.kind === 'Deployment').length,
      statefulSets: nw.filter((w) => w.kind === 'StatefulSet').length,
      daemonSets: nw.filter((w) => w.kind === 'DaemonSet').length,
      jobs: nw.filter((w) => w.kind === 'Job' || w.kind === 'CronJob').length,
      reqCpu: sum(np, (p) => p.reqCpu), usageCpu: sum(np, (p) => p.usageCpu),
      reqMemGiB: sum(np, (p) => p.reqMemGiB), usageMemGiB: sum(np, (p) => p.usageMemGiB),
      hourly, monthly: hourly * hoursPerMonth, share: totalHourly ? hourly / totalHourly : 0,
    };
  }).sort((a, b) => b.hourly - a.hourly);

  const capCpu = sum(nodes, (n) => n.allocCpu ?? n.cpu);
  const capMem = sum(nodes, (n) => n.allocMemGiB ?? n.memGiB);
  return {
    cluster: raw.cluster,
    generatedAt: raw.generatedAt || new Date().toISOString(),
    metricsAvailable: raw.metricsAvailable !== false,
    warnings: raw.warnings || [],
    totals: {
      namespaces: namespaces.length,
      userNamespaces: namespaces.filter((n) => !n.isSystem).length,
      pods: pods.length,
      runningPods: pods.filter((p) => p.phase === 'Running').length,
      unhealthyPods: pods.filter((p) => p.health === 'error' || p.health === 'warn').length,
      deployments: wlList.filter((w) => w.kind === 'Deployment').length,
      workloads: wlList.length,
      nodes: nodes.length,
      capCpu, capMem,
      reqCpu: sum(pods, (p) => (p.phase === 'Running' ? p.reqCpu : 0)), usageCpu: sum(pods, (p) => p.usageCpu),
      reqMemGiB: sum(pods, (p) => (p.phase === 'Running' ? p.reqMemGiB : 0)), usageMemGiB: sum(pods, (p) => p.usageMemGiB),
      hourly: totalHourly, monthly: totalHourly * hoursPerMonth,
      nodesHourly, idleHourly, controlPlaneHourly: controlPlane,
      allocatedHourly: nodesHourly - idleHourly,
      spotNodes: nodes.filter((n) => n.capacityType === 'SPOT').length,
    },
    nodes, namespaces, workloads: wlList.sort((a, b) => b.hourly - a.hourly), pods,
  };
}
