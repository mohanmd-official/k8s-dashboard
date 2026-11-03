// Demo-mode data for the Config, Secrets Manager and write features.
// Used by the server in DEMO_MODE and by the browser preview.
const ago = (d) => new Date(Date.now() - d * 86400_000).toISOString();

export function demoResources(snap, kind, ns) {
  const nss = snap.namespaces.map((n) => n.name).filter((n) => !ns || n === ns);
  const rows = [];
  const add = (r) => rows.push({ labels: {}, created: ago(3 + (rows.length % 40)), ...r });
  for (const n of nss) {
    const wl = snap.workloads.filter((w) => w.namespace === n && w.kind !== 'DaemonSet');
    if (kind === 'secrets') {
      if (!n.startsWith('kube-')) add({ name: 'default-token', namespace: n, type: 'kubernetes.io/service-account-token', keys: ['ca.crt', 'namespace', 'token'], keyCount: 3, usedBy: [] });
      for (const w of wl.slice(0, 2)) add({ name: `${w.name}-env`, namespace: n, type: 'Opaque', keys: ['DATABASE_URL', 'API_KEY', 'JWT_SECRET'], keyCount: 3, usedBy: [w.name] });
      if (wl.length) add({ name: 'ecr-pull', namespace: n, type: 'kubernetes.io/dockerconfigjson', keys: ['.dockerconfigjson'], keyCount: 1, usedBy: wl.map((w) => w.name) });
    }
    if (kind === 'configmaps') {
      add({ name: 'kube-root-ca.crt', namespace: n, keys: ['ca.crt'], keyCount: 1, usedBy: [] });
      for (const w of wl.slice(0, 2)) add({ name: `${w.name}-config`, namespace: n, keys: ['LOG_LEVEL', 'FEATURE_FLAGS', 'app.yaml'], keyCount: 3, usedBy: [w.name] });
    }
    if (kind === 'services') for (const w of wl.filter((x) => x.kind === 'Deployment')) add({ name: w.name, namespace: n, type: /storefront|bff/.test(w.name) ? 'LoadBalancer' : 'ClusterIP', clusterIP: `172.20.${rows.length + 10}.${40 + rows.length}`, ports: '80/TCP', external: /storefront/.test(w.name) ? 'k8s-web-storefro-8a1c.elb.amazonaws.com' : '', selector: `app=${w.name}` });
    if (kind === 'ingresses' && wl.some((w) => /storefront|api/.test(w.name))) add({ name: `${n}-ingress`, namespace: n, className: 'alb', hosts: `${n}.example.com`, address: `k8s-${n.slice(0, 8)}-1b2c.us-east-2.elb.amazonaws.com`, tls: true });
    if (kind === 'pvcs') for (const w of wl.filter((x) => x.kind === 'StatefulSet')) for (let i = 0; i < (w.desired || 1); i++) add({ name: `data-${w.name}-${i}`, namespace: n, status: 'Bound', capacity: '20Gi', storageClass: 'gp3', volume: `pvc-${(i + 7) * 1373}`, accessModes: 'ReadWriteOnce' });
    if (kind === 'hpas') for (const w of wl.filter((x) => x.kind === 'Deployment' && x.desired > 2)) add({ name: w.name, namespace: n, target: `Deployment/${w.name}`, min: 2, max: 10, current: w.desired, desired: w.desired, metrics: 'cpu 46%' });
    if (kind === 'cronjobs' && n === 'data-pipeline') add({ name: 'nightly-etl', namespace: n, schedule: '30 2 * * *', suspend: false, active: 0, lastSchedule: ago(0.3) });
    if (kind === 'serviceaccounts') add({ name: 'default', namespace: n, roleArn: '' });
    if (kind === 'events') {
      for (const p of snap.pods.filter((x) => x.namespace === n && x.health !== 'ok')) add({ name: `${p.name}.evt`, namespace: n, type: 'Warning', reason: p.phase === 'Pending' ? 'FailedScheduling' : 'BackOff', object: `Pod/${p.name}`, message: p.phase === 'Pending' ? '0/6 nodes are available: Insufficient cpu.' : 'Back-off restarting failed container', count: 88, last: new Date().toISOString() });
    }
  }
  return rows;
}

export function demoSecretValues(name) {
  if (/token/.test(name)) return { 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIC...demo\n-----END CERTIFICATE-----', namespace: 'demo', token: 'eyJhbGciOi...demo' };
  if (/pull/.test(name)) return { '.dockerconfigjson': '{"auths":{"111111111111.dkr.ecr.us-east-2.amazonaws.com":{"auth":"ZGVtbw=="}}}' };
  return { DATABASE_URL: 'postgres://app:demo-password@db.internal:5432/app', API_KEY: 'demo-1234-5678', JWT_SECRET: 'demo-jwt-secret' };
}

export function demoReadObject(kind, ns, name, reveal) {
  const KIND = { secrets: 'Secret', configmaps: 'ConfigMap', services: 'Service', ingresses: 'Ingress', pvcs: 'PersistentVolumeClaim', hpas: 'HorizontalPodAutoscaler', cronjobs: 'CronJob', jobs: 'Job', serviceaccounts: 'ServiceAccount', deployments: 'Deployment', pods: 'Pod', namespaces: 'Namespace' }[kind] || 'Object';
  const API = { Secret: 'v1', ConfigMap: 'v1', Service: 'v1', PersistentVolumeClaim: 'v1', ServiceAccount: 'v1', Pod: 'v1', Namespace: 'v1', Ingress: 'networking.k8s.io/v1', HorizontalPodAutoscaler: 'autoscaling/v2', CronJob: 'batch/v1', Job: 'batch/v1', Deployment: 'apps/v1' }[KIND] || 'v1';
  const o = { apiVersion: API, kind: KIND, metadata: { name, namespace: kind === 'namespaces' ? undefined : ns, labels: { app: name } } };
  let values = null;
  if (kind === 'secrets') {
    const v = demoSecretValues(name);
    o.type = 'Opaque';
    o.data = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reveal ? btoa(x) : '••••••••']));
    if (reveal) values = v;
  } else if (kind === 'configmaps') {
    o.data = { LOG_LEVEL: 'info', FEATURE_FLAGS: 'checkout_v2=true', 'app.yaml': 'server:\n  port: 8080\n' };
    values = o.data;
  } else if (kind === 'deployments') {
    o.spec = { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: `acme/${name}:1.0.0`, ports: [{ containerPort: 8080 }], resources: { requests: { cpu: '250m', memory: '256Mi' } } }] } } };
  } else if (kind === 'services') {
    o.spec = { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] };
  }
  return { object: o, values, masked: kind === 'secrets' && !reveal };
}

export const DEMO_SM = [
  { name: 'prod/payments/db', description: 'Aurora credentials for payments', rotationEnabled: true, lastChanged: ago(12), lastAccessed: ago(0.2), kmsKeyId: 'alias/payments', tags: { team: 'payments' } },
  { name: 'prod/orders/stripe-api-key', description: 'Stripe secret key', rotationEnabled: false, lastChanged: ago(140), lastAccessed: ago(1), kmsKeyId: 'aws/secretsmanager', tags: { team: 'commerce' } },
  { name: 'shared/datadog-api-key', description: '', rotationEnabled: false, lastChanged: ago(300), lastAccessed: ago(0.5), kmsKeyId: 'aws/secretsmanager', tags: {} },
  { name: 'rds!cluster-3f1c9e2a', description: 'Managed by RDS', rotationEnabled: true, lastChanged: ago(5), lastAccessed: ago(0.1), kmsKeyId: 'aws/secretsmanager', owningService: 'rds', tags: {} },
];
export function demoSmValue(name) {
  const raw = /db|rds/.test(name) ? JSON.stringify({ username: 'app', password: 'demo-Pa55word!', host: 'payments.cluster-demo.us-east-2.rds.amazonaws.com', port: 5432 }) : 'sk_live_demo_51HxY';
  let json = null; try { json = JSON.parse(raw); } catch {}
  return { name, raw, json, versionId: 'demo-v1', stages: ['AWSCURRENT'] };
}
