// Generic Kubernetes resources: list, read (YAML), apply (create/update), delete, and
// quick actions (scale, restart, cordon). Secret values are masked unless explicitly revealed.
import * as k8s from '@kubernetes/client-node';
import YAML from 'yaml';

export const KINDS = {
  secrets: { apiVersion: 'v1', kind: 'Secret', label: 'Secrets' },
  configmaps: { apiVersion: 'v1', kind: 'ConfigMap', label: 'ConfigMaps' },
  services: { apiVersion: 'v1', kind: 'Service', label: 'Services' },
  ingresses: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', label: 'Ingresses' },
  pvcs: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', label: 'Volumes (PVC)' },
  hpas: { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', label: 'Autoscalers (HPA)' },
  cronjobs: { apiVersion: 'batch/v1', kind: 'CronJob', label: 'CronJobs' },
  jobs: { apiVersion: 'batch/v1', kind: 'Job', label: 'Jobs' },
  serviceaccounts: { apiVersion: 'v1', kind: 'ServiceAccount', label: 'Service accounts' },
  events: { apiVersion: 'v1', kind: 'Event', label: 'Events' },
  deployments: { apiVersion: 'apps/v1', kind: 'Deployment', label: 'Deployments', hidden: true },
  statefulsets: { apiVersion: 'apps/v1', kind: 'StatefulSet', label: 'StatefulSets', hidden: true },
  daemonsets: { apiVersion: 'apps/v1', kind: 'DaemonSet', label: 'DaemonSets', hidden: true },
  pods: { apiVersion: 'v1', kind: 'Pod', label: 'Pods', hidden: true },
  namespaces: { apiVersion: 'v1', kind: 'Namespace', label: 'Namespaces', hidden: true, clusterScoped: true },
  nodes: { apiVersion: 'v1', kind: 'Node', label: 'Nodes', hidden: true, clusterScoped: true },
};
const byKind = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.kind, { key: k, ...v }]));

const age = (o) => o.metadata?.creationTimestamp;
function row(kind, o, usage) {
  const m = o.metadata || {};
  const base = { name: m.name, namespace: m.namespace, created: age(o), labels: m.labels || {} };
  switch (kind) {
    case 'secrets': {
      const keys = Object.keys(o.data || {});
      const used = usage?.secrets?.[`${m.namespace}/${m.name}`] || [];
      return { ...base, type: o.type, keys, keyCount: keys.length, usedBy: used, managedBy: m.labels?.['app.kubernetes.io/managed-by'] || (m.ownerReferences?.[0]?.kind ?? '') };
    }
    case 'configmaps': {
      const keys = [...Object.keys(o.data || {}), ...Object.keys(o.binaryData || {})];
      return { ...base, keys, keyCount: keys.length, usedBy: usage?.configmaps?.[`${m.namespace}/${m.name}`] || [] };
    }
    case 'services':
      return { ...base, type: o.spec.type, clusterIP: o.spec.clusterIP, ports: (o.spec.ports || []).map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(', '),
        external: (o.status?.loadBalancer?.ingress || []).map((i) => i.hostname || i.ip).join(', '), selector: o.spec.selector ? Object.entries(o.spec.selector).map(([k, v]) => `${k}=${v}`).join(',') : '' };
    case 'ingresses':
      return { ...base, className: o.spec.ingressClassName || m.annotations?.['kubernetes.io/ingress.class'] || '', hosts: (o.spec.rules || []).map((r) => r.host || '*').join(', '),
        address: (o.status?.loadBalancer?.ingress || []).map((i) => i.hostname || i.ip).join(', '), tls: !!o.spec.tls?.length };
    case 'pvcs':
      return { ...base, status: o.status?.phase, capacity: o.status?.capacity?.storage || o.spec.resources?.requests?.storage, storageClass: o.spec.storageClassName, volume: o.spec.volumeName, accessModes: (o.spec.accessModes || []).join(',') };
    case 'hpas':
      return { ...base, target: `${o.spec.scaleTargetRef?.kind}/${o.spec.scaleTargetRef?.name}`, min: o.spec.minReplicas ?? 1, max: o.spec.maxReplicas, current: o.status?.currentReplicas, desired: o.status?.desiredReplicas,
        metrics: (o.status?.currentMetrics || []).map((x) => x.resource ? `${x.resource.name} ${x.resource.current?.averageUtilization ?? '?'}%` : x.type).join(', ') };
    case 'cronjobs':
      return { ...base, schedule: o.spec.schedule, suspend: !!o.spec.suspend, active: o.status?.active?.length || 0, lastSchedule: o.status?.lastScheduleTime };
    case 'jobs':
      return { ...base, completions: `${o.status?.succeeded || 0}/${o.spec.completions ?? 1}`, failed: o.status?.failed || 0, active: o.status?.active || 0, owner: m.ownerReferences?.[0]?.name || '' };
    case 'serviceaccounts':
      return { ...base, roleArn: m.annotations?.['eks.amazonaws.com/role-arn'] || '' };
    case 'events':
      return { ...base, type: o.type, reason: o.reason, object: `${o.involvedObject?.kind}/${o.involvedObject?.name}`, message: o.message, count: o.count || 1, last: o.lastTimestamp || o.eventTime || age(o) };
    default:
      return base;
  }
}

/** pod usage index from a snapshot: which pods reference each secret/configmap */
export function usageIndex(snap) {
  const secrets = {}; const configmaps = {};
  for (const p of snap?.pods || []) {
    for (const s of p.secretRefs || []) (secrets[`${p.namespace}/${s}`] ||= []).push(p.ownerName || p.name);
    for (const c of p.configMapRefs || []) (configmaps[`${p.namespace}/${c}`] ||= []).push(p.ownerName || p.name);
  }
  for (const idx of [secrets, configmaps]) for (const k of Object.keys(idx)) idx[k] = [...new Set(idx[k])];
  return { secrets, configmaps };
}

export async function listResources(kc, kind, namespace, usage) {
  const def = KINDS[kind];
  if (!def) throw Object.assign(new Error(`unsupported kind ${kind}`), { status: 400 });
  const api = k8s.KubernetesObjectApi.makeApiClient(kc);
  const out = await api.list(def.apiVersion, def.kind, def.clusterScoped ? undefined : namespace || undefined);
  const rows = out.items.map((o) => row(kind, o, usage));
  if (kind === 'events') rows.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  else rows.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return rows;
}

function clean(o) {
  const c = structuredClone(o);
  delete c.metadata?.managedFields;
  return c;
}

/** Read one object. Secrets come back masked unless reveal=true (values base64-decoded). */
export async function readResource(kc, kind, namespace, name, reveal = false) {
  const def = KINDS[kind];
  if (!def) throw Object.assign(new Error(`unsupported kind ${kind}`), { status: 400 });
  const api = k8s.KubernetesObjectApi.makeApiClient(kc);
  const o = clean(await api.read({ apiVersion: def.apiVersion, kind: def.kind, metadata: { name, namespace: def.clusterScoped ? undefined : namespace } }));
  return shapeRead(kind, o, reveal);
}

export function shapeRead(kind, o, reveal) {
  let values = null;
  if (kind === 'secrets') {
    const data = o.data || {};
    if (reveal) {
      values = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
    }
    o.data = Object.fromEntries(Object.keys(data).map((k) => [k, reveal ? data[k] : '••••••••']));
  }
  if (kind === 'configmaps') values = { ...(o.data || {}) };
  return { object: o, yaml: YAML.stringify(o), values, masked: kind === 'secrets' && !reveal };
}

/** Parse YAML (one or many docs) into Kubernetes objects. */
export function parseManifests(text) {
  const docs = YAML.parseAllDocuments(text).map((d) => {
    if (d.errors.length) throw Object.assign(new Error(`YAML error: ${d.errors[0].message}`), { status: 400 });
    return d.toJSON();
  }).filter(Boolean);
  if (!docs.length) throw Object.assign(new Error('No objects found in YAML.'), { status: 400 });
  for (const o of docs) {
    if (!o.apiVersion || !o.kind || !o.metadata?.name) throw Object.assign(new Error('Each object needs apiVersion, kind and metadata.name.'), { status: 400 });
    if (o.kind === 'Secret' && o.data && Object.values(o.data).some((v) => v === '••••••••')) {
      throw Object.assign(new Error('This Secret still has masked values (••••••••). Reveal the secret first, or put new values under stringData.'), { status: 400 });
    }
    delete o.metadata.managedFields; delete o.metadata.resourceVersion; delete o.metadata.uid; delete o.metadata.creationTimestamp; delete o.metadata.generation;
    delete o.status;
  }
  return docs;
}

/** Server-side apply each object (create or update). dryRun validates without changing anything. */
export async function applyManifests(kc, text, { dryRun = false, defaultNamespace = 'default' } = {}) {
  const docs = parseManifests(text);
  const api = k8s.KubernetesObjectApi.makeApiClient(kc);
  const results = [];
  for (const o of docs) {
    if (!o.metadata.namespace && !['Namespace', 'Node', 'ClusterRole', 'ClusterRoleBinding', 'PersistentVolume', 'StorageClass', 'CustomResourceDefinition'].includes(o.kind)) o.metadata.namespace = defaultNamespace;
    try {
      const r = await api.patch(o, undefined, dryRun ? 'All' : undefined, 'eks-lens', true, k8s.PatchStrategy.ServerSideApply);
      results.push({ kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace, ok: true, action: dryRun ? 'validated' : 'applied', uid: r.metadata?.uid });
    } catch (e) {
      results.push({ kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace, ok: false, error: e.body?.message || e.message });
    }
  }
  return results;
}

export async function deleteResource(kc, kind, namespace, name) {
  const def = KINDS[kind] || byKind[kind];
  if (!def) throw Object.assign(new Error(`unsupported kind ${kind}`), { status: 400 });
  const api = k8s.KubernetesObjectApi.makeApiClient(kc);
  await api.delete({ apiVersion: def.apiVersion, kind: def.kind, metadata: { name, namespace: def.clusterScoped ? undefined : namespace } }, undefined, undefined, undefined, undefined, 'Background');
  return { ok: true };
}

const WORKLOAD_KIND = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' };
export async function workloadAction(kc, { action, kind, namespace, name, replicas }) {
  const key = WORKLOAD_KIND[kind] || kind;
  const def = KINDS[key];
  if (!def) throw Object.assign(new Error(`unsupported kind ${kind}`), { status: 400 });
  const api = k8s.KubernetesObjectApi.makeApiClient(kc);
  const spec = { apiVersion: def.apiVersion, kind: def.kind, metadata: { name, namespace } };
  if (action === 'scale') {
    const n = Number(replicas);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw Object.assign(new Error('Replicas must be a whole number from 0 to 500.'), { status: 400 });
    await api.patch({ ...spec, spec: { replicas: n } }, undefined, undefined, 'eks-lens', undefined, k8s.PatchStrategy.MergePatch);
    return { ok: true, message: `Scaled ${kind} ${name} to ${n}` };
  }
  if (action === 'restart') {
    await api.patch({ ...spec, spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
      undefined, undefined, 'eks-lens', undefined, k8s.PatchStrategy.MergePatch);
    return { ok: true, message: `Restarted ${kind} ${name} (rolling)` };
  }
  throw Object.assign(new Error(`unknown action ${action}`), { status: 400 });
}
