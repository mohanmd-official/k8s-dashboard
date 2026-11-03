// AWS Secrets Manager for an account + region: list, read value, update value, create.
// Price note: Secrets Manager API calls cost $0.05 per 10,000; each stored secret costs
// about $0.40/month, so creating a secret here adds to the bill.
import {
  SecretsManagerClient, ListSecretsCommand, GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand, DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { credentialsFor } from './aws.js';

const client = async (account, region) => new SecretsManagerClient({ credentials: await credentialsFor(account), region });

export async function listSecrets(account, region) {
  const sm = await client(account, region);
  const out = [];
  let NextToken;
  do {
    const r = await sm.send(new ListSecretsCommand({ NextToken, MaxResults: 100 }));
    for (const s of r.SecretList || []) {
      out.push({
        arn: s.ARN, name: s.Name, description: s.Description || '', kmsKeyId: s.KmsKeyId || 'aws/secretsmanager',
        rotationEnabled: !!s.RotationEnabled, nextRotation: s.NextRotationDate, lastChanged: s.LastChangedDate, lastAccessed: s.LastAccessedDate,
        created: s.CreatedDate, owningService: s.OwningService || '', tags: Object.fromEntries((s.Tags || []).map((t) => [t.Key, t.Value])),
        primaryRegion: s.PrimaryRegion || region,
      });
    }
    NextToken = r.NextToken;
  } while (NextToken && out.length < 2000);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSecretValue(account, region, id) {
  const sm = await client(account, region);
  const [v, d] = await Promise.all([sm.send(new GetSecretValueCommand({ SecretId: id })), sm.send(new DescribeSecretCommand({ SecretId: id }))]);
  const raw = v.SecretString ?? (v.SecretBinary ? `(binary, ${v.SecretBinary.length} bytes)` : '');
  let json = null;
  try { const p = JSON.parse(raw); if (p && typeof p === 'object' && !Array.isArray(p)) json = p; } catch { /* plain text */ }
  return { name: d.Name, arn: d.ARN, versionId: v.VersionId, stages: v.VersionStages, raw, json, binary: !v.SecretString };
}

export async function putSecretValue(account, region, id, value) {
  const sm = await client(account, region);
  const r = await sm.send(new PutSecretValueCommand({ SecretId: id, SecretString: value }));
  return { ok: true, versionId: r.VersionId };
}

export async function createSecret(account, region, { name, value, description }) {
  if (!/^[A-Za-z0-9/_+=.@-]{1,512}$/.test(name || '')) throw Object.assign(new Error('Secret name may use letters, numbers and / _ + = . @ -'), { status: 400 });
  const sm = await client(account, region);
  const r = await sm.send(new CreateSecretCommand({ Name: name, SecretString: value, Description: description || undefined, Tags: [{ Key: 'created-by', Value: 'eks-lens' }] }));
  return { ok: true, arn: r.ARN };
}
