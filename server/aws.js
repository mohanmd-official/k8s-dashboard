// AWS side: credentials per account, cluster discovery, EKS bearer tokens.
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { fromNodeProviderChain, fromIni } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

const baseCreds = fromNodeProviderChain();
const profileCreds = new Map(); // profile -> provider
const credCache = new Map(); // account id -> { creds, exp }

/** Sign-in identity: static access keys, a local AWS profile, or the default chain. */
function sourceCreds(account) {
  if (account.authType === 'keys') {
    return { accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, sessionToken: account.sessionToken || undefined };
  }
  if (account.authType === 'profile' || account.profile) {
    if (!profileCreds.has(account.profile)) profileCreds.set(account.profile, fromIni({ profile: account.profile }));
    return profileCreds.get(account.profile);
  }
  return baseCreds;
}

/** Credentials for an account: its sign-in identity, then optionally an assumed role (cached ~50 min). */
export async function credentialsFor(account) {
  if (!account.roleArn) return sourceCreds(account);
  const ck = `${account.id || account.name}:${account.roleArn}`;
  const hit = credCache.get(ck);
  if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.creds;
  const sts = new STSClient({ credentials: sourceCreds(account), region: firstRegion(account) });
  const out = await sts.send(new AssumeRoleCommand({ RoleArn: account.roleArn, RoleSessionName: 'eks-lens', ExternalId: account.externalId, DurationSeconds: 3600 }));
  const c = out.Credentials;
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  credCache.set(ck, { creds, exp: c.Expiration.getTime() });
  return creds;
}
export function forgetAccount(account) {
  for (const k of credCache.keys()) if (k.startsWith(`${account.id || account.name}:`)) credCache.delete(k);
}

const firstRegion = (a) => (a.regions || []).find((r) => r !== 'all') || 'us-east-1';

export async function whoAmI(account) {
  const sts = new STSClient({ credentials: await credentialsFor(account), region: firstRegion(account) });
  const r = await sts.send(new GetCallerIdentityCommand({}));
  return { account: r.Account, arn: r.Arn, userId: r.UserId };
}

const regionCache = new Map();
/** Expand ["all"] into every region enabled for the account. */
export async function resolveRegions(account) {
  if (!account.regions?.includes('all')) return account.regions;
  const key = account.id || account.name;
  const hit = regionCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.list;
  const ec2 = new EC2Client({ credentials: await credentialsFor(account), region: 'us-east-1' });
  const r = await ec2.send(new DescribeRegionsCommand({}));
  const list = r.Regions.map((x) => x.RegionName).sort();
  regionCache.set(key, { at: Date.now(), list });
  return list;
}

/** All clusters reachable for one account across its regions. */
export async function discoverClusters(account) {
  const credentials = await credentialsFor(account);
  const regions = await resolveRegions(account);
  const perRegion = await Promise.all(regions.map(async (region) => {
    const eks = new EKSClient({ credentials, region });
    const found = [];
    let names = account.clusters;
    if (!names) {
      names = [];
      try {
        let nextToken;
        do {
          const r = await eks.send(new ListClustersCommand({ nextToken }));
          names.push(...(r.clusters || []));
          nextToken = r.nextToken;
        } while (nextToken);
      } catch (e) {
        // Regions that are not enabled or not allowed are skipped when scanning "all".
        if (account.regions.includes('all')) return [];
        throw e;
      }
    }
    for (const name of names) {
      try {
        const { cluster } = await eks.send(new DescribeClusterCommand({ name }));
        found.push({
          id: `${account.name}/${region}/${name}`, account: account.name, accountKey: account.id, accountId: account.accountId || cluster.arn?.split(':')[4] || '',
          region, name, version: cluster.version, status: cluster.status, endpoint: cluster.endpoint,
          caData: cluster.certificateAuthority?.data, platformVersion: cluster.platformVersion,
          supportType: cluster.upgradePolicy?.supportType,
        });
      } catch (e) {
        if (account.clusters) found.push({ id: `${account.name}/${region}/${name}`, account: account.name, accountKey: account.id, accountId: account.accountId, region, name, status: 'UNREACHABLE', error: e.message });
      }
    }
    return found;
  }));
  return perRegion.flat();
}

/**
 * EKS bearer token = "k8s-aws-v1." + base64url(presigned STS GetCallerIdentity URL),
 * with the cluster name bound in the signed x-k8s-aws-id header. Same as `aws eks get-token`.
 * Signed locally; no AWS API call is made here.
 */
export async function eksToken(account, region, clusterName) {
  const credentials = await credentialsFor(account);
  const hostname = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({ credentials, region, service: 'sts', sha256: Sha256 });
  const req = new HttpRequest({
    method: 'GET', protocol: 'https:', hostname, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host: hostname, 'x-k8s-aws-id': clusterName },
  });
  const signed = await signer.presign(req, { expiresIn: 60 });
  const qs = Object.entries(signed.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : v)}`)
    .join('&');
  return 'k8s-aws-v1.' + Buffer.from(`https://${hostname}/?${qs}`).toString('base64url');
}
