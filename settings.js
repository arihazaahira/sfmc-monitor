/**
 * settings.js — Logic for the SFMC Dashboard settings / configuration page.
 * Handles: loading saved credentials, saving new ones, testing connection,
 * and clearing stored data.
 *
 * Security: client_secret is NEVER re-displayed once saved.
 */

import { saveCredentials, getCredentials, clearCredentials, getAccessToken } from './auth.js';
import { saveCoreCredentials, getCoreCredentials, clearCoreCredentials, getCoreTokenAndInstance } from './auth-core.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const form = document.getElementById('settingsForm');
const fldSubdomain = document.getElementById('subdomain');
const fldClientId = document.getElementById('clientId');
const fldSecret = document.getElementById('clientSecret');
const btnSave = document.getElementById('btnSave');
const btnTest = document.getElementById('btnTest');
const btnClear = document.getElementById('btnClear');
const toggleSecret = document.getElementById('toggleSecret');
const eyeIcon = document.getElementById('eyeIcon');
const subdomainPreview = document.getElementById('subdomainPreview');
const toast = document.getElementById('toast');
const connStatus = document.getElementById('connStatus');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const testIcon = document.getElementById('testIcon');

const fldAiKey = document.getElementById('anthropicKey');
const toggleAiKey = document.getElementById('toggleAiKey');
const eyeIconAi = document.getElementById('eyeIconAi');
const btnSaveAi = document.getElementById('btnSaveAi');

const fldCoreLoginUrl = document.getElementById('coreLoginUrl');
const fldCoreClientId = document.getElementById('coreClientId');
const fldCoreSecret = document.getElementById('coreClientSecret');
const btnSaveCore = document.getElementById('btnSaveCore');
const toggleCoreSecret = document.getElementById('toggleCoreSecret');
const eyeIconCore = document.getElementById('eyeIconCore');

// ─── Toast ───────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = 'info', duration = 3500) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `show ${type}`;
  toastTimer = setTimeout(() => { toast.className = ''; }, duration);
}

// ─── Connection status badge ─────────────────────────────────────────────────

function setConnStatus(state, text) {
  connStatus.className = `conn-status ${state}`;
  connText.textContent = text;
}

// ─── Subdomain sanitizer ─────────────────────────────────────────────────────

/**
 * Extract just the subdomain token from whatever the user pastes.
 * Handles full URLs like:
 *   https://mct8vv9h4h0gy1x8xmv8np06rlpy.auth.marketingcloudapis.com/
 *   https://mct8vv9h4h0gy1x8xmv8np06rlpy.rest.marketingcloudapis.com
 *   mct8vv9h4h0gy1x8xmv8np06rlpy
 */
function sanitizeSubdomain(input) {
  let val = input.trim();
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

// ─── Subdomain live preview ──────────────────────────────────────────────────

fldSubdomain.addEventListener('input', () => {
  const raw = fldSubdomain.value;
  const val = sanitizeSubdomain(raw);
  if (val) {
    subdomainPreview.textContent = `REST: https://${val}.rest.marketingcloudapis.com`;
    subdomainPreview.className = 'subdomain-preview active';
  } else {
    subdomainPreview.textContent = 'Your REST endpoint will be: https://<subdomain>.rest.marketingcloudapis.com';
    subdomainPreview.className = 'subdomain-preview';
  }
});

// ─── Show / hide secret ───────────────────────────────────────────────────────

let secretVisible = false;
toggleSecret.addEventListener('click', () => {
  secretVisible = !secretVisible;
  fldSecret.type = secretVisible ? 'text' : 'password';
  // Swap eye icon to eye-off
  eyeIcon.innerHTML = secretVisible
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
});

// ─── Load existing credentials on page open ───────────────────────────────────

async function loadSavedCredentials() {
  const creds = await getCredentials();
  if (!creds) {
    setConnStatus('', 'Not configured');
    return;
  }

  fldSubdomain.value = creds.subdomain || '';
  fldClientId.value = creds.clientId || '';
  // NEVER re-populate the secret field — show placeholder only
  fldSecret.placeholder = creds.clientSecret
    ? '••••••••  (saved — enter new value to change)'
    : '••••••••••••••••••••••••••••••••';

  // Update subdomain preview
  if (creds.subdomain) {
    subdomainPreview.textContent = `REST: https://${creds.subdomain}.rest.marketingcloudapis.com`;
    subdomainPreview.className = 'subdomain-preview active';
  }

  btnTest.disabled = false;
  setConnStatus('', 'Credentials saved');
}

// ─── Save ─────────────────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const subdomain = sanitizeSubdomain(fldSubdomain.value);
  const clientId = fldClientId.value.trim();
  const secretVal = fldSecret.value; // may be empty if user didn't change it

  if (!subdomain || !clientId) {
    showToast('⚠️ Subdomain and Client ID are required.', 'error');
    return;
  }

  // Write the cleaned value back so the user sees what was stored
  fldSubdomain.value = subdomain;

  btnSave.disabled = true;
  btnSave.innerHTML = `
    <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
    Saving…`;

  try {
    // If user left the secret field blank, reload the old secret from storage
    let secretToSave = secretVal;
    if (!secretToSave) {
      const existing = await getCredentials();
      secretToSave = existing?.clientSecret || '';
    }

    if (!secretToSave) {
      showToast('⚠️ Client Secret is required.', 'error');
      return;
    }

    await saveCredentials(clientId, secretToSave, subdomain);
    showToast('✅ Credentials saved successfully.', 'success');
    btnTest.disabled = false;
    setConnStatus('', 'Credentials saved');

    // Clear secret field for security
    fldSecret.value = '';
    fldSecret.placeholder = '••••••••  (saved — enter new value to change)';
  } catch (err) {
    showToast(`❌ Save failed: ${err.message}`, 'error');
  } finally {
    btnSave.disabled = false;
    btnSave.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      Save Credentials`;
  }
});

// ─── Test connection ──────────────────────────────────────────────────────────

btnTest.addEventListener('click', async () => {
  btnTest.disabled = true;
  testIcon.classList.add('spin');
  setConnStatus('', 'Testing…');

  try {
    await getAccessToken(); // will throw if auth fails
    setConnStatus('ok', 'Connected ✓');
    showToast('✅ Connection successful!', 'success');
  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg === 'NOT_CONFIGURED') {
      setConnStatus('err', 'Not configured');
      showToast('⚠️ Save credentials first.', 'error');
    } else {
      setConnStatus('err', 'Auth failed');
      showToast(`❌ ${msg}`, 'error', 5000);
    }
  } finally {
    btnTest.disabled = false;
    testIcon.classList.remove('spin');
  }
});

// ─── Clear all ────────────────────────────────────────────────────────────────

btnClear.addEventListener('click', async () => {
  if (!confirm('Clear all stored credentials and cached tokens? This cannot be undone.')) return;

  try {
    await clearCredentials();
    await clearCoreCredentials();

    fldSubdomain.value = '';
    fldClientId.value = '';
    fldSecret.value = '';
    fldSecret.placeholder = '••••••••••••••••••••••••••••••••';

    fldCoreLoginUrl.value = '';
    fldCoreClientId.value = '';
    fldCoreSecret.value = '';
    fldCoreSecret.placeholder = '••••••••••••••••••••••••••••••••';

    subdomainPreview.textContent = 'Your REST endpoint will be: https://<subdomain>.rest.marketingcloudapis.com';
    subdomainPreview.className = 'subdomain-preview';
    btnTest.disabled = true;
    setConnStatus('', 'Not configured');

    showToast('🗑️ All credentials cleared.', 'info');
  } catch (err) {
    showToast(`❌ Clear failed: ${err.message}`, 'error');
  }
});

// ─── AI config storage helpers ────────────────────────────────────────────────

async function saveAiConfig(apiKey) {
  return chrome.storage.local.set({ sfmc_ai_config: { anthropicApiKey: apiKey } });
}

async function getAiConfig() {
  const result = await chrome.storage.local.get('sfmc_ai_config');
  return result.sfmc_ai_config || null;
}

// ─── AI key toggle visibility ─────────────────────────────────────────────────

let aiKeyVisible = false;
toggleAiKey.addEventListener('click', () => {
  aiKeyVisible = !aiKeyVisible;
  fldAiKey.type = aiKeyVisible ? 'text' : 'password';
  eyeIconAi.innerHTML = aiKeyVisible
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
});

// ─── Core key toggle visibility ─────────────────────────────────────────────────

let coreSecretVisible = false;
toggleCoreSecret.addEventListener('click', () => {
  coreSecretVisible = !coreSecretVisible;
  fldCoreSecret.type = coreSecretVisible ? 'text' : 'password';
  eyeIconCore.innerHTML = coreSecretVisible
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
});

// ─── Load AI config on page open ──────────────────────────────────────────────

async function loadAiConfig() {
  const config = await getAiConfig();
  if (config?.anthropicApiKey) {
    fldAiKey.placeholder = 'sk-ant-••••••••  (saved — enter new value to change)';
  }
}

// ─── Load Core config on page open ──────────────────────────────────────────────

async function loadCoreCredentials() {
  const creds = await getCoreCredentials();
  if (!creds) return;

  fldCoreLoginUrl.value = creds.loginUrl || '';
  fldCoreClientId.value = creds.clientId || '';
  fldCoreSecret.placeholder = creds.clientSecret
    ? '••••••••  (saved — enter new value to change)'
    : '••••••••••••••••••••••••••••••••';
}

// ─── Save AI key ──────────────────────────────────────────────────────────────

btnSaveAi.addEventListener('click', async () => {
  const keyVal = fldAiKey.value.trim();

  if (!keyVal) {
    const existing = await getAiConfig();
    if (!existing?.anthropicApiKey) {
      showToast('⚠️ Please enter an Anthropic API key.', 'error');
    } else {
      showToast('ℹ️ No change — existing key kept.', 'info');
    }
    return;
  }

  // Anthropic API keys start with "sk-ant-" and are at least 40 chars
  if (!keyVal.startsWith('sk-ant-') || keyVal.length < 40) {
    showToast('⚠️ Invalid key format. Anthropic keys start with sk-ant-', 'error');
    return;
  }

  btnSaveAi.disabled = true;
  try {
    await saveAiConfig(keyVal);
    showToast('✅ Anthropic API key saved.', 'success');
    fldAiKey.value = '';
    fldAiKey.placeholder = 'sk-ant-••••••••  (saved — enter new value to change)';
  } catch (err) {
    showToast(`❌ Save failed: ${err.message}`, 'error');
  } finally {
    btnSaveAi.disabled = false;
  }
});

// ─── Save Core key ──────────────────────────────────────────────────────────────

btnSaveCore.addEventListener('click', async () => {
  const loginUrl = fldCoreLoginUrl.value.trim();
  const clientId = fldCoreClientId.value.trim();
  const secretVal = fldCoreSecret.value;

  if (!loginUrl || !clientId) {
    showToast('⚠️ Login URL and Client ID are required.', 'error');
    return;
  }

  btnSaveCore.disabled = true;

  try {
    let secretToSave = secretVal;
    if (!secretToSave) {
      const existing = await getCoreCredentials();
      secretToSave = existing?.clientSecret || '';
    }

    if (!secretToSave) {
      showToast('⚠️ Client Secret is required.', 'error');
      btnSaveCore.disabled = false;
      return;
    }

    await saveCoreCredentials(clientId, secretToSave, loginUrl);
    showToast('✅ Core Credentials saved successfully.', 'success');

    fldCoreSecret.value = '';
    fldCoreSecret.placeholder = '••••••••  (saved — enter new value to change)';
  } catch (err) {
    showToast(`❌ Save failed: ${err.message}`, 'error');
  } finally {
    btnSaveCore.disabled = false;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSavedCredentials();
loadAiConfig();
loadCoreCredentials();
