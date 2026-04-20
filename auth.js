/**
 * auth.js — OAuth 2.0 Client Credentials token management for SFMC.
 * Handles token acquisition, caching, and refresh.
 * NEVER logs or exposes client_secret.
 */

const TOKEN_CACHE_KEY = 'sfmc_token_cache';
const CREDENTIALS_KEY = 'sfmc_credentials';

/**
 * Extract just the subdomain token from whatever is stored.
 * Guards against full URLs being saved (e.g. https://xxx.auth.marketingcloudapis.com/).
 */
function sanitizeSubdomain(input) {
  if (!input) return '';
  let val = String(input).trim();
  // Strip protocols (handles malformed inputs like "https://https//")
  val = val.replace(/^(?:https?[:/]+)+/i, '');
  // Strip known SFMC domain suffixes (+anything after)
  val = val.replace(/\.(auth|rest|soap)\.marketingcloudapis\.com.*$/i, '');
  // Strip any remaining path segments or query strings
  val = val.split('/')[0];
  // Strip trailing dots
  val = val.replace(/\.$/, '');
  return val;
}

/**
 * Retrieve stored credentials from chrome.storage.local.
 * Returns null if not configured.
 */
export async function getCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CREDENTIALS_KEY], (result) => {
      const creds = result[CREDENTIALS_KEY] || null;
      if (creds && creds.subdomain) {
        // Always sanitize on read — fixes any previously stored full URLs
        creds.subdomain = sanitizeSubdomain(creds.subdomain);
      }
      resolve(creds);
    });
  });
}

/**
 * Save credentials to chrome.storage.local.
 */
export async function saveCredentials(clientId, clientSecret, subdomain) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [CREDENTIALS_KEY]: { clientId, clientSecret, subdomain }
    }, resolve);
  });
}

/**
 * Clear all stored credentials and cached tokens.
 */
export async function clearCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([CREDENTIALS_KEY, TOKEN_CACHE_KEY], resolve);
  });
}

/**
 * Retrieve a cached token entry.
 */
async function getCachedToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([TOKEN_CACHE_KEY], (result) => {
      resolve(result[TOKEN_CACHE_KEY] || null);
    });
  });
}

/**
 * Persist a token with its expiry timestamp.
 */
async function cacheToken(accessToken, expiresIn) {
  const expiresAt = Date.now() + (expiresIn - 60) * 1000; // refresh 60s early
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [TOKEN_CACHE_KEY]: { accessToken, expiresAt }
    }, resolve);
  });
}

/**
 * Invalidate the cached token (e.g., on 401).
 */
export async function invalidateToken() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([TOKEN_CACHE_KEY], resolve);
  });
}

/**
 * Fetch a fresh access token from SFMC using Client Credentials flow.
 * Throws a descriptive Error on failure.
 */
async function fetchFreshToken(credentials) {
  const { clientId, clientSecret, subdomain } = credentials;
  const url = `https://${subdomain}.auth.marketingcloudapis.com/v2/token`;

  const body = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  } catch (networkError) {
    throw new Error(`Network error while authenticating: ${networkError.message}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody.error_description || errBody.message || JSON.stringify(errBody);
    } catch (_) {
      detail = response.statusText;
    }
    throw new Error(`Authentication failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Authentication failed: no access_token in response.');
  }

  await cacheToken(data.access_token, data.expires_in || 3600);
  return data.access_token;
}

/**
 * Get a valid access token, using cache when possible.
 * Throws if credentials are missing or auth fails.
 */
export async function getAccessToken() {
  const credentials = await getCredentials();
  if (!credentials) {
    throw new Error('NOT_CONFIGURED');
  }

  const cached = await getCachedToken();
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  // Token missing or expired — fetch fresh
  return fetchFreshToken(credentials);
}

/**
 * Force a fresh token fetch regardless of cache (used after 401).
 */
export async function forceRefreshToken() {
  await invalidateToken();
  return getAccessToken();
}

/**
 * Check whether credentials are configured.
 */
export async function isConfigured() {
  const creds = await getCredentials();
  return !!(creds && creds.clientId && creds.clientSecret && creds.subdomain);
}
