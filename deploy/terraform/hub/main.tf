# HUB account: the account whose EKS cluster runs EKS Lens.
# Creates the dashboard's own IAM role (via EKS Pod Identity) that may assume the spoke role in each account.
terraform {
  required_providers { aws = { source = "hashicorp/aws", version = ">= 5.40" } }
}

variable "hub_cluster_name" { type = string }
variable "namespace" {
  type    = string
  default = "eks-lens"
}
variable "service_account" {
  type    = string
  default = "eks-lens"
}
variable "spoke_role_arns" {
  description = "arn:aws:iam::<acct>:role/eks-lens-spoke for every account to view (include the hub account itself)"
  type        = list(string)
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "hub" {
  name               = "eks-lens-hub"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "hub" {
  statement {
    sid       = "AssumeSpokes"
    actions   = ["sts:AssumeRole"]
    resources = var.spoke_role_arns
  }
}

resource "aws_iam_role_policy" "hub" {
  role   = aws_iam_role.hub.id
  policy = data.aws_iam_policy_document.hub.json
}

# Requires the "eks-pod-identity-agent" add-on on the hub cluster.
resource "aws_eks_pod_identity_association" "eks_lens" {
  cluster_name    = var.hub_cluster_name
  namespace       = var.namespace
  service_account = var.service_account
  role_arn        = aws_iam_role.hub.arn
}

output "hub_role_arn" { value = aws_iam_role.hub.arn }
