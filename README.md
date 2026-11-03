# EKS Lens · Cloud Destinations

A self-hosted web dashboard for many EKS clusters across many AWS accounts, in the Cloud Destinations theme. It shows what runs in every cluster, flags the `default` namespace and other problems, splits the cluster cost by namespace and deployment, shows live CPU/memory per pod, streams pod logs, opens a shell inside pods (like Lens), shows Kubernetes Secrets/ConfigMaps and AWS Secrets Manager, and lets you create and edit Deployments, Pods, Secrets and more.

Version 0.2.0. Requires **Node.js 22.19 or newer**.

## Quick start (your Mac)

```bash
npm ci
npm run demo     # sample data, no AWS needed: http://localhost:8080
npm start        # your real accounts:          http://localhost:8080
```

Then open **AWS accounts → + Add AWS account** and add each account with one of:

| Sign-in method | When to use |
|---|---|
| **Access key and secret** | An IAM user's keys. Stored encrypted (AES-256-GCM) in `data/eks-lens.db`, key in `data/secret.key`. |
| **AWS CLI profile (SSO)** | A profile from `~/.aws/config`, e.g. `agenticai`. Run `aws sso login --profile agenticai` first. |
| **Default credentials** | Whatever the AWS SDK finds (env vars, instance role, Pod Identity). |
| *+ Role to assume* | Optional on any of the above: sign in, then assume a role in another account. |

Click **Test connection** before saving: it shows the identity and the clusters it found. All accounts appear together in **Fleet overview**.

Each identity needs:
1. The IAM permissions in [`docs/iam-access-key-policy.json`](docs/iam-access-key-policy.json).
2. An **EKS access entry** in each cluster, for example:
   ```bash
   aws eks create-access-entry --cluster-name <cluster> --principal-arn <user-or-role-arn> --region <region>
   aws eks associate-access-policy --cluster-name <cluster> --principal-arn <user-or-role-arn> \
     --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster --region <region>
   ```
   Use `AmazonEKSViewPolicy` instead for a read-only identity.
3. The **metrics-server** add-on in each cluster for CPU/memory usage.

## Features

| Area | What you get |
|---|---|
| Fleet | All accounts and clusters on one page, a per-account summary (clusters, namespaces, pods, nodes, monthly cost, idle) |
| Namespaces | Pods, deployments, restarts, CPU/memory used vs requested, cost and share. Flags: `DEFAULT_IN_USE`, `TERMINATING`, `UNHEALTHY`, `PENDING`, `NO_REQUESTS`, `NO_OWNER`, `EMPTY`, `SYSTEM` |
| Deployments | Every Deployment/StatefulSet/DaemonSet/CronJob with ready count, usage, cost; **Scale**, **Restart** (rolling), **YAML** |
| Pods | Usage bars against request and limit, cost, events; **Logs** (live, current, previous container), **Shell**, **YAML**, **Delete** |
| Nodes | Instance type, capacity type, usage, price and **where the price came from** |
| Config & Secrets | Secrets (values hidden until you click Show values; shows which workloads use each), ConfigMaps, Services, Ingresses, PVCs, HPAs, CronJobs, Jobs, service accounts (IRSA role), events |
| AWS Secrets | AWS Secrets Manager for the cluster's account and any region: list, show value, save a new version, create |
| + Create | Deployment (+ optional Service), Pod, Secret, ConfigMap, Namespace, or any YAML. Every change is reviewed as YAML, **Validate** runs a server-side dry run, **Apply** uses server-side apply |
| Cost split | Per-namespace cost with idle and control plane lines, CSV copy, recorded daily cost |
| kubectl | Console against the selected cluster (write verbs are allowed when changes are enabled) |
| Activity log | Every log view, shell session, secret reveal and change, with the user and time |
| Look | Cloud Destinations colours, light/dark, font picker (Inter + Poppins, Plus Jakarta Sans, Apple system, IBM Plex) |

## Database

By default EKS Lens keeps a local SQLite file at `data/eks-lens.db` (built into Node, nothing to install):

| Table | Holds |
|---|---|
| `accounts` | Accounts added in the UI; secrets encrypted |
| `price_cache` | AWS prices (on-demand 7 days, spot 1 hour) |
| `cost_snapshots` | One cost sample per cluster/namespace per hour (for trends) |
| `audit_log` | Activity log |

To use **PostgreSQL** instead, set `DATABASE_URL=postgres://user:pass@host:5432/ekslens`. The same tables are created automatically. Back up `data/secret.key` (or set `EKSL_SECRET_KEY`) together with the database: without it, stored access keys cannot be decrypted. Never commit `data/`.

## How cost is calculated

1. Each node's hourly price comes from, in order: your override in `settings.costModel.instancePrices` → the **real spot price** for spot nodes (EC2 spot price history for that AZ) → the **AWS Price List API** for that instance type and region → a built-in table → an estimate. The Nodes tab shows which.
2. The node price is split into a per-vCPU and a per-GiB rate (1 vCPU-hour = 7.46 GiB-hours, the OpenCost default).
3. Every running pod pays `max(request, actual usage)` for CPU and memory at its node's rates.
4. Node capacity no pod claims is **idle**; the EKS control plane fee ($0.10/h, $0.60/h on extended support) is its own line.

It is a live run-rate (now × 730 h), not an invoice. Not included: Savings Plans/RI discounts (enter your rates as overrides), EBS, load balancers, NAT, data transfer, Fargate. For invoice-accurate chargeback enable **Split cost allocation data for EKS** in the AWS Cost and Usage Report.

## What it costs to run

| Item | Cost |
|---|---|
| EKS, STS, Kubernetes API, Price List API, spot price history calls | Free |
| Data from AWS to your laptop | Within AWS's 100 GB/month free data transfer out |
| Opening an AWS Secrets Manager value | $0.05 per 10,000 calls |
| Creating a secret in Secrets Manager | about $0.40/month per secret |
| Shared deployment for the team (ALB + small pod) | about $17–28/month |

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Listen address. Local by default; the container uses `0.0.0.0` |
| `DEMO_MODE` | `false` | Sample data, no AWS calls |
| `DATABASE_URL` | empty (SQLite) | PostgreSQL connection string |
| `EKSL_SECRET_KEY` | `data/secret.key` | 32-byte base64 key that encrypts stored access keys |
| `READ_ONLY` | `false` | Disable all changes and pod shells |
| `WRITE_ENABLED` | `true` | `false` disables create/edit/delete/scale |
| `WRITE_ALLOWED_USERS`, `EXEC_ALLOWED_USERS`, `REVEAL_ALLOWED_USERS` | empty (everyone) | Comma-separated SSO emails allowed to change things, open shells, show secret values |
| `REVEAL_SECRETS` | `true` | `false` hides all secret values |
| `ACCOUNTS_FILE` | `config/accounts.yaml` | Optional file-based accounts (read-only in the UI) |
| `AUTH_TOKEN` | empty | Simple shared token for lab use. Use ALB OIDC in production |

## Deploy for the company

1. IAM: `deploy/terraform/` (hub role via EKS Pod Identity, spoke role + access entry per account).
2. RBAC: `kubectl apply -f deploy/rbac/eks-lens-clusterrole.yaml` in every cluster; delete the optional bindings (`exec`, `secrets`, `edit`) you don't want.
3. Database: create an RDS PostgreSQL database and a Secret `eks-lens-db` with key `url`; create Secret `eks-lens-key` with `key=$(openssl rand -base64 32)`.
4. Image: `docker build -f deploy/Dockerfile -t <ecr>/eks-lens:0.2.0 . && docker push …`
5. App: edit and apply `deploy/k8s/eks-lens.yaml` (internal ALB with SSO sign-in). Turn on `WRITE_ENABLED` only together with `WRITE_ALLOWED_USERS`.

Or run locally in Docker: `docker compose up --build`.

## Code map

- `server/accounts.js`, `server/crypto.js`, `server/db.js` – account registry, encryption, SQLite/PostgreSQL
- `server/aws.js` – sign-in, role assumption, region and cluster discovery, EKS tokens
- `server/pricing.js` – Price List API, spot prices, cache
- `server/kube.js` – inventory; `server/resources.js` – list/read/apply/delete/scale/restart
- `server/secretsmanager.js` – AWS Secrets Manager
- `server/stream.js` – WebSocket logs, exec, kubectl console
- `public/` – UI (vanilla JS, no build step); `public/js/shared/model.js` – cost split and flags

## Known limits

- Old logs: Kubernetes keeps only the current and previous container's logs. Older or deleted-pod logs need CloudWatch Logs (Container Insights / Fluent Bit).
- Usage and cost are current values; the hourly samples only cover hours EKS Lens was running.
- One replica (in-memory cache); scale out with sticky sessions and PostgreSQL.
