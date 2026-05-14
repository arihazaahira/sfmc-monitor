/**
 * api-core.js — Centralized Salesforce Core REST API calls.
 * All requests use Bearer token auth; handles 401 retry with token refresh.
 */

import { getCoreTokenAndInstance, forceRefreshCoreToken } from './auth-core.js';

/**
 * Perform an authenticated GET request to Salesforce Core.
 * Automatically retries once on 401 with a refreshed token.
 */
async function authenticatedCoreGet(path, isRetry = false) {
  let authData;
  try {
    authData = isRetry ? await forceRefreshCoreToken() : await getCoreTokenAndInstance();
  } catch (e) {
    throw e; // e.g. CORE_NOT_CONFIGURED
  }

  const { accessToken, instanceUrl } = authData;
  const url = `${instanceUrl}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (networkError) {
    throw new Error(`Network error (Salesforce Core): ${networkError.message}`);
  }

  if (response.status === 401) {
    if (isRetry) throw new Error('CORE_AUTH_FAILED');
    return authenticatedCoreGet(path, true);
  }

  if (!response.ok) {
    throw new Error(`Salesforce Core API error ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch all Salesforce Core objects (v64.0).
 */
export async function fetchSalesforceCoreObjects() {
  const data = await authenticatedCoreGet('/services/data/v64.0/sobjects');
  
  if (!data || !Array.isArray(data.sobjects)) {
    throw new Error('Salesforce Core did not return sobjects array. Response: ' + JSON.stringify(data).substring(0, 200));
  }

  const sobjects = data.sobjects;
  
  // Format them for the dashboard list view
  return sobjects.map(obj => ({
    name: obj.label,
    key: obj.name, // API Name
    custom: obj.custom,
    keyPrefix: obj.keyPrefix,
    meta: obj.custom ? 'Custom Object' : 'Standard Object'
  }));
}

/**
 * Describe a Salesforce Core object to get its schema (fields).
 */
export async function describeSalesforceObject(objectName) {
  return authenticatedCoreGet(`/services/data/v64.0/sobjects/${objectName}/describe`);
}

/**
 * Fetch the 10 most recent records for an object.
 * Checks if CreatedDate exists in schema before sorting.
 */
export async function fetchSalesforceObjectRecentRecords(objectName, fieldsList = []) {
  if (fieldsList.length === 0) return { records: [] };
  
  const hasCreatedDate = fieldsList.some(f => f.name === 'CreatedDate');
  const fieldNames = fieldsList.map(f => f.name).join(',');
  
  let query = `SELECT ${fieldNames} FROM ${objectName}`;
  if (hasCreatedDate) {
    query += ` ORDER BY CreatedDate DESC`;
  }
  query += ` LIMIT 10`;
  
  const url = `/services/data/v64.0/query/?q=${encodeURIComponent(query)}`;
  return authenticatedCoreGet(url);
}
