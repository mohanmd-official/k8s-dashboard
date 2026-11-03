# EKS Lens: authentication with an assumed IAM role

How EKS Lens signs in to AWS and Kubernetes using the IAM role `eks-lens-spoke`, how to create that role, and how to check that it works. Follow it once per AWS account.

| | Value used at Cloud Destinations |
|---|---|
| Hub account (where you sign in) | `203874373290` (`agenticai`) |
| SSO session / start URL | `cdians` / `https://identitycenter.amazonaws.com/ssoins-6684d181dd345884` (us-east-2) |
| Your SSO role | `arn:aws:iam::203874373290:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_AdministratorAccess_b9b3939b1e53af1d` |
| Role EKS Lens assumes | `eks-lens-spoke` (one per account) |
| External ID | `eks-lens` |
| Role for the hosted app (later) | `arn:aws:iam::203874373290:role/eks-lens-hub` |
| First cluster | `cd-internal-shared-eks` (us-east-2) |

---

## 1. How the sign-in works

```
 ┌───────────────────────── where EKS Lens runs ─────────────────────────┐
 │  Laptop:  ~/.aws/config [profile agenticai]  +  `aws sso login`       │
 │  Hosted:  EKS Pod Identity → role eks-lens-hub (automatic, no keys)   │
 └──────────────────────────────────┬────────────────────────────────────┘
                                    │ ① starting identity
                                    ▼
                 sts:AssumeRole  eks-lens-spoke   (ExternalId = eks-lens)
                                    │ ② 1-hour credentials for the role
                                    ▼
                 eks:DescribeCluster → API endpoint + CA certificate
                                    │ ③ EKS token signed locally (like `aws eks get-token`)
                                    ▼
                 Kubernetes API of the cluster
                   └─ EKS access entry for eks-lens-spoke → AmazonEKSClusterAdminPolicy
```

- The starting identity (your SSO role on a laptop, `eks-lens-hub` when hosted) is used for **one call only**: `sts:AssumeRole`.
- Everything else (EKS, pricing, Secrets Manager, Kubernetes) runs **as `eks-lens-spoke`**. The cluster sees the user `arn:aws:sts::<account>:assumed-role/eks-lens-spoke/eks-lens`.
- No access keys are stored. Role credentials last 1 hour and EKS Lens renews them automatically.
- Moving from laptop to hosted changes only the starting identity. The spoke roles, trust policies and access entries stay the same.

Analogy: your SSO login is the passport, `AssumeRole` is the front desk handing you a room key that only opens "eks-lens-spoke" rooms for an hour, and the EKS access entry is the door that accepts that key.

---

## 2. Prerequisites

- AWS CLI v2, `kubectl`, Node.js 22.19+.
- An SSO profile for the hub account in `~/.aws/config`:

  ```ini
  [sso-session cdians]
  sso_start_url = https://identitycenter.amazonaws.com/ssoins-6684d181dd345884
  sso_region = us-east-2
  sso_registration_scopes = sso:account:access

  [profile agenticai]
  sso_session = cdians
  sso_account_id = 203874373290
  sso_role_name = AdministratorAccess
  region = us-east-2
  ```

- Admin access (or IAM + EKS permissions) in each account you set up. For other accounts, add a profile like `agenticai` with that account's `sso_account_id`.
- The **metrics-server** EKS add-on in each cluster (for CPU/memory):
  `aws eks create-addon --cluster-name <cluster> --addon-name metrics-server --region <region> --profile <profile>`

---

## 3. Create the role `eks-lens-spoke`

Do this in **every account** EKS Lens should see, including the hub account if it has clusters.

### 3a. Trust policy: who may assume the role

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EksLensCallers",
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::203874373290:root" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "eks-lens" },
      "ArnLike": { "aws:PrincipalArn": [
        "arn:aws:iam::203874373290:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_AdministratorAccess_*",
        "arn:aws:iam::203874373290:role/eks-lens-hub"
      ] }
    }
  }]
}
```

- `Principal` is always the **hub account** (203874373290), also in the other accounts.
- `aws:PrincipalArn` allows exactly two callers: your SSO admin role (laptop use) and `eks-lens-hub` (hosted app). The `*` keeps it working if the permission set is re-provisioned and the suffix changes. The ARN includes the path `aws-reserved/sso.amazonaws.com/us-east-2/`; get yours with
  `aws iam get-role --role-name AWSReservedSSO_AdministratorAccess_<suffix> --query Role.Arn --output text`.
- `sts:ExternalId` must be exactly `eks-lens`, in the role and in EKS Lens.

### 3b. Permissions policy: what the role may do (inline policy `EksLensAccess`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DiscoverClusters", "Effect": "Allow", "Action": ["eks:ListClusters", "eks:DescribeCluster", "ec2:DescribeRegions", "sts:GetCallerIdentity"], "Resource": "*" },
    { "Sid": "LivePrices", "Effect": "Allow", "Action": ["pricing:GetProducts", "ec2:DescribeSpotPriceHistory"], "Resource": "*" },
    { "Sid": "SecretsManagerRead", "Effect": "Allow", "Action": ["secretsmanager:ListSecrets", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], "Resource": "*" }
  ]
}
```

Remove `SecretsManagerRead` if the dashboard should not read AWS Secrets Manager. To also edit secrets from the dashboard, add `secretsmanager:PutSecretValue`, `secretsmanager:CreateSecret` and `secretsmanager:TagResource`.

### 3c. Option 1: AWS console

1. **IAM → Roles → Create role**.
2. Trusted entity: **AWS account → Another AWS account**, account ID `203874373290`, tick **Require external ID**, enter `eks-lens`.
   The console warns that external IDs do not work with *Switch Role*. That is expected: EKS Lens assumes the role through the API.
3. Skip *Add permissions* → **Next**. Name: `eks-lens-spoke` → **Create role**.
4. Open the role → **Trust relationships → Edit trust policy** → paste the JSON from 3a → **Update policy**.
5. **Permissions → Add permissions → Create inline policy → JSON** → paste 3b → name `EksLensAccess` → **Create policy**.

### 3d. Option 2: AWS CLI

Save 3a as `/tmp/eks-lens-trust.json` and 3b as `/tmp/eks-lens-perms.json`, then:

```bash
P=agenticai                      # profile for the account you are setting up
aws iam create-role --role-name eks-lens-spoke --profile $P \
  --assume-role-policy-document file:///tmp/eks-lens-trust.json \
  --description "EKS Lens dashboard access" --max-session-duration 3600
aws iam put-role-policy --role-name eks-lens-spoke --policy-name EksLensAccess --profile $P \
  --policy-document file:///tmp/eks-lens-perms.json
```

To fix an existing role later: `aws iam update-assume-role-policy --role-name eks-lens-spoke --policy-document file:///tmp/eks-lens-trust.json --profile $P`.

---

## 4. Let the role into each cluster (EKS access entry)

IAM only gets the role as far as the EKS API. To see anything **inside** a cluster, the role needs an access entry.

### Console
**EKS → Clusters → *cluster* → Access → Create access entry** → IAM principal `arn:aws:iam::<account>:role/eks-lens-spoke`, type **Standard** → **Add policy** `AmazonEKSClusterAdminPolicy`, scope **Cluster** → **Create**.

### CLI (all clusters in a region)

```bash
P=agenticai; R=us-east-2
ACCT=$(aws sts get-caller-identity --profile $P --query Account --output text)
ROLE=arn:aws:iam::$ACCT:role/eks-lens-spoke
for C in $(aws eks list-clusters --region $R --profile $P --query clusters --output text); do
  echo "→ $C"
  aws eks create-access-entry --cluster-name $C --principal-arn $ROLE --type STANDARD --region $R --profile $P >/dev/null
  aws eks associate-access-policy --cluster-name $C --principal-arn $ROLE \
    --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
    --access-scope type=cluster --region $R --profile $P >/dev/null && echo "  done"
done
```

Which access policy to attach:

| Policy | Dashboard can |
|---|---|
| `AmazonEKSClusterAdminPolicy` | everything: view, logs, shell, secrets, create/edit/delete |
| `AmazonEKSAdminPolicy` | the same, but not cluster-scoped objects such as namespaces and nodes |
| `AmazonEKSViewPolicy` | read-only (no Secret values, no shell, no changes) |

If `create-access-entry` complains about the **authentication mode**, the cluster only uses the old `aws-auth` ConfigMap. Switch it (safe, cannot be undone), wait about 2 minutes, retry:

```bash
aws eks update-cluster-config --name <cluster> --region $R --profile $P \
  --access-config authenticationMode=API_AND_CONFIG_MAP
```

---

## 5. Validate

### 5a. One-time test profile that assumes the role

```bash
grep -q '^\[profile eks-lens-spoke\]' ~/.aws/config || cat >> ~/.aws/config <<'EOF'

[profile eks-lens-spoke]
source_profile = agenticai
role_arn = arn:aws:iam::203874373290:role/eks-lens-spoke
external_id = eks-lens
region = us-east-2
EOF
```

For another account, copy the block with a new name (e.g. `eks-lens-spoke-acctb`) and that account's `role_arn`. `source_profile` stays `agenticai`.

### 5b. Check everything

```bash
aws sso login --profile agenticai
ok(){ echo "✅ $1"; }; bad(){ echo "❌ $1"; }
C=cd-internal-shared-eks; R=us-east-2; ROLE=arn:aws:iam::203874373290:role/eks-lens-spoke

aws iam get-role --role-name eks-lens-spoke --profile agenticai --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition' --output json | grep -q '"eks-lens"' && ok "external ID is eks-lens" || bad "external ID wrong"
aws iam list-role-policies --role-name eks-lens-spoke --profile agenticai --query PolicyNames --output text | grep -q EksLensAccess && ok "EksLensAccess attached" || bad "EksLensAccess missing"
WHO=$(aws sts get-caller-identity --profile eks-lens-spoke --query Arn --output text 2>&1); echo "$WHO" | grep -q 'assumed-role/eks-lens-spoke' && ok "assumed: $WHO" || bad "cannot assume: $WHO"
aws eks list-clusters --profile eks-lens-spoke --region $R --query clusters --output text 2>&1 | grep -q $C && ok "sees $C" || bad "cannot list clusters"
aws pricing get-products --region us-east-1 --profile eks-lens-spoke --service-code AmazonEC2 \
  --filters Type=TERM_MATCH,Field=instanceType,Value=t4g.medium Type=TERM_MATCH,Field=regionCode,Value=$R \
  --max-results 1 --query 'length(PriceList)' --output text 2>&1 | grep -q '^1$' && ok "Price List API works" || bad "pricing denied"
aws eks list-access-entries --cluster-name $C --region $R --profile agenticai --output text | grep -q "$ROLE" && ok "access entry exists" || bad "no access entry for the role"
aws eks update-kubeconfig --name $C --region $R --profile eks-lens-spoke --alias eks-lens-test >/dev/null
kubectl --context eks-lens-test get ns >/dev/null 2>&1 && ok "kubectl works as the role" || bad "kubectl unauthorized"
echo "can create deployments: $(kubectl --context eks-lens-test auth can-i create deployments -A 2>&1)"
```

All ✅ and `yes` on the last line means the role is set up correctly. Remove the test context afterwards: `kubectl config delete-context eks-lens-test`.

### 5c. Prove the dashboard uses the role

In EKS Lens open the cluster → **kubectl** tab → run `auth whoami`. Username must be
`arn:aws:sts::203874373290:assumed-role/eks-lens-spoke/eks-lens`.

---

## 6. Add the account in EKS Lens

**AWS accounts → + Add AWS account**

| Field | Laptop | Hosted app |
|---|---|---|
| Display name | e.g. `agenticai-prod` | same |
| AWS account ID | the target account | same |
| Sign-in method | **AWS CLI profile (SSO)**, profile `agenticai` (always the hub profile) | **Default credentials** (Pod Identity) |
| Role to assume | `arn:aws:iam::<target-account>:role/eks-lens-spoke` | same |
| External ID | `eks-lens` (auto-filled when you enter a role) | same |
| Regions | the account's regions, or *All enabled regions* | same |

**Test connection** must say *Signed in as arn:aws:sts::<account>:assumed-role/eks-lens-spoke/eks-lens* and list the clusters. Then **Add account**. Every morning run `aws sso login --profile agenticai`; that one login covers every account.

Accounts can also be listed in `config/accounts.yaml` (read-only in the UI):

```yaml
accounts:
  - name: agenticai-prod
    accountId: "203874373290"
    profile: agenticai
    roleArn: arn:aws:iam::203874373290:role/eks-lens-spoke
    externalId: eks-lens
    regions: [us-east-2]
```

---

## 7. Troubleshooting (errors we actually hit)

| Message | Cause | Fix |
|---|---|---|
| `not authorized to perform: sts:AssumeRole on … eks-lens-spoke` | Trust policy does not match: external ID typo (`eks-lense` instead of `eks-lens`), wrong `aws:PrincipalArn`, or *Require MFA* ticked | Re-apply the trust policy from 3a with `update-assume-role-policy` |
| `The security token included in the request is invalid` | Sign-in method **Default credentials** on a laptop picks up old keys from `[default]` in `~/.aws/credentials` | Use **AWS CLI profile (SSO)** with `agenticai` |
| `Value '' at 'externalId' failed to satisfy constraint` | External ID box empty (fixed in EKS Lens 0.2: empty is now ignored) | Enter `eks-lens` |
| `You must be logged in to the server (Unauthorized)` | No EKS access entry for `eks-lens-spoke` | Step 4 |
| `Token has expired` / `SSO session … expired` | SSO session is over (8–12 h) | `aws sso login --profile agenticai`, then **Refresh** |
| No clusters found | Wrong region selected (e.g. us-east-1 instead of us-east-2) | Edit the account, pick the right region |
| Authentication mode error on `create-access-entry` | Cluster uses only the `aws-auth` ConfigMap | Switch to `API_AND_CONFIG_MAP` (step 4) |
| Prices "could not be read … estimated" | Role lacks `pricing:GetProducts` / `ec2:DescribeSpotPriceHistory` | Step 3b |
| `Metrics API not available` | metrics-server not installed | Install the add-on (prerequisites) |

---

## 8. Hosted app (Pod Identity)

When EKS Lens runs as a pod in `cd-internal-shared-eks`:

1. Create `eks-lens-hub` in 203874373290 and link it to the pod's service account with **EKS Pod Identity**: `deploy/terraform/hub` (needs the `eks-pod-identity-agent` add-on). Give it only `sts:AssumeRole` on `arn:aws:iam::*:role/eks-lens-spoke`.
2. Nothing changes in the spoke roles: `eks-lens-hub` is already allowed by the trust policy in 3a.
3. In EKS Lens, accounts use **Default credentials** + role `eks-lens-spoke` + external ID `eks-lens`.
4. Optional, once nobody uses the laptop setup: remove the SSO line from `aws:PrincipalArn` so only the hosted app can assume the role.

---

## 9. Security notes

- The external ID plus the exact `aws:PrincipalArn` condition mean only your SSO admin role and `eks-lens-hub` can use the role, even though the principal is the whole hub account.
- Role credentials last 1 hour; nothing long-lived is stored. On a laptop the only secret is the SSO token in `~/.aws/sso/cache`.
- Every call is recorded in CloudTrail under the session name `eks-lens`, and every reveal or change in the EKS Lens **Activity log**.
- Use `AmazonEKSViewPolicy` instead of ClusterAdmin for read-only accounts, and run EKS Lens with `WRITE_ENABLED=false`.

## 10. Remove the setup

```bash
aws eks delete-access-entry --cluster-name <cluster> --principal-arn arn:aws:iam::<account>:role/eks-lens-spoke --region <region> --profile <p>
aws iam delete-role-policy --role-name eks-lens-spoke --policy-name EksLensAccess --profile <p>
aws iam delete-role --role-name eks-lens-spoke --profile <p>
```
