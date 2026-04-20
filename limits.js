/**
 * limits.js — Logic for SFMC License Governance & Capacity Analysis.
 */

export const SFMC_TIERS = {
  basic: {
    name: 'Basic',
    limits: {
      contacts: 0,
      superMessages: 250000,
      storage: 1, // GB
      automations: 0,
      api: 0,
      users: 5
    }
  },
  pro: {
    name: 'Pro',
    limits: {
      contacts: 15000,
      superMessages: 2500000,
      storage: 15,
      automations: 15000,
      api: 2000000,
      users: 15
    }
  },
  corporate: {
    name: 'Corporate',
    limits: {
      contacts: 45000,
      superMessages: 10000000,
      storage: 45,
      automations: 45000,
      api: 6000000,
      users: 45
    }
  },
  enterprise: {
    name: 'Enterprise',
    limits: {
      contacts: 500000,
      superMessages: 150000000,
      storage: 100,
      automations: 100000,
      api: 200000000,
      users: 100
    }
  }
};

export async function getClientConfig() {
  const data = await chrome.storage.local.get(['sfmc_client_config']);
  return data.sfmc_client_config || {
    clients: [] // { name, tier, manualStorageGb, ... }
  };
}

export async function saveClientConfig(config) {
  await chrome.storage.local.set({ sfmc_client_config: config });
}

export function calculateUsage(usage, limit) {
  if (!limit || limit === 0) return { percent: 0, status: 'ok', remaining: 0 };
  const percent = (usage / limit) * 100;
  let status = 'ok';
  if (percent >= 100) status = 'critical';
  else if (percent >= 80) status = 'warning';
  
  return {
    percent: Math.min(Math.round(percent), 200), // Cap visual % but allow over 100
    status,
    remaining: Math.max(0, limit - usage)
  };
}
