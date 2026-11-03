// Kubernetes side: one authenticated client per EKS cluster, inventory collection,
// metrics-server usage, and normalization into the shape public/js/shared/model.js expects.
import * as k8s from '@kubernetes/client-node';
import { eksToken } from './aws.js';
import { priceNodes } from './pricing.js';

const clients = new Map(); // clusterId -> { kc, exp }
export const clearKubeClients = () => clients.clear();

export async function kubeConfigFor(cluster, account) {
  const hit = clients.get(cluster.id);
  if (hit && hit.exp > Date.now()) return hit.kc;
  const token = await eksToken(account, cluster.region, cluster.name);
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: cluster.id, server: cluster.endpoint, caData: cluster.caData, skipTLSVerify: false }],
    users: [{ name: 'eks-lens', token }],
    contexts: [{ name: cluster.id, cluster: cluster.id, user: 'eks-lens' }],
    currentContext: cluster.id,
  });
  clients.set(cluster.id, { kc, exp: Date.now() + 10 * 60_000 }); // tokens live 15 min; refresh at 10
  return kc;
}

// ---- quantity parsing
const CPU_SUFFIX = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1 };
const MEM_SUFFIX = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, m: 1e-3, '': 1 };
export function cpuCores(q) {
  if (q == null) return 0;
  const m = String(q).match(/^([0-9.eE+-]+)([num]?)$/);
  return m ? parseFloat(m[1]) * CPU_SUFFIX[m[2]] : 0;
}
export function memGiB(q) {
  if (q == null) return 0;
  const m = String(q).match(/^([0-9.eE+-]+)(Ki|Mi|Gi|Ti|Pi|k|K|M|G|T|P|m)?$/);
  return m ? (parseFloat(m[1]) * MEM_SUFFIX[m[2] || '']) / 2 ** 30 : 0;
}

function containerState(cs) {
  if (!cs) return 'Waiting';
  if (cs.state?.waiting) return cs.state.waiting.reason || 'Waiting';
  if (cs.state?.terminated) return cs.state.terminated.reason || 'Terminated';
  if (cs.lastState?.terminated?.reason === 'OOMKilled' && cs.restartCount > 0) return 'Running (last: OOMKilled)';
  return 'Running';
}

/** Collect a raw, normalized inventory for one cluster. */
export async function collectInventory(cluster, account, settings) {
  const kc = await kubeConfigFor(cluster, account);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const warnings = [];

  const [nsList, nodeList, podList, depList, stsList, dsList, rsList, jobList] = await Promise.all([
    core.listNamespace(), core.listNode(), core.listPodForAllNamespaces(),
    apps.listDeploymentForAllNamespaces(), apps.listStatefulSetForAllNamespaces(),
    apps.listDaemonSetForAllNamespaces(), apps.listReplicaSetForAllNamespaces(),
    batch.listJobForAllNamespaces().catch(() => ({ items: [] })),
  ]);

  // metrics-server (optional)
  let podMetrics = {}; let nodeMetrics = {}; let metricsAvailable = true;
  try {
    const metrics = new k8s.Metrics(kc);
    const [pm, nm] = await Promise.all([metrics.getPodMetrics(), metrics.getNodeMetrics()]);
    for (const m of pm.items) {
      podMetrics[`${m.metadata.namespace}/${m.metadata.name}`] = Object.fromEntries(
        m.containers.map((c) => [c.name, { cpu: cpuCores(c.usage.cpu), mem: memGiB(c.usage.memory) }]));
    }
    for (const m of nm.items) nodeMetrics[m.metadata.name] = { cpu: cpuCores(m.usage.cpu), mem: memGiB(m.usage.memory) };
  } catch (e) {
    metricsAvailable = false;
    warnings.push('metrics-server not reachable: CPU/memory usage unavailable, cost falls back to requests only. Install with: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml (or the EKS metrics-server add-on).');
  }

  // ReplicaSet -> Deployment, Job -> CronJob ownership
  const rsOwner = {};
  for (const rs of rsList.items) {
    const o = rs.metadata.ownerReferences?.find((r) => r.controller);
    if (o) rsOwner[`${rs.metadata.namespace}/${rs.metadata.name}`] = { kind: o.kind, name: o.name };
  }
  const jobOwner = {};
  for (const j of jobList.items) {
    const o = j.metadata.ownerReferences?.find((r) => r.controller);
    if (o) jobOwner[`${j.metadata.namespace}/${j.metadata.name}`] = { kind: o.kind, name: o.name };
  }

  const nodes = nodeList.items.map((n) => {
    const l = n.metadata.labels || {};
    const base = {
      name: n.metadata.name,
      instanceType: l['node.kubernetes.io/instance-type'] || l['beta.kubernetes.io/instance-type'] || 'unknown',
      capacityType: (l['eks.amazonaws.com/capacityType'] || l['karpenter.sh/capacity-type'] || 'ON_DEMAND').toUpperCase().replace('-', '_'),
      zone: l['topology.kubernetes.io/zone'] || '',
      nodegroup: l['eks.amazonaws.com/nodegroup'] || l['karpenter.sh/nodepool'] || (l['eks.amazonaws.com/compute-type'] === 'fargate' ? 'fargate' : ''),
      arch: l['kubernetes.io/arch'] || '',
      cpu: cpuCores(n.status.capacity?.cpu), memGiB: memGiB(n.status.capacity?.memory),
      allocCpu: cpuCores(n.status.allocatable?.cpu), allocMemGiB: memGiB(n.status.allocatable?.memory),
      ready: n.status.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
      created: n.metadata.creationTimestamp,
      kubeletVersion: n.status.nodeInfo?.kubeletVersion,
      usageCpu: nodeMetrics[n.metadata.name]?.cpu ?? null,
      usageMemGiB: nodeMetrics[n.metadata.name]?.mem ?? null,
    };
    if (l['eks.amazonaws.com/compute-type'] === 'fargate') base.capacityType = 'FARGATE';
    return base;
  });
  await priceNodes(nodes, account, cluster.region, settings.costModel);
  const est = [...new Set(nodes.filter((n) => n.priceEstimated && n.capacityType !== 'FARGATE').map((n) => n.instanceType))];
  if (est.length) warnings.push(`Prices for ${est.join(', ')} could not be read from the AWS Price List API and were estimated. Allow pricing:GetProducts and ec2:DescribeSpotPriceHistory for this account, or set them under settings.costModel.instancePrices.`);

  const pods = podList.items.map((p) => {
    const ns = p.metadata.namespace;
    const key = `${ns}/${p.metadata.name}`;
    const owner = p.metadata.ownerReferences?.find((r) => r.controller);
    let ownerKind = owner?.kind; let ownerName = owner?.name;
    if (ownerKind === 'ReplicaSet' && rsOwner[`${ns}/${ownerName}`]) ({ kind: ownerKind, name: ownerName } = rsOwner[`${ns}/${ownerName}`]);
    if (ownerKind === 'Job' && jobOwner[`${ns}/${ownerName}`]) ({ kind: ownerKind, name: ownerName } = jobOwner[`${ns}/${ownerName}`]);
    const usage = podMetrics[key] || {};
    const statuses = Object.fromEntries((p.status.containerStatuses || []).map((s) => [s.name, s]));
    const containers = p.spec.containers.map((c) => {
      const s = statuses[c.name];
      return {
        name: c.name, image: c.image,
        reqCpu: cpuCores(c.resources?.requests?.cpu), reqMemGiB: memGiB(c.resources?.requests?.memory),
        limCpu: cpuCores(c.resources?.limits?.cpu), limMemGiB: memGiB(c.resources?.limits?.memory),
        usageCpu: usage[c.name]?.cpu ?? null, usageMemGiB: usage[c.name]?.mem ?? null,
        ready: !!s?.ready, restarts: s?.restartCount || 0, state: containerState(s),
      };
    });
    const hasUsage = containers.some((c) => c.usageCpu != null);
    const secretRefs = new Set(); const configMapRefs = new Set();
    for (const c of [...(p.spec.containers || []), ...(p.spec.initContainers || [])]) {
      for (const e of c.envFrom || []) { if (e.secretRef?.name) secretRefs.add(e.secretRef.name); if (e.configMapRef?.name) configMapRefs.add(e.configMapRef.name); }
      for (const e of c.env || []) { if (e.valueFrom?.secretKeyRef?.name) secretRefs.add(e.valueFrom.secretKeyRef.name); if (e.valueFrom?.configMapKeyRef?.name) configMapRefs.add(e.valueFrom.configMapKeyRef.name); }
    }
    for (const v of p.spec.volumes || []) {
      if (v.secret?.secretName) secretRefs.add(v.secret.secretName);
      if (v.configMap?.name) configMapRefs.add(v.configMap.name);
      for (const src of v.projected?.sources || []) { if (src.secret?.name) secretRefs.add(src.secret.name); if (src.configMap?.name) configMapRefs.add(src.configMap.name); }
    }
    for (const s of p.spec.imagePullSecrets || []) if (s.name) secretRefs.add(s.name);
    return {
      name: p.metadata.name, namespace: ns, node: p.spec.nodeName || null,
      phase: p.status.phase, reason: p.status.reason, ip: p.status.podIP, qos: p.status.qosClass,
      created: p.metadata.creationTimestamp, ownerKind, ownerName,
      initContainers: (p.spec.initContainers || []).map((c) => c.name),
      serviceAccount: p.spec.serviceAccountName, secretRefs: [...secretRefs], configMapRefs: [...configMapRefs],
      containers,
      usageCpu: hasUsage ? containers.reduce((a, c) => a + (c.usageCpu || 0), 0) : null,
      usageMemGiB: hasUsage ? containers.reduce((a, c) => a + (c.usageMemGiB || 0), 0) : null,
    };
  });

  const wl = (kind, items, desired, ready) => items.map((o) => ({
    kind, name: o.metadata.name, namespace: o.metadata.namespace, created: o.metadata.creationTimestamp,
    desired: desired(o), ready: ready(o),
    images: [...new Set((o.spec.template?.spec?.containers || []).map((c) => c.image))],
  }));
  const workloads = [
    ...wl('Deployment', depList.items, (o) => o.spec.replicas ?? 1, (o) => o.status.readyReplicas || 0),
    ...wl('StatefulSet', stsList.items, (o) => o.spec.replicas ?? 1, (o) => o.status.readyReplicas || 0),
    ...wl('DaemonSet', dsList.items, (o) => o.status.desiredNumberScheduled || 0, (o) => o.status.numberReady || 0),
  ];

  return {
    cluster: { id: cluster.id, name: cluster.name, account: cluster.account, accountId: cluster.accountId, region: cluster.region, version: cluster.version, status: cluster.status, supportType: cluster.supportType },
    generatedAt: new Date().toISOString(),
    metricsAvailable, warnings,
    namespaces: nsList.items.map((n) => ({ name: n.metadata.name, created: n.metadata.creationTimestamp, status: n.status?.phase, labels: n.metadata.labels || {} })),
    nodes, pods, workloads,
  };
}
