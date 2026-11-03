# SPOKE: apply once per AWS account you want to see (hub account included).
# Creates a role the hub may assume, and an EKS access entry in each listed cluster that maps
# the role to the Kubernetes group "eks-lens" (bound by deploy/rbac/eks-lens-clusterrole.yaml).
terraform {
  required_providers { aws = { source = "hashicorp/aws", version = ">= 5.40" } }
}

variable "hub_role_arn" { type = string }
variable "external_id" {
  type    = string
  default = "eks-lens"
}
variable "cluster_names" {
  description = "Clusters in this account/region the dashboard may read. Their authentication mode must be API or API_AND_CONFIG_MAP."
  type        = list(string)
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.hub_role_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

resource "aws_iam_role" "spoke" {
  name                 = "eks-lens-spoke"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "spoke" {
  statement {
    sid       = "DiscoverClusters"
    actions   = ["eks:ListClusters", "eks:DescribeCluster"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "spoke" {
  role   = aws_iam_role.spoke.id
  policy = data.aws_iam_policy_document.spoke.json
}

resource "aws_eks_access_entry" "eks_lens" {
  for_each          = toset(var.cluster_names)
  cluster_name      = each.value
  principal_arn     = aws_iam_role.spoke.arn
  kubernetes_groups = ["eks-lens"]
  type              = "STANDARD"
}

output "spoke_role_arn" { value = aws_iam_role.spoke.arn }
