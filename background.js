/**
 * background.js — Service worker for SFMC Dashboard extension.
 * Handles all messaging between popup/settings and the API/auth modules.
 */

import {
  fetchAllMetrics,
  clearMetricsCache,
  fetchContactsDetails,
  fetchDataExtensionsDetails,
  fetchAutomationsDetails,
  fetchAutomationById,
  fetchSmsDefinitionsDetails,
  fetchEmailDefinitionsDetails,
  fetchJourneysDetails,
  fetchJourneyById,
  fetchJourneyVersions,
  fetchJourneyHistory,
  fetchDataExtensionRecordCount,
  fetchUsersDetails,
  fetchAutomationAnnualVolume,
  fetchDataExtensionFields,
  deleteDataExtension,
  updateDataRetention,
  fetchDataExtensionsWithUsage
} from './api.js';

import { isConfigured, clearCredentials } from './auth.js';
import { callAI } from './ai.js';

/** ─── Message handler ─────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject messages from any context that isn't this extension itself.
  // Without this guard any web page could trigger API calls or deletions.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'UNAUTHORIZED' });
    return false;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'CHECK_CONFIGURED':
      return { configured: await isConfigured() };

    case 'FETCH_ALL_METRICS':
      return fetchAllMetrics(message.force === true);

    case 'FETCH_AUTOMATION_ANNUAL_VOLUME':
      return fetchAutomationAnnualVolume();

    case 'FETCH_AUTOMATION_BY_ID':

      return fetchAutomationById(message.id);
    
    case 'FETCH_JOURNEY_BY_ID':
      return fetchJourneyById(message.id);
    
    case 'FETCH_JOURNEY_VERSIONS':
      return fetchJourneyVersions(message.key);
    
    case 'FETCH_JOURNEY_HISTORY':
      return fetchJourneyHistory(message.id);

    case 'FETCH_DE_RECORD_COUNT':
      return fetchDataExtensionRecordCount(message.key);

    case 'FETCH_DE_FIELDS':
      return fetchDataExtensionFields(message.key);

    case 'DELETE_DE':
      return deleteDataExtension(message.key);

    case 'UPDATE_DE_RETENTION':
      return updateDataRetention(message.name, message.length, message.unit, message.enabled);

    case 'FETCH_DE_CATEGORY_COUNTS':
      return fetchDataExtensionsWithUsage();

    case 'FETCH_DETAILS': {
      const { category } = message;
      switch (category) {
        case 'contacts': return fetchContactsDetails();
        case 'data-ext': return fetchDataExtensionsDetails();
        case 'automations': return fetchAutomationsDetails();
        case 'automations-ready': return fetchAutomationsDetails(2);
        case 'automations-trig': return fetchAutomationsDetails(7);
        case 'sms': return fetchSmsDefinitionsDetails();
        case 'email': return fetchEmailDefinitionsDetails();
        case 'journeys': return fetchJourneysDetails();
        case 'users': return fetchUsersDetails();
        default: throw new Error(`Unknown category: \${category}`);
      }
    }
    
    case 'FETCH_USERS_DETAILS':
        return fetchUsersDetails();

    case 'REFRESH_METRICS':
      await clearMetricsCache();
      return fetchAllMetrics(true);

    case 'ASK_AI':
      return callAI(message.question, message.uiContext || {}, message.history || []);

    case 'CLEAR_CREDENTIALS':
      await clearCredentials();
      return { cleared: true };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
