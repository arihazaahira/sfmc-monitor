/**
 * api.js — Centralized SFMC REST API calls.
 * All requests use Bearer token auth; handles 401 retry with token refresh.
 */

import { getAccessToken, forceRefreshToken, getCredentials } from './auth.js';

const CACHE_KEY = 'sfmc_metrics_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Build the base REST URL for the configured subdomain. */
async function getBaseUrl() {
  const creds = await getCredentials();
  if (!creds || !creds.subdomain) throw new Error('NOT_CONFIGURED');
  return `https://${creds.subdomain}.rest.marketingcloudapis.com`;
}

/** Build the base SOAP URL. */
async function getSoapUrl() {
  const creds = await getCredentials();
  if (!creds || !creds.subdomain) throw new Error('NOT_CONFIGURED');
  return `https://${creds.subdomain}.soap.marketingcloudapis.com/Service.asmx`;
}

/**
 * Perform an authenticated SOAP request.
 * Automatically retries once on 401 with a refreshed token.
 */
async function authenticatedSoapRequest(envelope, action, isRetry = false) {
  const token = isRetry ? await forceRefreshToken() : await getAccessToken();
  const url = await getSoapUrl();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'SOAPAction': action
    },
    body: envelope.replace('${token}', token)
  });

  const text = await response.text();
  
  if (response.status === 401 || text.includes('Unauthorized') || text.includes('Expired')) {
    if (isRetry) throw new Error('AUTH_FAILED');
    return authenticatedSoapRequest(envelope, action, true);
  }

  if (!response.ok) {
    throw new Error(`SOAP error ${response.status}: ${response.statusText}`);
  }

  return text; // Return raw XML string because DOMParser is not available in Service Workers
}

/** Helper to extract all <Results> blocks from SOAP XML string. */
function extractXmlResults(xml) {
  const results = [];
  const regex = /<(?:[^:>]+:)?Results[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?Results>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
      results.push(match[1]);
  }
  return results;
}

/** Helper to extract a single tag value from an XML snippet, ignoring namespaces. */
function extractXmlValue(snippet, tag) {
  const regex = new RegExp('<(?:[^:>]+:)?' + tag + '[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?' + tag + '>', 'i');
  const match = snippet.match(regex);
  let val = match ? match[1].trim() : '';
  if (val.includes('xsi:nil="true"')) return '';
  // Handle nested tags or CDATA if necessary (simplified)
  val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return val;
}

/**
 * Perform an authenticated GET request.
 * Automatically retries once on 401 with a refreshed token.
 */
async function authenticatedGet(path, isRetry = false) {
  const token = isRetry ? await forceRefreshToken() : await getAccessToken();
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (networkError) {
    throw new Error(`Network error: ${networkError.message}`);
  }

  if (response.status === 401) {
    if (isRetry) throw new Error('AUTH_FAILED');
    return authenticatedGet(path, true);
  }

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/** ─── Metric Fetchers ──────────────────────────────────────────────────── */

/**
 * Fetch contacts count via /contacts/v1/contacts/count.
 * Falls back to /contacts/v1/schema or paginated search if count is not available.
 */
async function fetchContactsCount() {
  try {
    const data = await authenticatedGet('/contacts/v1/contacts/count');
    const count = data.count ?? data.totalCount ?? data.Count ?? data.TotalCount;
    if (count !== undefined) return Number(count);
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    // Fall through to fallback 1
  }

  try {
    const data = await authenticatedGet('/contacts/v1/schema');
    const count = data.count ?? data.totalCount ?? data.Count ?? data.TotalCount;
    if (count !== undefined) return Number(count);
    const items = data.schemas ?? data.items ?? data.results ?? (Array.isArray(data) ? data : null);
    if (items) return items.length;
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    // Fall through to fallback 2
  }

  // Final Fallback: single page to get total
  try {
    const fallback = await authenticatedGet('/contacts/v1/contacts?$page=1&$pageSize=1');
    return (
      fallback.count ?? fallback.totalCount ?? fallback.Count ?? fallback.TotalCount ?? 0
    );
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    return 0;
  }
}

/**
 * Fetch Data Extensions count.
 * Tries /data/v1/customobjects first, falls back to Asset API.
 */
async function fetchDataExtensionsCount() {
  let total = 0;
  let requestId = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const envelope = `<?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
           <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
           <s:Body>
              <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
                 <RetrieveRequest>
                    <ObjectType>DataExtension</ObjectType>
                    <Properties>ObjectID</Properties>
                    ${requestId ? `<ContinueRequest>${requestId}</ContinueRequest>` : ''}
                 </RetrieveRequest>
              </RetrieveRequestMsg>
           </s:Body>
        </s:Envelope>`;

      const xmlText = await authenticatedSoapRequest(envelope, 'Retrieve');
      const results = extractXmlResults(xmlText);
      total += results.length;

      const overallStatus = extractXmlValue(xmlText, 'OverallStatus');
      requestId = extractXmlValue(xmlText, 'RequestID');

      if (!overallStatus.includes('MoreDataAvailable') || !requestId) break;
      if (total > 10000) break; // Safety limit
    }
    return total;
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    console.error('SOAP DE Count failed:', e);
    return 0;
  }
}

/**
 * Fetch Automations total, ready, triggered, and scheduled counts.
 */
async function fetchAutomationsCount() {
  let total = 0;
  let ready = 0;
  let triggered = 0;
  let scheduled = 0;
  let error = 0;
  let page = 1;
  const pageSize = 500;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await authenticatedGet(
        `/automation/v1/automations?$page=${page}&$pageSize=${pageSize}`
      );

      const items =
        data.items ??
        data.results ??
        data.definitions ??
        (Array.isArray(data) ? data : []);

      // If the API provides a total count on the first page, use it as baseline
      const apiTotal = data.totalCount ?? data.count ?? data.Count ?? data.TotalCount;
      if (page === 1 && typeof apiTotal === 'number') {
        total = apiTotal;
      } else if (page === 1) {
        total = items.length;
      } else if (typeof apiTotal !== 'number') {
        total += items.length;
      }

      // Count by status
      items.forEach(i => {
        const s = i.status ?? i.statusId;
        if (s === 2) ready++;
        if (s === 6) scheduled++;
        if (s === 7) triggered++;
        if (s === 0 || s === -1) error++;
      });

      if (items.length < pageSize) break;
      page++;
      if (page > 3) break; // limit to 1500 for performance
    }
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    // Return what we have or 0
  }

  return { total, ready, triggered, scheduled, error };
}

/**
 * Fetch Transactional SMS definitions count.
 */
async function fetchSmsDefinitionsCount() {
  const data = await authenticatedGet('/messaging/v1/sms/definitions');
  const count = data.count ?? data.totalCount ?? data.Count ?? data.TotalCount;
  if (count !== undefined) return Number(count);
  const items = data.definitions ?? data.items ?? data.results ?? (Array.isArray(data) ? data : []);
  return items.length;
}

/**
 * Fetch Transactional Email definitions count.
 */
async function fetchEmailDefinitionsCount() {
  const data = await authenticatedGet('/messaging/v1/email/definitions');
  const count = data.count ?? data.totalCount ?? data.Count ?? data.TotalCount;
  if (count !== undefined) return Number(count);
  const items = data.definitions ?? data.items ?? data.results ?? (Array.isArray(data) ? data : []);
  return items.length;
}

/**
 * Fetch Journeys count (latest versions).
 */
async function fetchJourneysCount() {
  try {
    const data = await authenticatedGet('/interaction/v1/interactions?mostRecentVersionOnly=true&$page=1&$pageSize=1');
    const count = data.count ?? data.totalCount ?? data.Count ?? data.TotalCount;
    if (count !== undefined) return Number(count);
    return 0;
  } catch (e) {
    if (e.message === 'AUTH_FAILED' || e.message === 'NOT_CONFIGURED') throw e;
    return 0;
  }
}

async function fetchUsersCount() {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
       <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
       <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
             <RetrieveRequest>
                <ObjectType>AccountUser</ObjectType>
                <Properties>UserID</Properties>
                <Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                   <Property>ActiveFlag</Property>
                   <SimpleOperator>equals</SimpleOperator>
                   <Value>true</Value>
                </Filter>
             </RetrieveRequest>
          </RetrieveRequestMsg>
       </s:Body>
    </s:Envelope>`;

  try {
    const xmlText = await authenticatedSoapRequest(envelope, 'Retrieve');
    const results = extractXmlResults(xmlText);
    return results.length || 0;
  } catch (e) {
    console.error('SOAP User Count failed:', e);
    return 0;
  }
}

/**
 * Calculates the estimated annual execution volume for all automations.
 * Parses icalRecur to determine frequency.
 */
export async function fetchAutomationAnnualVolume() {
  let annualTotal = 0;
  let page = 1;
  const pageSize = 500;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await authenticatedGet(`/automation/v1/automations?$page=${page}&$pageSize=${pageSize}`);
      const items = data.items ?? data.definitions ?? data.results ?? [];
      
      if (!items || items.length === 0) break;

      items.forEach(i => {
        // Only count if automation is scheduled (status 6) or active
        const status = i.status ?? i.statusId;
        if (status !== 6 && status !== 2 && status !== 3) return; 

        const recur = i.schedule?.icalRecur || '';
        if (!recur) return;

        const parts = recur.split(';');
        let freq = '';
        let interval = 1;
        let byDayCount = 1;
        let untilDate = null;

        parts.forEach(p => {
            if (p.startsWith('FREQ=')) freq = p.substring(5).toUpperCase();
            if (p.startsWith('INTERVAL=')) interval = parseInt(p.substring(9)) || 1;
            if (p.startsWith('BYDAY=')) {
                const days = p.substring(6).split(',');
                byDayCount = Math.max(1, days.length);
            }
            if (p.startsWith('UNTIL=')) {
                const dateStr = p.substring(6); // YYYYMMDDTHHMMSSZ
                if (dateStr.length >= 8) {
                    const year = dateStr.substring(0,4);
                    const month = dateStr.substring(4,6);
                    const day = dateStr.substring(6,8);
                    untilDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
                }
            }
        });

        const now = new Date();
        const oneYearFromNow = new Date();
        oneYearFromNow.setFullYear(now.getFullYear() + 1);

        let endDateForCalc = oneYearFromNow;
        if (untilDate && untilDate < oneYearFromNow && untilDate > now) {
            endDateForCalc = untilDate;
        } else if (untilDate && untilDate <= now) {
            return; // Déjà terminé
        }

        const durationDays = (endDateForCalc - now) / (1000 * 60 * 60 * 24);
        let multiplier = 0;

        switch (freq) {
          case 'MINUTELY': multiplier = Math.max(0, Math.floor((durationDays * 24 * 60) / interval)); break;
          case 'HOURLY': multiplier = Math.max(0, Math.floor((durationDays * 24) / interval)); break;
          case 'DAILY': multiplier = Math.max(0, Math.floor(durationDays / interval)); break;
          case 'WEEKLY': multiplier = Math.max(0, Math.floor((durationDays / 7) / interval)) * byDayCount; break;
          case 'MONTHLY': multiplier = Math.max(0, Math.floor((durationDays / 30.44) / interval)); break;
          case 'YEARLY': multiplier = Math.max(0, Math.floor((durationDays / 365) / interval)); break;
        }

        if (multiplier > 0) {
          annualTotal += multiplier;
        }
      });

      if (items.length < pageSize) break;
      page++;
      if (page > 10) break; // performance limit
    }
    return annualTotal;
  } catch (err) {
    console.error('Failed to calculate automation volume:', err);
    return 0;
  }
}


/** ─── Detail Fetchers (Lists) ──────────────────────────────────────────── */

export async function fetchContactsDetails() {
  // Contacts API is tricky; show recent or schema info
  const data = await authenticatedGet('/contacts/v1/schema');
  const items = data.schemas ?? data.items ?? data.results ?? [];
  return items.slice(0, 20).map(i => ({
    name: i.name || i.id,
    key: i.key || i.id,
    meta: i.type || 'Object'
  }));
}

export async function fetchDataExtensionsDetails() {
  let allItems = [];
  let requestId = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const envelope = `<?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
           <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
           <s:Body>
              <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
                 <RetrieveRequest>
                    <ObjectType>DataExtension</ObjectType>
                    <Properties>Name</Properties>
                    <Properties>CustomerKey</Properties>
                    <Properties>ObjectID</Properties>
                    <Properties>CategoryID</Properties>
                    <Properties>DataRetentionPeriod</Properties>
                    <Properties>DataRetentionPeriodLength</Properties>
                    <Properties>DataRetentionPeriodUnitOfMeasure</Properties>
                    <Properties>RowBasedRetention</Properties>
                    <Properties>DeleteAtEndOfRetentionPeriod</Properties>
                    <Properties>RetainUntil</Properties>
                    <Properties>CreatedDate</Properties>
                    <Properties>ModifiedDate</Properties>
                    ${requestId ? `<ContinueRequest>${requestId}</ContinueRequest>` : ''}
                 </RetrieveRequest>
              </RetrieveRequestMsg>
           </s:Body>
        </s:Envelope>`;

      const xmlText = await authenticatedSoapRequest(envelope, 'Retrieve');
      
      const overallStatus = extractXmlValue(xmlText, 'OverallStatus');
      if (overallStatus.includes('Error')) {
        const msg = extractXmlValue(xmlText, 'StatusMessage');
        throw new Error(msg || 'SOAP Retrieval Error');
      }

      const results = extractXmlResults(xmlText);
      for (const res of results) {
          const name = extractXmlValue(res, 'Name') || 'Unnamed DE';
          const key = extractXmlValue(res, 'CustomerKey') || '';
          const id = extractXmlValue(res, 'ObjectID') || '';
          const categoryId = extractXmlValue(res, 'CategoryID') || '0';
          
          const retentionLength = extractXmlValue(res, 'DataRetentionPeriodLength');
          const rawUnit = extractXmlValue(res, 'DataRetentionPeriodUnitOfMeasure');
          const staticUnit = extractXmlValue(res, 'DataRetentionPeriod'); // Fallback if unit of measure is empty
          
          const retainUntil = extractXmlValue(res, 'RetainUntil');
          const createdDate = extractXmlValue(res, 'CreatedDate');
          const modifiedDate = extractXmlValue(res, 'ModifiedDate');
          const deleteAtEnd = extractXmlValue(res, 'DeleteAtEndOfRetentionPeriod');
          const rowBasedRetention = extractXmlValue(res, 'RowBasedRetention');
          const resetOnImport = extractXmlValue(res, 'ResetRetentionPeriodOnImport');

          // Prioritize DataRetentionPeriod (text) since UnitOfMeasure is deprecated. Map known obscure numeric IDs (SFMC sometimes uses 5 for Months).
          const unitMap = { "1": "Days", "2": "Weeks", "3": "Months", "4": "Years", "5": "Months" };
          let retentionUnit = staticUnit || unitMap[rawUnit] || rawUnit || 'Days';
          if (retentionUnit === '0') retentionUnit = 'Days';
          
          allItems.push({
              id,
              name,
              key,
              categoryId,
              retentionLength,
              retentionUnit,
              retainUntil,
              createdDate,
              modifiedDate,
              deleteAtEnd,
              rowBasedRetention,
              resetOnImport,
              meta: `Folder: ${categoryId}`
          });
      }

      requestId = extractXmlValue(xmlText, 'RequestID');
      if (!overallStatus.includes('MoreDataAvailable') || !requestId) break;
      if (allItems.length > 5000) break; // Safety limit for dashboard
    }
    
    return allItems;
  } catch (err) {
    console.error('SOAP DE Details failed:', err);
    throw err;
  }
}

/** Fetches all DEs and their counts in parallel (with batching). */
export async function fetchDataExtensionsWithUsage() {
    const des = await fetchDataExtensionsDetails();
    const batchSize = 10;
    const results = [];
    
    for (let i = 0; i < des.length; i += batchSize) {
        const batch = des.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (de) => {
            try {
                const count = await fetchDataExtensionRecordCount(de.key);
                return { ...de, recordCount: count };
            } catch (err) {
                return { ...de, recordCount: 0, error: true };
            }
        }));
        results.push(...batchResults);
    }
    
    return {
        total: results.length,
        active: results.filter(de => de.recordCount > 0),
        empty: results.filter(de => de.recordCount === 0 && !de.error),
        all: results
    };
}

/** Fetch record count for a specific Data Extension by Key. */
export async function fetchDataExtensionRecordCount(key) {
  try {
    const encodedKey = encodeURIComponent(key);
    // Primary: rowset endpoint (best for total count)
    const data = await authenticatedGet(`/data/v1/customobjectdata/key/${encodedKey}/rowset?$pageSize=1`);
    const count = Number(data.count ?? data.totalCount ?? data.Count ?? 0);
    
    // If count is 0, double check with the /rows endpoint to be 100% sure
    if (count === 0) {
      try {
        const rowsData = await authenticatedGet(`/data/v1/customobject/key:${encodedKey}/rows?$pageSize=1`);
        const rowCount = Number(rowsData.count ?? rowsData.totalCount ?? rowsData.Count ?? 0);
        return rowCount;
      } catch (e2) {
        return 0;
      }
    }
    return count;
  } catch (e) {
    console.warn(`Failed to fetch row count for DE ${key}:`, e);
    return 0;
  }
}

/** Retrieve field schema for a Data Extension. */
export async function fetchDataExtensionFields(customerKey) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
       <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
       <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <RetrieveRequest>
              <ObjectType>DataExtensionField</ObjectType>
              <Properties>Name</Properties>
              <Properties>FieldType</Properties>
              <Properties>MaxLength</Properties>
              <Properties>IsPrimaryKey</Properties>
              <Properties>IsRequired</Properties>
              <Properties>DefaultValue</Properties>
              <Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                <Property>DataExtension.CustomerKey</Property>
                <SimpleOperator>equals</SimpleOperator>
                <Value>${customerKey}</Value>
              </Filter>
            </RetrieveRequest>
          </RetrieveRequestMsg>
       </s:Body>
    </s:Envelope>`;

  const xmlText = await authenticatedSoapRequest(envelope, 'Retrieve');
  const results = extractXmlResults(xmlText);
  
  return results.map(res => ({
    name: extractXmlValue(res, 'Name'),
    type: extractXmlValue(res, 'FieldType'),
    length: extractXmlValue(res, 'MaxLength'),
    isPrimaryKey: extractXmlValue(res, 'IsPrimaryKey'),
    isRequired: extractXmlValue(res, 'IsRequired'),
    defaultValue: extractXmlValue(res, 'DefaultValue')
  }));
}

/** Delete a Data Extension by CustomerKey. */
export async function deleteDataExtension(customerKey) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
       <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
       <s:Body>
          <DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Objects xsi:type="DataExtension" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
              <CustomerKey>${customerKey}</CustomerKey>
            </Objects>
          </DeleteRequest>
       </s:Body>
    </s:Envelope>`;

  const xmlText = await authenticatedSoapRequest(envelope, 'Delete');
  const overallStatus = extractXmlValue(xmlText, 'OverallStatus');
  
  if (overallStatus !== 'OK' && overallStatus !== 'Success') {
    const error = extractXmlValue(xmlText, 'StatusMessage') || 'Unknown deletion error';
    throw new Error(error);
  }
  return true;
}

/** Update the retention period for a Data Extension. */
export async function updateDataRetention(name, length, unit, enabled = true) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
       <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
       <s:Body>
          <UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
            <Options/>
            <Objects xsi:type="DataExtension">
               <ModifiedDate xsi:nil="true"/>
               <Name>${name}</Name>
               <DataRetentionPeriodLength>${enabled ? length : 0}</DataRetentionPeriodLength>
               <DataRetentionPeriod>${enabled ? unit : 'Days'}</DataRetentionPeriod>
               <ResetRetentionPeriodOnImport>${enabled}</ResetRetentionPeriodOnImport>
               <DeleteAtEndOfRetentionPeriod>${enabled}</DeleteAtEndOfRetentionPeriod>
               <RowBasedRetention>${enabled}</RowBasedRetention>
            </Objects>
          </UpdateRequest>
       </s:Body>
    </s:Envelope>`;

  const xmlText = await authenticatedSoapRequest(envelope, 'Update');
  const overallStatus = extractXmlValue(xmlText, 'OverallStatus');
  
  if (overallStatus !== 'OK' && overallStatus !== 'Success') {
    const error = extractXmlValue(xmlText, 'StatusMessage') || 'Unknown update error';
    throw new Error(error);
  }
  return true;
}

export async function fetchAutomationsDetails(status = null) {
  let allItems = [];
  let page = 1;
  const pageSize = 500;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await authenticatedGet(`/automation/v1/automations?$page=${page}&$pageSize=${pageSize}`);
      const items = data.items ?? data.definitions ?? data.results ?? (Array.isArray(data) ? data : []);
      
      if (!items || items.length === 0) break;

      allItems = allItems.concat(items.map(i => ({
        id: i.id,
        name: i.name || i.id,
        key: i.customerKey || i.key,
        // Robust numeric status extraction
        meta: (i.statusId !== undefined ? i.statusId : i.status) ?? -1
      })));

      if (items.length < pageSize) break;
      page++;
      if (page > 10) break; // Limit to 5000 items total for performance
    }
  } catch (err) {
    console.error('Failed to fetch full automations list:', err);
    // Return what we have if some pages succeeded
  }

  if (status !== null) {
    return allItems.filter(i => Number(i.meta) === status);
  }

  return allItems;
}

export async function fetchAutomationById(id) {
  return authenticatedGet(`/automation/v1/automations/${id}`);
}

export async function fetchSmsDefinitionsDetails() {
  const data = await authenticatedGet('/messaging/v1/sms/definitions');
  const items = data.definitions ?? data.items ?? data.results ?? [];
  return items.slice(0, 20).map(i => ({
    name: i.name,
    key: i.definitionKey || i.key,
    meta: i.status || 'Active'
  }));
}

export async function fetchEmailDefinitionsDetails() {
  const data = await authenticatedGet('/messaging/v1/email/definitions');
  const items = data.definitions ?? data.items ?? data.results ?? [];
  return items.slice(0, 20).map(i => ({
    name: i.name,
    key: i.definitionKey || i.key,
    meta: i.status || 'Active'
  }));
}

export async function fetchJourneysDetails() {
  // Fetch latest versions of all journeys
  const data = await authenticatedGet('/interaction/v1/interactions?mostRecentVersionOnly=true&$pageSize=100');
  const items = data.items ?? data.results ?? (Array.isArray(data) ? data : []);
  return items.map(i => ({
    id: i.id,
    name: i.name,
    key: i.key,
    version: i.version,
    definitionType: i.definitionType,
    lastPublishedDate: i.lastPublishedDate,
    meta: i.status || 'Draft'
  }));
}

export async function fetchUsersDetails() {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
       <s:Header><fueloauth xmlns="http://exacttarget.com">\${token}</fueloauth></s:Header>
       <s:Body>
          <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
             <RetrieveRequest>
                <ObjectType>AccountUser</ObjectType>
                <QueryAllAccounts>true</QueryAllAccounts>
                <Properties>Name</Properties>
                <Properties>Email</Properties>
                <Properties>ActiveFlag</Properties>
                <Properties>CreatedDate</Properties>
                <Properties>IsAPIUser</Properties>
                <Properties>UserID</Properties>
                <Properties>LastSuccessfulLogin</Properties>
              </RetrieveRequest>
          </RetrieveRequestMsg>
       </s:Body>
    </s:Envelope>`;

  const xmlText = await authenticatedSoapRequest(envelope, 'Retrieve');
  const results = extractXmlResults(xmlText);
  
  return results.map(res => ({
    id: extractXmlValue(res, 'UserID'),
    name: extractXmlValue(res, 'Name'),
    email: extractXmlValue(res, 'Email'),
    active: extractXmlValue(res, 'ActiveFlag'),
    isApi: extractXmlValue(res, 'IsAPIUser'),
    lastLogin: extractXmlValue(res, 'LastSuccessfulLogin'),
    created: extractXmlValue(res, 'CreatedDate'),
    key: extractXmlValue(res, 'UserID'),
    meta: extractXmlValue(res, 'Email')
  }));
}

export async function fetchJourneyById(id) {
  return authenticatedGet(`/interaction/v1/interactions/${id}/?extras=all`);
}

export async function fetchJourneyVersions(key) {
  // Key refers to the unique identifier across versions
  const data = await authenticatedGet(`/interaction/v1/interactions/key:${key}`);
  // If the key endpoint returns only one, we might need to fetch the collection by key
  // Actually, the interactions API usually returns an array if we use the search or if we fetch by key.
  // Standard way to get versions is GET /interaction/v1/interactions?key={key}
  const allData = await authenticatedGet(`/interaction/v1/interactions?key=${key}`);
  const items = allData.items ?? allData.results ?? (Array.isArray(allData) ? allData : [data]);
  return items.sort((a, b) => b.version - a.version);
}

export async function fetchJourneyHistory(definitionId) {
  const baseUrl = await getBaseUrl();
  const token = await getAccessToken();
  const url = `${baseUrl}/interaction/v1/interactions/journeyhistory/search`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      definitionId: definitionId,
      top: 10
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
       // Simple retry for 401
       const newToken = await forceRefreshToken();
       const retry = await fetch(url, {
         method: 'POST',
         headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json' },
         body: JSON.stringify({ definitionId, top: 10 })
       });
       if (!retry.ok) return [];
       const rdata = await retry.json();
       return rdata.items ?? rdata.results ?? [];
    }
    return [];
  }

  const data = await response.json();
  return data.items ?? data.results ?? [];
}

/** ─── Cache helpers ────────────────────────────────────────────────────── */

async function getCachedMetrics() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_KEY], (result) => {
      const cached = result[CACHE_KEY];
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        resolve(cached.data);
      } else {
        resolve(null);
      }
    });
  });
}

async function setCachedMetrics(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [CACHE_KEY]: { data, timestamp: Date.now() } },
      resolve
    );
  });
}

async function clearMetricsCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([CACHE_KEY], resolve);
  });
}

/** ─── Public API ───────────────────────────────────────────────────────── */

/**
 * Fetch all five metrics in parallel.
 * Results are cached for CACHE_TTL_MS. Pass force=true to bypass cache.
 */
export async function fetchAllMetrics(force = false) {
  if (!force) {
    const cached = await getCachedMetrics();
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const results = await Promise.allSettled([
    fetchContactsCount(),
    fetchDataExtensionsCount(),
    fetchAutomationsCount(),
    fetchSmsDefinitionsCount(),
    fetchEmailDefinitionsCount(),
    fetchJourneysCount(),
    fetchUsersCount()
  ]);

  // If ALL of them failed with an actual error, we should probably throw the first error 
  // so the UI shows an error banner. But if even one succeeded, we show partial data.
  const allRejected = results.every((r) => r.status === 'rejected');
  if (allRejected) {
    throw results[0].reason;
  }

  // Log individual failures for debugging
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Metric ${i} failed:`, r.reason);
    }
  });

  const automationsResult = results[2].status === 'fulfilled' 
    ? results[2].value 
    : { total: 0, ready: 0, triggered: 0, scheduled: 0, error: 0 };

  const result = {
    contacts: results[0].status === 'fulfilled' ? results[0].value : null,
    dataExtensions: results[1].status === 'fulfilled' ? results[1].value : null,
    automations: automationsResult.total || 0,
    automationsReady: automationsResult.ready || 0,
    automationsTriggered: automationsResult.triggered || 0,
    automationsScheduled: automationsResult.scheduled || 0,
    automationsError: automationsResult.error || 0,
    smsDefinitions: results[3].status === 'fulfilled' ? results[3].value : null,
    emailDefinitions: results[4].status === 'fulfilled' ? results[4].value : null,
    journeys: results[5].status === 'fulfilled' ? results[5].value : null,
    users: results[6].status === 'fulfilled' ? results[6].value : null,
    fetchedAt: Date.now(),
    fromCache: false
  };

  await setCachedMetrics(result);
  return result;
}

export { clearMetricsCache };
