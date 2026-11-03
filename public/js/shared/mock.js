// Deterministic sample data for DEMO_MODE and the static preview.
// Shapes match what server/kube.js produces from a real cluster.

function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const hash = (r, n = 5) => Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz2456789'[Math.floor(r() * 27)]).join('');
const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();

export const DEMO_CLUSTERS = [
  { id: 'cd-shared/ap-south-1/cd-internal-shared-eks', account: 'cd-shared', accountId: '111111111111', region: 'ap-south-1', name: 'cd-internal-shared-eks', version: '1.31', status: 'ACTIVE', scale: 1.0 },
  { id: 'cd-shared/ap-south-1/demo-cluster', account: 'cd-shared', accountId: '111111111111', region: 'ap-south-1', name: 'demo-cluster', version: '1.32', status: 'ACTIVE', scale: 0.4 },
  { id: 'client-prod/us-east-1/prod-eks-01', account: 'client-prod', accountId: '222222222222', region: 'us-east-1', name: 'prod-eks-01', version: '1.30', status: 'ACTIVE', scale: 1.6 },
  { id: 'client-dev/us-west-2/dev-eks', account: 'client-dev', accountId: '333333333333', region: 'us-west-2', name: 'dev-eks', version: '1.31', status: 'ACTIVE', scale: 0.6 },
];

const NODE_TYPES = [
  { type: 'm6i.xlarge', cpu: 4, mem: 16, price: 0.192 },
  { type: 'm6i.2xlarge', cpu: 8, mem: 32, price: 0.384 },
  { type: 'c6i.xlarge', cpu: 4, mem: 8, price: 0.17 },
  { type: 'r6i.large', cpu: 2, mem: 16, price: 0.126 },
  { type: 'm7g.xlarge', cpu: 4, mem: 16, price: 0.1632 },
];

// namespace -> workloads [kind, name, replicas, cpuReq, memReqGiB, image, usageFactor]
const APPS = {
  'kube-system': [
    ['DaemonSet', 'aws-node', -1, 0.025, 0.06, '602401143452.dkr.ecr.ap-south-1.amazonaws.com/amazon-k8s-cni:v1.19.0', 0.6],
    ['DaemonSet', 'kube-proxy', -1, 0.1, 0.05, '602401143452.dkr.ecr.ap-south-1.amazonaws.com/eks/kube-proxy:v1.31.2', 0.1],
    ['DaemonSet', 'ebs-csi-node', -1, 0.01, 0.04, 'public.ecr.aws/ebs-csi-driver/aws-ebs-csi-driver:v1.37.0', 0.3],
    ['Deployment', 'coredns', 2, 0.1, 0.07, '602401143452.dkr.ecr.ap-south-1.amazonaws.com/eks/coredns:v1.11.3', 0.4],
    ['Deployment', 'metrics-server', 1, 0.1, 0.2, 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', 0.3],
    ['Deployment', 'aws-load-balancer-controller', 2, 0.05, 0.12, 'public.ecr.aws/eks/aws-load-balancer-controller:v2.9.0', 0.2],
  ],
  'kube-public': [], 'kube-node-lease': [],
  karpenter: [['Deployment', 'karpenter', 2, 0.5, 1, 'public.ecr.aws/karpenter/controller:1.1.0', 0.3]],
  'amazon-cloudwatch': [['DaemonSet', 'fluent-bit', -1, 0.05, 0.1, 'public.ecr.aws/aws-observability/aws-for-fluent-bit:2.32.4', 0.9]],
  default: [['Deployment', 'nginx-test', 2, 0, 0, 'nginx:1.27', 0.5], ['Pod', 'debug-busybox', 1, 0, 0, 'busybox:1.36', 0.1]],
  payments: [
    ['Deployment', 'payments-api', 4, 0.5, 1, 'acme/payments-api:2.14.1', 0.7],
    ['Deployment', 'payments-worker', 3, 0.25, 0.5, 'acme/payments-worker:2.14.1', 1.1],
    ['StatefulSet', 'payments-redis', 3, 0.25, 1, 'redis:7.4', 0.4],
  ],
  orders: [
    ['Deployment', 'orders-api', 3, 0.5, 0.75, 'acme/orders-api:1.9.0', 0.5],
    ['Deployment', 'orders-consumer', 2, 0.25, 0.5, 'acme/orders-consumer:1.9.0', 0.6, 'crash'],
  ],
  'web-frontend': [['Deployment', 'storefront', 6, 0.25, 0.5, 'acme/storefront:5.2.0', 0.45], ['Deployment', 'bff-gateway', 3, 0.25, 0.25, 'acme/bff:5.2.0', 0.6]],
  'data-pipeline': [['StatefulSet', 'kafka', 3, 1, 4, 'bitnami/kafka:3.8', 0.55], ['Deployment', 'spark-operator', 1, 0.2, 0.5, 'kubeflow/spark-operator:2.0.2', 0.2], ['Job', 'nightly-etl-28842', 1, 2, 4, 'acme/etl:0.9', 0.9, 'done']],
  monitoring: [['StatefulSet', 'prometheus', 2, 1, 4, 'quay.io/prometheus/prometheus:v2.55.0', 0.8], ['Deployment', 'grafana', 1, 0.25, 0.5, 'grafana/grafana:11.3.0', 0.3]],
  'staging-sandbox': [],
  'feature-x-preview': [['Deployment', 'storefront-preview', 1, 0.25, 0.5, 'acme/storefront:pr-1142', 0.05, 'pending']],
};
const NS_LABELS = { payments: { team: 'payments' }, orders: { team: 'commerce' }, 'web-frontend': { team: 'web' }, 'data-pipeline': { team: 'data' }, monitoring: { team: 'platform' } };

export function demoInventory(clusterId) {
  const c = DEMO_CLUSTERS.find((x) => x.id === clusterId) || DEMO_CLUSTERS[0];
  const r = rng(c.id);
  const nodeCount = Math.max(2, Math.round(6 * c.scale));
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const t = NODE_TYPES[Math.floor(r() * NODE_TYPES.length)];
    const spot = r() < 0.35;
    const az = `${c.region}${'abc'[i % 3]}`;
    return {
      name: `ip-10-${20 + i}-${Math.floor(r() * 250)}-${Math.floor(r() * 250)}.${c.region}.compute.internal`,
      instanceType: t.type, capacityType: spot ? 'SPOT' : 'ON_DEMAND', zone: az,
      nodegroup: spot ? 'karpenter-spot' : 'core-ng', arch: t.type.includes('g.') ? 'arm64' : 'amd64',
      cpu: t.cpu, memGiB: t.mem, allocCpu: t.cpu - 0.08, allocMemGiB: t.mem * 0.9,
      ready: true, created: ago(3 + r() * 40), kubeletVersion: `v${c.version}.2-eks`,
      hourlyPrice: spot ? t.price * 0.35 : t.price, priceEstimated: false,
    };
  });

  const namespaces = []; const pods = []; const workloads = [];
  const skip = c.scale < 0.5 ? ['data-pipeline', 'payments'] : [];
  for (const [ns, apps] of Object.entries(APPS)) {
    if (skip.includes(ns)) continue;
    namespaces.push({ name: ns, created: ago(ns.startsWith('kube') ? 200 : 20 + r() * 120), status: 'Active', labels: NS_LABELS[ns] || {} });
    for (const [kind, name, rep, cpu, mem, image, uf, mode] of apps) {
      const replicas = rep === -1 ? nodes.length : Math.max(1, Math.round(rep * (kind === 'Deployment' ? Math.min(c.scale, 1.5) : 1)));
      const rsHash = hash(r, 9);
      let ready = 0;
      for (let i = 0; i < replicas; i++) {
        const node = kind === 'DaemonSet' ? nodes[i] : nodes[Math.floor(r() * nodes.length)];
        const pname = kind === 'Pod' ? name : kind === 'StatefulSet' ? `${name}-${i}` : kind === 'DaemonSet' ? `${name}-${hash(r)}` : kind === 'Job' ? `${name}-${hash(r)}` : `${name}-${rsHash}-${hash(r)}`;
        const crash = mode === 'crash' && i === 0;
        const pending = mode === 'pending';
        const done = mode === 'done';
        const jitter = 0.6 + r() * 0.8;
        const usageCpu = pending || done ? null : Math.max(0.002, (cpu || 0.05) * uf * jitter);
        const usageMem = pending || done ? null : Math.max(0.01, (mem || 0.06) * Math.min(1.3, 0.5 + uf * 0.5 * jitter));
        const containers = [{
          name: kind === 'Pod' ? 'busybox' : name.replace(/-\d+$/, ''), image,
          reqCpu: cpu, reqMemGiB: mem, limCpu: cpu ? cpu * 2 : 0, limMemGiB: mem ? mem * 1.5 : 0,
          usageCpu, usageMemGiB: usageMem,
          ready: !crash && !pending && !done, restarts: crash ? 37 : Math.floor(r() * 1.4),
          state: crash ? 'CrashLoopBackOff' : pending ? 'Pending' : done ? 'Completed' : 'Running',
        }];
        if (/api|storefront|bff/.test(name)) containers.push({ name: 'envoy-sidecar', image: 'envoyproxy/envoy:v1.32.1', reqCpu: 0.05, reqMemGiB: 0.0625, limCpu: 0.2, limMemGiB: 0.125, usageCpu: pending ? null : 0.01 + r() * 0.02, usageMemGiB: pending ? null : 0.03 + r() * 0.02, ready: !pending, restarts: 0, state: pending ? 'Pending' : 'Running' });
        if (!crash && !pending && !done) ready++;
        const usageSum = (k) => (containers.every((x) => x[k] == null) ? null : containers.reduce((a, x) => a + (x[k] || 0), 0));
        pods.push({
          name: pname, namespace: ns, node: pending ? null : node.name,
          phase: pending ? 'Pending' : done ? 'Succeeded' : 'Running', reason: pending ? 'Unschedulable' : undefined,
          ip: pending ? null : `10.${20 + Math.floor(r() * 6)}.${Math.floor(r() * 250)}.${Math.floor(r() * 250)}`,
          qos: cpu ? 'Burstable' : 'BestEffort', created: ago(r() * 14),
          ownerKind: kind === 'Pod' ? undefined : kind, ownerName: kind === 'Pod' ? undefined : name,
          initContainers: [], containers, usageCpu: usageSum('usageCpu'), usageMemGiB: usageSum('usageMemGiB'),
        });
      }
      if (kind !== 'Pod' && kind !== 'Job') workloads.push({ kind, name, namespace: ns, created: ago(5 + r() * 90), desired: replicas, ready, images: [image] });
    }
  }
  for (const n of nodes) {
    const np = pods.filter((p) => p.node === n.name);
    n.usageCpu = 0.15 + np.reduce((a, p) => a + (p.usageCpu || 0), 0);
    n.usageMemGiB = 0.6 + np.reduce((a, p) => a + (p.usageMemGiB || 0), 0);
  }
  return {
    cluster: { id: c.id, name: c.name, account: c.account, accountId: c.accountId, region: c.region, version: c.version, status: c.status },
    generatedAt: new Date().toISOString(), metricsAvailable: true, warnings: [],
    namespaces, nodes, pods, workloads,
  };
}

// ---- fake log lines and shell for demo mode
const LEVELS = ['INFO', 'INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR'];
const MSGS = [
  'GET /api/v1/health 200 3ms', 'POST /api/v1/orders 201 48ms', 'GET /api/v1/orders/8812 200 12ms',
  'connected to redis payments-redis-0.payments-redis:6379', 'processed batch size=50 lag=12',
  'cache miss key=cart:7741', 'slow query detected duration=812ms table=orders', 'retrying upstream call attempt=2',
  'JWT validated sub=svc-storefront', 'flushed 128 metrics to statsd', 'GC pause 14ms heap=312MB',
];
export function demoLogLine(pod, container, i, previous = false) {
  const r = rng(`${pod}${container}${i}${previous}`);
  if (previous && i > 30) return null;
  if (/orders-consumer/.test(pod) && previous && i === 30) return `${new Date(Date.now() - 3600_000).toISOString()} FATAL panic: kafka: client has run out of available brokers (exit code 2)`;
  const lvl = /orders-consumer/.test(pod) && r() < 0.3 ? 'ERROR' : LEVELS[Math.floor(r() * LEVELS.length)];
  const ts = new Date(Date.now() - (previous ? 3600_000 : 0) - (200 - i) * 1500).toISOString();
  return `${ts} ${lvl.padEnd(5)} [${container}] ${MSGS[Math.floor(r() * MSGS.length)]}`;
}

export function demoShell(pod, container, line) {
  const cmd = line.trim();
  const [bin, ...args] = cmd.split(/\s+/);
  switch (bin) {
    case '': return '';
    case 'ls': return 'app  bin  dev  etc  home  lib  proc  root  run  sys  tmp  usr  var';
    case 'pwd': return '/app';
    case 'whoami': return 'app';
    case 'hostname': return pod;
    case 'date': return new Date().toUTCString();
    case 'uname': return 'Linux ' + pod + ' 6.1.115-126.197.amzn2023.x86_64 #1 SMP x86_64 GNU/Linux';
    case 'env': case 'printenv': return `HOSTNAME=${pod}\nKUBERNETES_SERVICE_HOST=172.20.0.1\nKUBERNETES_SERVICE_PORT=443\nAWS_REGION=ap-south-1\nAPP_ENV=production\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`;
    case 'ps': return 'PID   USER     TIME  COMMAND\n    1 app       2:14 /app/server --port=8080\n   23 app       0:00 sh\n   31 app       0:00 ps';
    case 'df': return 'Filesystem     Size  Used Avail Use% Mounted on\noverlay         80G   21G   60G  26% /\ntmpfs           64M     0   64M   0% /dev';
    case 'cat': return args[0] === '/etc/os-release' ? 'NAME="Alpine Linux"\nVERSION_ID=3.20.3' : `cat: ${args[0] || ''}: No such file or directory`;
    case 'curl': return '{"status":"ok","uptime":"3d4h"}';
    case 'nslookup': return `Server: 172.20.0.10\nName: ${args[0] || 'kubernetes.default'}.svc.cluster.local\nAddress: 172.20.${Math.floor(Math.random() * 200)}.14`;
    case 'exit': return null;
    case 'help': return 'Demo shell - try: ls, ps, env, df -h, hostname, uname -a, cat /etc/os-release, curl localhost:8080/health, nslookup <svc>';
    default: return `sh: ${bin}: not found (demo shell - type "help")`;
  }
}
