import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DEFAULTS = {
  refreshSeconds: 60,
  readOnly: false,
  costModel: { hoursPerMonth: 730, spotDiscount: 0.65, cpuToMemCostRatio: 7.46, instancePrices: {} },
};

export function loadConfig() {
  const demo = String(process.env.DEMO_MODE || '').toLowerCase() === 'true';
  const file = process.env.ACCOUNTS_FILE || path.resolve('config/accounts.yaml');
  let raw = { settings: {}, accounts: [] };
  if (fs.existsSync(file)) {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) || raw;
  } else if (!demo) {
    console.warn(`[config] ${file} not found - starting with no accounts. Set DEMO_MODE=true to explore with sample data.`);
  }
  const s = raw.settings || {};
  const settings = {
    ...DEFAULTS,
    ...s,
    readOnly: String(process.env.READ_ONLY ?? s.readOnly ?? false) === 'true',
    costModel: { ...DEFAULTS.costModel, ...(s.costModel || {}), instancePrices: { ...(s.costModel?.instancePrices || {}) } },
  };
  const accounts = (raw.accounts || []).map((a) => ({
    name: a.name,
    accountId: String(a.accountId || ''),
    roleArn: a.roleArn || '',
    externalId: a.externalId || undefined,
    regions: a.regions?.length ? a.regions : [process.env.AWS_REGION || 'us-east-1'],
    clusters: a.clusters || null,
  }));
  return { demo, settings, accounts };
}
