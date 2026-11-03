# IAM for EKS Lens (hub and spoke)

```
 Hub account                                   Each spoke account
 ┌──────────────────────────────┐   sts:AssumeRole   ┌──────────────────────────────┐
 │ EKS Lens pod                 │  (ExternalId)      │ role eks-lens-spoke          │
 │  └ Pod Identity → eks-lens-hub ─────────────────▶ │  eks:ListClusters/Describe    │
 └──────────────────────────────┘                    │  EKS access entry → group     │
                                                     │  "eks-lens" → ClusterRoles    │
                                                     └──────────────────────────────┘
```

1. `cd hub && terraform apply -var hub_cluster_name=cd-internal-shared-eks -var 'spoke_role_arns=["arn:aws:iam::111111111111:role/eks-lens-spoke","arn:aws:iam::222222222222:role/eks-lens-spoke"]'`
2. In each account (and each region with clusters): `cd spoke && terraform apply -var hub_role_arn=<output 1> -var 'cluster_names=["prod-eks-01"]'`
3. In each cluster: `kubectl apply -f ../rbac/eks-lens-clusterrole.yaml` (drop the `eks-lens-exec` binding for read-only clusters).
4. Each cluster needs metrics-server for CPU/memory usage: `aws eks create-addon --cluster-name <c> --addon-name metrics-server`.

No Terraform? The same is two IAM roles and one `aws eks create-access-entry --cluster-name <c> --principal-arn <spoke role> --kubernetes-groups eks-lens` per cluster.
