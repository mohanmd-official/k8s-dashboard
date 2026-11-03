# EKS Lens

A self-hosted web dashboard for many EKS clusters across many AWS accounts. It shows what is running in each cluster, flags the `default` namespace and other problems, splits the cluster cost by namespace and deployment, shows live CPU/memory per pod, streams pod logs, and opens a shell inside pods from the browser, similar to the Lens desktop app.

Version 0.1.0 (MVP).

## What it does

| Area | MVP feature |
|---|---|
| Multi-account | One dashboard, many AWS accounts via `sts:AssumeRole`. Clusters are auto-discovered per region. No kubeconfigs or static keys. |
| Fleet view | Every cluster on one page: monthly run-rate, idle spend, pods, nodes, clusters with workloads in `default`. |
| Namespaces | Count, pods running/total, deployments, StatefulSets/DaemonSets, restarts, CPU and memory used vs requested, cost per month, share of cluster. |
| Flags | `DEFAULT_IN_USE` (workloads in the default namespace), `SYSTEM`, `EMPTY`, `NO_REQUESTS`, `UNHEALTHY`, `PENDING`, `NO_OWNER` (no team/owner label). |
| Deployment view | Every Deployment / StatefulSet / DaemonSet / CronJob / bare pod with ready count, pods, usage and cost. Toggle Namespace view / Deployment view. |
| Pods | Status, restarts, CPU and memory usage bars against request and limit, cost, node, age. Pod drawer with containers and events. |
| Logs | Live follow, current container, previous container (after a crash), tail size, search with highlight, wrap, pause, copy. |
| Shell | Interactive TTY into any container (`kubectl exec -it`) in the browser, xterm.js, resize, multiple tabs. |
| kubectl console | Run `kubectl get/describe/top/logs/events/...` against the selected cluster. Write verbs are off unless `KUBECTL_WRITE=true`. |
| Cost split | Node price split into per-vCPU and per-GiB rates; each pod pays for `max(request, usage)`. Unclaimed capacity shown as idle; control plane fee shown separately. CSV copy. |
| Security | Behind ALB OIDC sign-in, per-user audit log of every log view, shell session and command, `READ_ONLY` and `EXEC_ALLOWED_USERS` switches, read-only RBAC by default. |

## Try it in 30 seconds (sample data)

```bash
npm ci
npm run demo            # DEMO_MODE=true, http://localhost:8080
```

Demo mode serves four sample clusters in three accounts with simulated logs, shell and kubectl.

## Run against your own accounts locally

```bash
cp config/accounts.example.yaml config/accounts.yaml   # list your accounts, role ARNs, regions
export AWS_PROFILE=my-sso-profile                      # identity that can assume the spoke roles
npm start
```

Your local identity needs an EKS access entry (or the spoke role) in each cluster, and network reach to the cluster API endpoints.

Several accounts from one laptop: give each account in `accounts.yaml` its own `profile:` from `~/.aws/config`, run `aws sso login --profile <name>` for each, and leave `roleArn` empty.

Or in Docker: `docker compose up --build` (mounts `./config` and `~/.aws`, serves http://localhost:8080 on this Mac only).

## Deploy for the company

1. **IAM**: `deploy/terraform/` creates the hub role (EKS Pod Identity) and a spoke role plus EKS access entry in every account. See `deploy/terraform/README.md`.
2. **RBAC**: `kubectl apply -f deploy/rbac/eks-lens-clusterrole.yaml` in every cluster. Delete the `eks-lens-exec` binding where shells should not be allowed.
3. **metrics-server** in every cluster (EKS add-on `metrics-server`). Without it, usage columns are empty and cost uses requests only.
4. **Image**: `docker build -f deploy/Dockerfile -t <ecr>/eks-lens:0.1.0 . && docker push ...`
5. **App**: edit and apply `deploy/k8s/eks-lens.yaml` (ConfigMap with accounts, Deployment, Service, internal ALB Ingress with OIDC sign-in).

### Network reach to cluster endpoints

The dashboard talks to each cluster's Kubernetes API. For each target cluster, either:
- keep the public endpoint on and allow only the hub VPC's NAT gateway IPs (`publicAccessCidrs`), or
- use a private endpoint and route from the hub VPC (Transit Gateway or VPC peering) with the cluster security group allowing 443 from the hub.

### Settings

| Env var | Default | Meaning |
|---|---|---|
| `ACCOUNTS_FILE` | `config/accounts.yaml` | Account registry |
| `DEMO_MODE` | `false` | Sample data, no AWS calls |
| `READ_ONLY` | `false` | Disable pod shells for everyone |
| `EXEC_ALLOWED_USERS` | empty (all) | Comma-separated SSO emails allowed to open shells |
| `KUBECTL_WRITE` | `false` | Allow rollout/scale/delete/label/cordon in the kubectl console |
| `AUTH_TOKEN` | empty | Simple shared token (`?token=`), for local or lab use only. Use ALB OIDC in production. |
| `PORT` | `8080` | HTTP port |

## Architecture

```
Browser ──HTTPS/WSS──▶ ALB (OIDC sign-in) ──▶ EKS Lens pod (hub cluster)
                                               │  Pod Identity → hub role
                                               │  sts:AssumeRole ─▶ spoke role (per account)
                                               │  eks:ListClusters / DescribeCluster
                                               │  presigned STS token (like `aws eks get-token`)
                                               ▼
                                   Kubernetes API of each cluster
                                   (inventory, metrics.k8s.io, pods/log, pods/exec)
```

- `server/aws.js`: assume role, cluster discovery, EKS token generation.
- `server/kube.js`: inventory collection and normalization.
- `public/js/shared/model.js`: cost split and flags (shared by server and browser).
- `server/stream.js`: WebSocket logs, exec and kubectl console.
- `public/`: UI (vanilla JS, no build step; xterm.js vendored).

## Known limits of the MVP (and the phase 2 plan)

- **Cost is a live run-rate**, not an invoice. It covers EC2 node time and the control plane fee, not EBS, load balancers, NAT or data transfer. Phase 2: read AWS **Split cost allocation data for EKS** from the Cost and Usage Report (Athena) for invoice-accurate monthly cost per namespace, and store hourly snapshots for trends.
- **Prices** come from a built-in on-demand table (us-east-1 list prices) with a spot discount factor. Override per instance type in `accounts.yaml`, or swap in the AWS Pricing API.
- **Old logs**: Kubernetes keeps only the current and the previous container's logs on the node, and rotates them. Logs from deleted pods or from days ago need a log pipeline (Fluent Bit to CloudWatch Logs via Container Insights). Phase 2: a CloudWatch Logs Insights tab per pod.
- **History**: usage and cost are current values. Phase 2: Amazon Managed Prometheus for CPU/memory history graphs.
- Fargate pods show but are priced as zero in the MVP (Fargate is billed per pod).
- Single replica (in-memory cache). Fine for hundreds of users; scale with sticky sessions.
- Tested end to end in demo mode. The live AWS/Kubernetes paths use the official AWS SDK v3 and `@kubernetes/client-node` and need a first run against a test cluster.
