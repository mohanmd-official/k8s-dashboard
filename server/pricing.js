// Node prices. Order of preference for each node:
//   1. settings.costModel.instancePrices override (your negotiated/RI/Savings Plan rate)
//   2. Spot nodes: the latest real spot price for that instance type in that AZ
//      (ec2:DescribeSpotPriceHistory)
//   3. On-demand: the AWS Price List API for that instance type in that region
//      (pricing:GetProducts), cached 7 days in the database
//   4. Built-in us-east-1 table below (offline fallback)
//   5. Estimate from vCPU / memory
// All of these API calls are free.
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { EC2Client, DescribeSpotPriceHistoryCommand } from '@aws-sdk/client-ec2';
import { db } from './db.js';
import { credentialsFor } from './aws.js';

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

const OD_TTL = 7 * 24 * 3600_000;
const SPOT_TTL = 3600_000;
const mem = new Map(); // in-process cache in front of the DB

const inflight = new Map(); // dedupe concurrent lookups of the same price
async function cached(key, ttl, fetcher) {
  if (inflight.has(key)) return inflight.get(key);
  const p = cachedInner(key, ttl, fetcher).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function cachedInner(key, ttl, fetcher) {
  const m = mem.get(key);
  if (m && Date.now() - m.at < ttl) return m.v;
  try {
    const row = (await db.all('SELECT price, source, fetched_at FROM price_cache WHERE price_key = $1', [key]))[0];
    if (row && Date.now() - new Date(row.fetched_at).getTime() < ttl) {
      const v = { price: Number(row.price), source: row.source };
      mem.set(key, { at: new Date(row.fetched_at).getTime(), v });
      return v;
    }
  } catch { /* db not ready */ }
  const v = await fetcher();
  if (v) {
    mem.set(key, { at: Date.now(), v });
    await db.run(`INSERT INTO price_cache (price_key, price, source, fetched_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (price_key) DO UPDATE SET price=excluded.price, source=excluded.source, fetched_at=excluded.fetched_at`,
    [key, v.price, v.source, new Date().toISOString()]).catch(() => {});
  }
  return v;
}

async function onDemandFromApi(account, region, instanceType) {
  return cached(`od:${region}:${instanceType}`, OD_TTL, async () => {
    try {
      const client = new PricingClient({ credentials: await credentialsFor(account), region: 'us-east-1' });
      const f = (Field, Value) => ({ Type: 'TERM_MATCH', Field, Value });
      const r = await client.send(new GetProductsCommand({
        ServiceCode: 'AmazonEC2', MaxResults: 10,
        Filters: [f('instanceType', instanceType), f('regionCode', region), f('operatingSystem', 'Linux'), f('tenancy', 'Shared'),
          f('preInstalledSw', 'NA'), f('capacitystatus', 'Used'), f('licenseModel', 'No License required')],
      }));
      for (const item of r.PriceList || []) {
        const p = typeof item === 'string' ? JSON.parse(item) : item;
        for (const term of Object.values(p.terms?.OnDemand || {})) {
          for (const dim of Object.values(term.priceDimensions || {})) {
            const usd = parseFloat(dim.pricePerUnit?.USD);
            if (usd > 0) return { price: usd, source: 'AWS Price List API' };
          }
        }
      }
    } catch { /* no pricing:GetProducts permission or no network */ }
    return null;
  });
}

async function spotFromApi(account, region, zone, instanceType) {
  if (!zone) return null;
  return cached(`spot:${zone}:${instanceType}`, SPOT_TTL, async () => {
    try {
      const ec2 = new EC2Client({ credentials: await credentialsFor(account), region });
      const r = await ec2.send(new DescribeSpotPriceHistoryCommand({
        InstanceTypes: [instanceType], AvailabilityZone: zone, ProductDescriptions: ['Linux/UNIX'], StartTime: new Date(), MaxResults: 5,
      }));
      const latest = (r.SpotPriceHistory || []).sort((a, b) => b.Timestamp - a.Timestamp)[0];
      if (latest) return { price: parseFloat(latest.SpotPrice), source: 'EC2 spot price history' };
    } catch { /* no permission */ }
    return null;
  });
}

/** Adds hourlyPrice, priceSource and priceEstimated to each node. */
export async function priceNodes(nodes, account, region, costModel) {
  const live = costModel.livePricing !== false && account;
  await Promise.all(nodes.map(async (n) => {
    const override = costModel.instancePrices?.[n.instanceType];
    if (override != null) { Object.assign(n, { hourlyPrice: override, priceSource: 'Your override', priceEstimated: false }); return; }
    if (n.capacityType === 'FARGATE') { Object.assign(n, { hourlyPrice: 0, priceSource: 'Fargate (billed per pod, not included)', priceEstimated: true }); return; }
    if (n.capacityType === 'SPOT' && live) {
      const s = await spotFromApi(account, region, n.zone, n.instanceType);
      if (s) { Object.assign(n, { hourlyPrice: s.price, priceSource: s.source, priceEstimated: false }); return; }
    }
    let od = live ? await onDemandFromApi(account, region, n.instanceType) : null;
    if (!od && ON_DEMAND[n.instanceType] != null) od = { price: ON_DEMAND[n.instanceType], source: 'Built-in table (us-east-1)' };
    let estimated = false;
    if (!od) { od = { price: n.cpu * 0.024 + n.memGiB * 0.003, source: 'Estimate from vCPU/memory' }; estimated = true; }
    if (n.capacityType === 'SPOT') {
      Object.assign(n, { hourlyPrice: od.price * (1 - costModel.spotDiscount), priceSource: `${od.source} × spot discount`, priceEstimated: true });
    } else {
      Object.assign(n, { hourlyPrice: od.price, priceSource: od.source, priceEstimated: estimated || od.source.startsWith('Built-in') });
    }
  }));
  return nodes;
}
