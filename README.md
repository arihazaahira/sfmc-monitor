# SFMC Dashboard — Chrome Extension

## Executive Summary

The **SFMC Dashboard** is an advanced supervision and monitoring solution specifically designed to safeguard your Salesforce Marketing Cloud (SFMC) instances. Built with business continuity in mind, it serves as a proactive alert system that empowers marketing teams and technical consultants with complete oversight of their core marketing operations.

By continuously monitoring the health of your SFMC environment, the extension translates complex system behaviors into clear, business-critical insights. It actively notifies key stakeholders about critical events, including:

* **Process Automation Failures:** Instant alerts when marketing automations or background processes break down, minimizing operational downtime.
* **Capacity & Limit Thresholds:** Proactive notifications when anticipating or exceeding SFMC contractual limits (e.g., Contacts volume, Data Extension storage constraints).
* **Synchronization Health:** Immediate warnings regarding data integration issues and synchronization breakdowns, ensuring structural data integrity.

Designed to abstract technical complexities, this platform delivers a robust, actionable, and purely business-driven monitoring experience—ensuring a secure and high-performing marketing ecosystem.

---

A production-ready Chrome extension that displays key **Salesforce Marketing Cloud** metrics in a real-time popup dashboard.

---

## Features

| Feature | Details |
|---|---|
| 🔐 OAuth 2.0 | Client Credentials flow via SFMC Installed Package |
| 📊 KPI Dashboard | Contacts, Data Extensions, Automations |
| ⚡ Smart Cache | 60-second metric caching to avoid redundant calls |
| 🔄 Auto Refresh | Token auto-refresh before expiry |
| 🛡️ Secure Storage | Credentials stored in `chrome.storage.local` only |
| ❌ Error Handling | Auth failures, 401 retries, network errors |

---

## Extension Structure

```
sfmc-dashboard-extension/
├── manifest.json       Manifest V3 configuration
├── background.js       Service worker: message routing
├── auth.js             OAuth 2.0 token management
├── api.js              SFMC REST API calls + cache
├── popup.html          Dashboard UI
├── popup.js            Dashboard UI logic
├── settings.html       Configuration page
├── settings.js         Settings page logic
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Step 1 — Create an SFMC Installed Package

1. Log in to **Salesforce Marketing Cloud**.
2. Navigate to **Setup** → **Apps** → **Installed Packages**.
3. Click **New**, name it (e.g. `SFMC Dashboard`), and click **Save**.
4. Click **Add Component** → **API Integration**.
5. Select **Server-to-Server** integration type.
6. Grant the following minimum scopes:
   - `Contacts` → **Read**
   - `Data Extensions` → **Read**
   - `Automations` → **Read**
7. Click **Save**.
8. You will now see:
   - **Client Id** — copy this
   - **Client Secret** — copy this (shown once; store it securely)

---

## Step 2 — Find Your Subdomain

Your **subdomain** is the unique prefix in your Marketing Cloud tenant URLs.

Example: if your auth URL is  
`https://mc123abc.auth.marketingcloudapis.com`  
then your subdomain is **`mc123abc`**.

You can also find it in:  
**Setup** → **Company Settings** → **Business Units** → look at the endpoint URLs.

---

## Step 3 — Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `sfmc-dashboard-extension/` folder.
5. The extension icon will appear in the Chrome toolbar.

---

## Step 4 — Configure the Extension

1. Click the SFMC Dashboard extension icon in the toolbar.
2. You'll see the **Setup Required** screen — click **Open Settings**.
3. Enter your:
   - **Subdomain** (e.g. `mc123abc`)
   - **Client ID**
   - **Client Secret**
4. Click **Save Credentials**.
5. Click **Test Connection** to verify authentication works.
6. Close the settings tab and click the extension icon — your dashboard will load.

---

## API Endpoints Used

| Metric | Endpoint | Fallback |
|---|---|---|
| Contacts | `GET /contacts/v1/contacts/count` | `GET /contacts/v1/contacts?$page=1&$pageSize=1` |
| Data Extensions | `GET /asset/v1/content/assets?$filter=assetType.name='dataextension'` | Paginated |
| Automations | `GET /automation/v1/automations` | Paginated |

All requests use:
```
Authorization: Bearer <access_token>
```

Token endpoint:
```
POST https://<subdomain>.auth.marketingcloudapis.com/v2/token
{
  "grant_type": "client_credentials",
  "client_id":  "<your_client_id>",
  "client_secret": "<your_client_secret>"
}
```

---

## Security Architecture

```
User Input → chrome.storage.local (encrypted by OS keychain)
                    ↓
           background.js (service worker)
                    ↓
            SFMC Auth API → access_token (cached in storage, expires -60s)
                    ↓
            SFMC REST API (Bearer token)
                    ↓
            popup.js (display only — never sees client_secret)
```

**Security guarantees:**
- `client_secret` is never logged, never displayed after saving, never sent to any third party
- All API calls go directly to `*.marketingcloudapis.com`
- Tokens are cached and refreshed automatically; a 401 triggers one retry with a fresh token
- Clearing credentials removes **all** stored data from `chrome.storage.local`

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Not configured" | No credentials saved | Open Settings, enter credentials |
| "Authentication Error" | Wrong client_id / secret | Verify credentials in SFMC Installed Package |
| "Authentication Error" after saving | Scopes missing | Add `contacts_read`, `data_extensions_read`, `automations_read` to the package |
| Numbers show `—` | API endpoint not available | Check if the Business Unit has Contacts/Automation Studio enabled |
| "Network Error" | No internet / CORS | Ensure you're not behind a strict proxy blocking `*.marketingcloudapis.com` |
| 401 loop | Token revoked | Click Settings → Clear All, re-enter credentials |

---

## Development Notes

- **Manifest V3** service workers have no persistent state; all state is in `chrome.storage.local`.
- The extension uses **ES Modules** (`type: module`) for clean code organization.
- The 60-second cache lives in `chrome.storage.local` under the key `sfmc_metrics_cache`.
- CORS is handled automatically by the browser since requests originate from the extension's background service worker (not a web page), and the host permissions in `manifest.json` allow cross-origin requests to `*.marketingcloudapis.com`.

---

## Required Chrome Permissions

```json
"permissions":       ["storage", "activeTab", "scripting", "alarms"]
"host_permissions":  ["https://*.marketingcloudapis.com/*",
                      "https://*.auth.marketingcloudapis.com/*"]
```

---

*Built with Manifest V3 · OAuth 2.0 Client Credentials · No external dependencies*
