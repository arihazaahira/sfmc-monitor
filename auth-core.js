/**
 * auth-core.js — OAuth 2.0 Client Credentials token management for Salesforce Core.
 * Handles token acquisition, caching, and refresh.
 */

const CORE_TOKEN_CACHE_KEY = 'sf_core_token_cache';
const CORE_CREDENTIALS_KEY = 'sf_core_credentials';

/**
 * Clean up the Login URL to ensure it's a valid base URL.
 */
function sanitizeLoginUrl(input) {
  if (!input) return '';
  let val = String(input).trim();
  // Ensure it has https://
  if (!val.startsWith('http')) {
    val = 'https://' + val;
  }
  // Remove trailing slashes
  val = val.replace(/\/+$/, '');
  // Extract just the origin
  try {
    const url = new URL(val);
    return url.origin;
  } catch (e) {
    return val;
  }
}

/**
 * Retrieve stored Salesforce Core credentials from chrome.storage.local.
 */
export async function getCoreCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CORE_CREDENTIALS_KEY], (result) => {
      let creds = result[CORE_CREDENTIALS_KEY] || null;
      if (creds && creds.loginUrl) {
        creds.loginUrl = sanitizeLoginUrl(creds.loginUrl);
      }
      resolve(creds);
    });
  });
}

/**
 * Save Salesforce Core credentials to chrome.storage.local.
 */
export async function saveCoreCredentials(clientId, clientSecret, loginUrl) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [CORE_CREDENTIALS_KEY]: { clientId, clientSecret, loginUrl }
    }, resolve);
  });
}

/**
 * Clear all stored Salesforce Core credentials and cached tokens.
 */
export async function clearCoreCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([CORE_CREDENTIALS_KEY, CORE_TOKEN_CACHE_KEY], resolve);
  });
}

/**
 * Retrieve a cached token entry.
 */
async function getCachedCoreToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CORE_TOKEN_CACHE_KEY], (result) => {
      resolve(result[CORE_TOKEN_CACHE_KEY] || null);
    });
  });
}

/**
 * Persist a token with its expiry timestamp and instance_url.
 */
async function cacheCoreToken(accessToken, instanceUrl, expiresIn = 7200) {
  const expiresAt = Date.now() + (expiresIn - 60) * 1000; // refresh 60s early
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [CORE_TOKEN_CACHE_KEY]: { accessToken, instanceUrl, expiresAt }
    }, resolve);
  });
}

/**
 * Invalidate the cached Core token (e.g., on 401).
 */
export async function invalidateCoreToken() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([CORE_TOKEN_CACHE_KEY], resolve);
  });
}

/**
 * Fetch a fresh access token from Salesforce Core using Client Credentials flow.
 */
async function fetchFreshCoreToken(credentials) {
  const { clientId, clientSecret, loginUrl } = credentials;
  const url = `${loginUrl}/services/oauth2/token`;

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
  } catch (networkError) {
    throw new Error(`Network error while authenticating to Salesforce Core: ${networkError.message}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody.error_description || errBody.error || JSON.stringify(errBody);
    } catch (_) {
      detail = response.statusText;
    }
    throw new Error(`Salesforce Core Authentication failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Salesforce Core Authentication failed: no access_token in response.');
  }

  // Usually Salesforce returns instance_url. If not, fallback to loginUrl
  const instanceUrl = data.instance_url || loginUrl;
  
  await cacheCoreToken(data.access_token, instanceUrl, 7200); // Default 2 hours if not provided
  return { accessToken: data.access_token, instanceUrl };
}

/**
 * Get a valid Salesforce Core access token and instance URL, using cache when possible.
 */
export async function getCoreTokenAndInstance() {
  const credentials = await getCoreCredentials();
  if (!credentials || !credentials.clientId || !credentials.clientSecret || !credentials.loginUrl) {
    throw new Error('CORE_NOT_CONFIGURED');
  }

  const cached = await getCachedCoreToken();
  if (cached && cached.expiresAt > Date.now()) {
    return { accessToken: cached.accessToken, instanceUrl: cached.instanceUrl };
  }

  // Token missing or expired — fetch fresh
  return fetchFreshCoreToken(credentials);
}

/**
 * Force a fresh token fetch regardless of cache (used after 401).
 */
export async function forceRefreshCoreToken() {
  await invalidateCoreToken();
  return getCoreTokenAndInstance();
}

/**
 * Check whether Salesforce Core credentials are configured.
 */
export async function isCoreConfigured() {
  const creds = await getCoreCredentials();
  return !!(creds && creds.clientId && creds.clientSecret && creds.loginUrl);
}
