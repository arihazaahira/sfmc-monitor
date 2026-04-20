/**
 * settings.js — Logic for the SFMC Dashboard settings / configuration page.
 * Handles: loading saved credentials, saving new ones, testing connection,
 * and clearing stored data.
 *
 * Security: client_secret is NEVER re-displayed once saved.
 */

import { saveCredentials, getCredentials, clearCredentials, getAccessToken } from './auth.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const form          = document.getElementById('settingsForm');
const fldSubdomain  = document.getElementById('subdomain');
const fldClientId   = document.getElementById('clientId');
const fldSecret     = document.getElementById('clientSecret');
const btnSave       = document.getElementById('btnSave');
const btnTest       = document.getElementById('btnTest');
const btnClear      = document.getElementById('btnClear');
const toggleSecret  = document.getElementById('toggleSecret');
const eyeIcon       = document.getElementById('eyeIcon');
const subdomainPreview = document.getElementById('subdomainPreview');
const toast         = document.getElementById('toast');
const connStatus    = document.getElementById('connStatus');
const connDot       = document.getElementById('connDot');
const connText      = document.getElementById('connText');
const testIcon      = document.getElementById('testIcon');

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
  fldClientId.value  = creds.clientId  || '';
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

  const subdomain  = sanitizeSubdomain(fldSubdomain.value);
  const clientId   = fldClientId.value.trim();
  const secretVal  = fldSecret.value; // may be empty if user didn't change it

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

    fldSubdomain.value = '';
    fldClientId.value  = '';
    fldSecret.value    = '';
    fldSecret.placeholder = '••••••••••••••••••••••••••••••••';
    subdomainPreview.textContent = 'Your REST endpoint will be: https://<subdomain>.rest.marketingcloudapis.com';
    subdomainPreview.className = 'subdomain-preview';
    btnTest.disabled = true;
    setConnStatus('', 'Not configured');

    showToast('🗑️ All credentials cleared.', 'info');
  } catch (err) {
    showToast(`❌ Clear failed: ${err.message}`, 'error');
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSavedCredentials();
