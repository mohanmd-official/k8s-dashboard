// On-demand Linux hourly prices (USD, us-east-1 list price, approximate).
// These are a fallback so the MVP works offline. Override per instance type in
// accounts.yaml (settings.costModel.instancePrices) or replace with the AWS Pricing
// API / CUR split-cost-allocation data in phase 2. Other regions differ by ~0-20%.
export const ON_DEMAND = {
  't3.medium': 0.0416, 't3.large': 0.0832, 't3.xlarge': 0.1664, 't3.2xlarge': 0.3328,
  't3a.medium': 0.0376, 't3a.large': 0.0752, 't3a.xlarge': 0.1504,
  'm5.large': 0.096, 'm5.xlarge': 0.192, 'm5.2xlarge': 0.384, 'm5.4xlarge': 0.768,
  'm6i.large': 0.096, 'm6i.xlarge': 0.192, 'm6i.2xlarge': 0.384, 'm6i.4xlarge': 0.768,
  'm6a.large': 0.0864, 'm6a.xlarge': 0.1728, 'm6a.2xlarge': 0.3456,
  'm6g.large': 0.077, 'm6g.xlarge': 0.154, 'm6g.2xlarge': 0.308,
  'm7i.large': 0.1008, 'm7i.xlarge': 0.2016, 'm7i.2xlarge': 0.4032,
  'm7g.large': 0.0816, 'm7g.xlarge': 0.1632, 'm7g.2xlarge': 0.3264,
  'c5.large': 0.085, 'c5.xlarge': 0.17, 'c5.2xlarge': 0.34,
  'c6i.large': 0.085, 'c6i.xlarge': 0.17, 'c6i.2xlarge': 0.34,
  'c6g.large': 0.068, 'c6g.xlarge': 0.136, 'c7g.large': 0.0725, 'c7g.xlarge': 0.145,
  'r5.large': 0.126, 'r5.xlarge': 0.252, 'r5.2xlarge': 0.504,
  'r6i.large': 0.126, 'r6i.xlarge': 0.252, 'r6g.large': 0.1008, 'r6g.xlarge': 0.2016,
  'r7g.large': 0.1071, 'r7g.xlarge': 0.2142,
};

export function nodeHourlyPrice(node, costModel) {
  const type = node.instanceType;
  const override = costModel.instancePrices?.[type];
  let od = override ?? ON_DEMAND[type];
  let estimated = false;
  if (od == null) {
    // Unknown type: estimate from capacity using an m-family-like rate.
    od = node.cpu * 0.024 + node.memGiB * 0.003;
    estimated = true;
  }
  const price = node.capacityType === 'SPOT' && override == null ? od * (1 - costModel.spotDiscount) : od;
  return { price, estimated };
}
