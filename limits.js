/**
 * limits.js — Logic for SFMC License Governance & Capacity Analysis.
 */

// Default values are indicative — actual limits are negotiated per contract.
// Users should configure custom limits via the Limits dashboard onboarding.
export const SFMC_TIERS = {
  basic: {
    name: 'Basic',
    limits: {
      contacts: 15000,
      superMessages: 250000,
      storage: 10,
      automations: 5000,
      api: 1000000,
      users: 5
    }
  },
  pro: {
    name: 'Pro',
    limits: {
      contacts: 100000,
      superMessages: 5000000,
      storage: 25,
      automations: 25000,
      api: 5000000,
      users: 25
    }
  },
  corporate: {
    name: 'Corporate',
    limits: {
      contacts: 1000000,
      superMessages: 25000000,
      storage: 100,
      automations: 100000,
      api: 25000000,
      users: 100
    }
  },
  enterprise: {
    name: 'Enterprise',
    limits: {
      contacts: 10000000,
      superMessages: 150000000,
      storage: 500,
      automations: 500000,
      api: 200000000,
      users: 500
    }
  },
  custom: {
    name: 'Custom',
    limits: {
      contacts: 0,
      superMessages: 0,
      storage: 0,
      automations: 0,
      api: 0,
      users: 0
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
