// AWS side: assume a role per account, discover EKS clusters, mint EKS bearer tokens.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { fromNodeProviderChain, fromIni } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

const baseCreds = fromNodeProviderChain();
const profileCreds = new Map(); // profile -> provider
const credCache = new Map(); // accountName -> { creds, exp }

/** Starting identity for an account: a named local AWS profile (SSO or keys), else the default chain. */
function sourceCreds(account) {
  if (!account.profile) return baseCreds;
  if (!profileCreds.has(account.profile)) profileCreds.set(account.profile, fromIni({ profile: account.profile }));
  return profileCreds.get(account.profile);
}

/** Credentials for an account: its source identity, or an assumed spoke role (cached ~50 min). */
export async function credentialsFor(account) {
  if (!account.roleArn) return sourceCreds(account);
  const hit = credCache.get(account.name);
  if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.creds;
  const sts = new STSClient({ credentials: sourceCreds(account), region: account.regions[0] });
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: account.roleArn,
    RoleSessionName: 'eks-lens',
    ExternalId: account.externalId,
    DurationSeconds: 3600,
  }));
  const c = out.Credentials;
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  credCache.set(account.name, { creds, exp: c.Expiration.getTime() });
  return creds;
}

/** All clusters reachable for one account across its regions. */
export async function discoverClusters(account) {
  const credentials = await credentialsFor(account);
  const found = [];
  for (const region of account.regions) {
    const eks = new EKSClient({ credentials, region });
    let names = account.clusters;
    if (!names) {
      names = [];
      let nextToken;
      do {
        const r = await eks.send(new ListClustersCommand({ nextToken }));
        names.push(...(r.clusters || []));
        nextToken = r.nextToken;
      } while (nextToken);
    }
    for (const name of names) {
      try {
        const { cluster } = await eks.send(new DescribeClusterCommand({ name }));
        found.push({
          id: `${account.name}/${region}/${name}`,
          account: account.name,
          accountId: account.accountId,
          region,
          name,
          version: cluster.version,
          status: cluster.status,
          endpoint: cluster.endpoint,
          caData: cluster.certificateAuthority?.data,
          platformVersion: cluster.platformVersion,
        });
      } catch (e) {
        if (account.clusters) found.push({ id: `${account.name}/${region}/${name}`, account: account.name, accountId: account.accountId, region, name, status: 'UNREACHABLE', error: e.message });
      }
    }
  }
  return found;
}

/**
 * EKS bearer token = "k8s-aws-v1." + base64url(presigned STS GetCallerIdentity URL),
 * with the cluster name bound in the signed x-k8s-aws-id header. Same thing
 * `aws eks get-token` does. Valid for 15 minutes.
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
  const url = `https://${hostname}/?${qs}`;
  return 'k8s-aws-v1.' + Buffer.from(url).toString('base64url');
}
