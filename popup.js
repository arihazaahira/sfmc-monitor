/**
 * popup.js — UI logic for the SFMC Dashboard popup.
 * Handles 5-card layout, tabbed drill-down, search, and nested automation details.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function sendMsg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.data);
    });
  });
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

function formatTimestamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function openDashboard(category, id = '') {
  const url = chrome.runtime.getURL(`dashboard.html?category=${category}${id ? `&id=${id}` : ''}`);
  chrome.tabs.create({ url });
}

// ─── State ──────────────────────────────────────────────────────────────────

let loading = false;
let currentPanel = 'dashboard';
let currentCategory = '';
let allCategoryItems = []; 

// ─── DOM refs ───────────────────────────────────────────────────────────────

const statusDot       = $('statusDot');
const statusText      = $('statusText');
const lastUpdated     = $('lastUpdated');
const notConfigured    = $('notConfigured');
const dashboardContent = $('dashboardContent');

const valContacts    = $('valContacts');
const valDataExt     = $('valDataExt');
const valAutomations = $('valAutomations');
const valSms         = $('valSms');
const valEmail       = $('valEmail');

const cardContacts    = $('cardContacts');
const cardDataExt     = $('cardDataExt');
const cardAutomations = $('cardAutomations');
const cardSms         = $('cardSms');
const cardEmail       = $('cardEmail');
const cardJourneys    = $('cardJourneys');
const valJourneys     = $('valJourneys');
const valUsers        = $('valUsers');
const cardUsers       = $('cardUsers');

const errorBanner  = $('errorBanner');
const errorTitle   = $('errorTitle');
const errorMsg     = $('errorMsg');

const btnRefresh       = $('btnRefresh');
const refreshIcon      = $('refreshIcon');
const btnRefreshHeader = $('btnRefreshHeader');
const refreshIconHeader = $('refreshIconHeader');

const detailsPanel = $('detailsPanel');
const detailsTitle = $('detailsTitle');
const detailsList  = $('detailsList');
const detailsTabs  = $('detailsTabs');
const btnBack      = $('btnBack');

const detailsSearchContainer = $('detailsSearchContainer');
const searchInput = $('searchInput');

const itemDetailsPanel   = $('itemDetailsPanel');
const itemDetailsContent = $('itemDetailsContent');
const btnBackToItems     = $('btnBackToItems');

const cacheBadge = $('cacheBadge');

// ─── Status helpers ──────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = `status-dot ${state || ''}`;
  statusText.textContent = text;
}

// ─── Loading state ───────────────────────────────────────────────────────────

function setLoading(on) {
  loading = on;
  btnRefresh.disabled = on;
  refreshIcon.classList.toggle('spin', on);
  refreshIconHeader.classList.toggle('spin', on);

  if (on && currentPanel === 'dashboard') {
    setStatus('loading', 'Fetching data…');
    setSkeleton();
  }
}

function setSkeleton() {
  [valContacts, valDataExt, valAutomations, valSms, valEmail, valJourneys, valUsers].forEach((el) => {
    el.textContent = '';
    el.classList.add('skeleton');
  });
}

// ─── Error display ───────────────────────────────────────────────────────────

function showError(title, msg) {
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
  errorBanner.classList.add('visible');
  setStatus('error', 'Error');
}

function clearError() {
  errorBanner.classList.remove('visible');
}

// ─── Render metrics ──────────────────────────────────────────────────────────

function renderMetrics(data) {
  clearError();
  [valContacts, valDataExt, valAutomations, valSms, valEmail, valJourneys, valUsers].forEach((el) => {
    el.classList.remove('skeleton');
  });
  valContacts.textContent    = formatNumber(data.contacts);
  valDataExt.textContent     = formatNumber(data.dataExtensions);
  valAutomations.textContent = formatNumber(data.automations);
  valSms.textContent         = formatNumber(data.smsDefinitions);
  valEmail.textContent       = formatNumber(data.emailDefinitions);
  valJourneys.textContent    = formatNumber(data.journeys);
  valUsers.textContent       = formatNumber(data.users);

  if (data.fetchedAt) {
    lastUpdated.textContent = `Updated ${formatTimestamp(data.fetchedAt)}`;
  }

  if (data.fromCache) {
    cacheBadge.textContent = 'cached';
    cacheBadge.className = 'cache-badge visible';
  } else {
    cacheBadge.textContent = 'live';
    cacheBadge.className = 'cache-badge visible live';
    setTimeout(() => {
      cacheBadge.textContent = 'cached';
      cacheBadge.className = 'cache-badge visible';
    }, 3000);
  }
  setStatus('live', 'Connected');
}

// ─── Dashboard logic ─────────────────────────────────────────────────────────

async function loadMetrics(force = false) {
  if (loading) return;
  setLoading(true);
  try {
    const data = await sendMsg('FETCH_ALL_METRICS', { force });
    renderMetrics(data);
  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg === 'NOT_CONFIGURED') {
      showNotConfigured();
      return;
    }
    showError('API Error', msg);
    setStatus('error', 'Error');
    [valContacts, valDataExt, valAutomations, valSms, valEmail].forEach((el) => el.classList.remove('skeleton'));
  } finally {
    setLoading(false);
  }
}

// ─── List View Logic ──────────────────────────────────────────────────────

async function showDetails(category, label) {
  currentPanel = 'details';
  currentCategory = category;
  detailsTitle.textContent = label;
  detailsList.innerHTML = '<div class="details-empty">Loading list...</div>';
  detailsPanel.classList.add('visible');

  // Search and Tabs only for automations
  if (category === 'automations') {
    detailsTabs.classList.add('visible');
    detailsSearchContainer.style.display = 'block';
    searchInput.value = '';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));
  } else if (category === 'journeys') {
    detailsTabs.classList.add('visible');
    detailsSearchContainer.style.display = 'block';
    searchInput.value = '';
    // Custom tabs for journeys
    detailsTabs.innerHTML = `
      <button class="tab-btn active" data-tab="all">All</button>
      <button class="tab-btn" data-tab="active">Active</button>
      <button class="tab-btn" data-tab="published">Published</button>
      <button class="tab-btn" data-tab="draft">Draft</button>
      <button class="tab-btn" data-tab="stopped">Stopped</button>
    `;
  } else {
    detailsTabs.classList.remove('visible');
    detailsSearchContainer.style.display = 'none';
  }

  try {
    const items = await sendMsg('FETCH_DETAILS', { category });
    allCategoryItems = items;
    renderDetailsList(items);
  } catch (err) {
    detailsList.innerHTML = `<div class="details-empty">Error loading details: ${err.message}</div>`;
  }
}

function hideDetails() {
  currentPanel = 'dashboard';
  detailsPanel.classList.remove('visible');
}

function handleTabClick(e) {
  const btn = e.target;
  if (!btn.classList.contains('tab-btn')) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function handleSearch() {
  applyFilters();
}

function applyFilters() {
  const activeTabBtn = document.querySelector('.tab-btn.active');
  const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'all';
  const query = searchInput.value.toLowerCase().trim();
  
  let filtered = allCategoryItems;

  if (currentCategory === 'automations') {
    if (activeTab === 'ready') filtered = allCategoryItems.filter(i => Number(i.meta) === 2);
    else if (activeTab === 'scheduled') filtered = allCategoryItems.filter(i => Number(i.meta) === 6);
    else if (activeTab === 'triggered') filtered = allCategoryItems.filter(i => Number(i.meta) === 7);
    else if (activeTab === 'error') filtered = allCategoryItems.filter(i => Number(i.meta) === 0 || Number(i.meta) === -1);
  } else if (currentCategory === 'journeys') {
    if (activeTab === 'active') filtered = allCategoryItems.filter(i => ['Executing', 'Paused', 'Scheduled'].includes(i.meta));
    else if (activeTab === 'published') filtered = allCategoryItems.filter(i => i.meta === 'Published');
    else if (activeTab === 'draft') filtered = allCategoryItems.filter(i => i.meta === 'Draft');
    else if (activeTab === 'stopped') filtered = allCategoryItems.filter(i => ['Stopped', 'Deleted'].includes(i.meta));
  }

  // 2. Search Filter
  if (query) {
    filtered = filtered.filter(i => 
      (i.name && i.name.toLowerCase().includes(query)) || 
      (i.key && i.key.toLowerCase().includes(query))
    );
  }

  renderDetailsList(filtered);
}

function renderDetailsList(items) {
  if (!items || items.length === 0) {
    detailsList.innerHTML = '<div class="details-empty">No items found in this section.</div>';
    return;
  }
  detailsList.innerHTML = '';
  items.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'detail-item';
    el.style.animationDelay = `${index * 0.05}s`;
    
    let metaHtml = `<div class="detail-meta">${item.meta || ''}</div>`;
    let typeHtml = item.definitionType ? `<span class="type-badge">${item.definitionType}</span>` : '';
    
    if (currentCategory === 'automations') {
      const numMeta = Number(item.meta);
      let autoStatus = item.meta;
      let badgeClass = '';
      if (numMeta === 2) autoStatus = 'Ready';
      else if (numMeta === 6) autoStatus = 'Scheduled';
      else if (numMeta === 7) autoStatus = 'Triggered';
      else if (numMeta === 3) autoStatus = 'Running';
      else if (numMeta === 0 || numMeta === -1) {
          autoStatus = 'Error';
          badgeClass = 'stopped';
      } else if (currentCategory === 'users') {
        const isActive = item.active === 'True' || item.active === 'true' || item.active === true;
        const isApi = item.isApi === 'True' || item.isApi === 'true' || item.isApi === true;
        const badgeClass = isActive ? 'active' : 'stopped';
        const typeHtml = isApi ? '<span class="type-badge">API</span>' : '';
        
        metaHtml = `<div class="status-badge ${badgeClass}">${isActive ? 'Active' : 'Inactive'}</div>`;
        el.innerHTML = `
            <div class="detail-info">
                <div class="detail-name">${item.name || item.email} ${typeHtml}</div>
                <div class="detail-key">${item.email}</div>
            </div>
            ${metaHtml}
        `;
        el.onclick = () => showUserDetail(item);
        return;
    }
      metaHtml = `<div class="status-badge ${badgeClass}">${autoStatus}</div>`;
      el.onclick = () => showAutomationDetail(item.id);
    } else if (currentCategory === 'journeys') {
      const s = String(item.meta).toLowerCase();
      let badgeClass = 'draft';
      if (['executing', 'paused', 'scheduled'].includes(s)) badgeClass = 'active';
      else if (s === 'published') badgeClass = 'published';
      else if (['stopped', 'deleted'].includes(s)) badgeClass = 'stopped';
      
      const pubDate = item.lastPublishedDate ? new Date(item.lastPublishedDate).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      
      metaHtml = `
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px">
          <div class="status-badge ${badgeClass}">${item.meta}</div>
          ${pubDate ? `<div style="font-size:0.65rem; color:var(--text-muted)">Pub: ${pubDate}</div>` : ''}
        </div>
      `;
      el.onclick = () => showJourneyDetail(item.id);
    }

    el.innerHTML = `
      <div class="detail-info">
        <div class="detail-name">${item.name || 'Unnamed'}${currentCategory === 'journeys' ? ` <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem">v${item.version}</span>` : ''}</div>
        <div style="display:flex; align-items:center; gap:8px">
          <div class="detail-key" style="flex:1">${item.key || 'No Key'}</div>
          ${typeHtml}
        </div>
      </div>
      <div>${metaHtml}</div>
    `;
    detailsList.appendChild(el);
  });
}

// ─── Single Item Detail Logic ────────────────────────────────────────────────

async function showAutomationDetail(id) {
  currentPanel = 'item-detail';
  itemDetailsContent.innerHTML = '<div class="details-empty">Fetching full details...</div>';
  itemDetailsPanel.classList.add('visible');

  try {
    const data = await sendMsg('FETCH_AUTOMATION_BY_ID', { id });
    renderAutomationItem(data);
  } catch (err) {
    itemDetailsContent.innerHTML = `<div class="details-empty">Error: ${err.message}</div>`;
  }
}

function hideItemDetail() {
  currentPanel = 'details';
  itemDetailsPanel.classList.remove('visible');
}

function renderAutomationItem(data) {
  const s = data.status || data.statusId;
  let statusText = s;
  if (s === 2) statusText = 'Ready';
  else if (s === 6) statusText = 'Scheduled';
  else if (s === 7) statusText = 'Awaiting Trigger';
  else if (s === 3) statusText = 'Running';
  else if (s === 4) statusText = 'Paused';
  else if (s === 0 || s === -1) statusText = 'Error';

  const type = data.type || (data.schedule ? 'Scheduled' : 'Triggered');
  const recur = data.schedule?.icalRecur || 'No recurrence set';

  itemDetailsContent.innerHTML = `
    <div class="detail-group">
      <div class="detail-label-sub">Automation Name</div>
      <div class="detail-value-sub">${data.name || 'N/A'}</div>
    </div>
    <div class="detail-group">
      <div class="detail-label-sub">External ID</div>
      <div class="detail-value-sub">${data.id || 'N/A'}</div>
    </div>
    <div class="detail-group">
      <div class="detail-label-sub">Status</div>
      <div class="detail-value-sub">${statusText} (ID: ${s})</div>
    </div>
    <div class="detail-group">
      <div class="detail-label-sub">Execution Type</div>
      <div class="detail-value-sub">${type}</div>
    </div>
    <div class="detail-group">
      <div class="detail-label-sub">Schedule (icalRecur)</div>
      <div class="recurrence-box">${recur}</div>
    </div>
  `;
}

// ─── Journey Detail Logic ───────────────────────────────────────────────────

async function showJourneyDetail(id) {
  currentPanel = 'item-detail';
  const titleEl = itemDetailsPanel.querySelector('h2');
  if (titleEl) titleEl.textContent = 'Journey Detail';
  
  itemDetailsContent.innerHTML = '<div class="details-empty">Fetching journey data...</div>';
  itemDetailsPanel.classList.add('visible');

  try {
    const [data, history] = await Promise.all([
      sendMsg('FETCH_JOURNEY_BY_ID', { id }),
      sendMsg('FETCH_JOURNEY_HISTORY', { id })
    ]);
    const versions = await sendMsg('FETCH_JOURNEY_VERSIONS', { key: data.key });
    renderJourneyItem(data, history, versions);
  } catch (err) {
    itemDetailsContent.innerHTML = `<div class="details-empty">Error: ${err.message}</div>`;
  }
}

function renderJourneyItem(data, history = [], versions = []) {
  const activities = data.activities ?? [];
  const trigger = data.triggers?.[0] || {};
  const status = data.status || 'Unknown';
  const name = data.name || 'Unnamed Journey';
  const currentVersion = data.version || '?';
  const currentId = data.id;

  const meta = trigger.metaData || {};
  const triggerName = meta.title || trigger.name || trigger.type || 'None';
  const triggerKey = meta.eventDefinitionKey || 'No key';
  
  const triggerHtml = `
    <div class="entry-badge" style="padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; width: 100%;">
      <div style="flex:1">
        <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary)">${triggerName}</div>
        <div style="font-size:0.68rem; color:var(--text-muted)">Key: ${triggerKey}</div>
      </div>
    </div>
  `;

  const stats = data.stats || {};
  const statsHtml = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Active Contacts</div>
        <div class="stat-value">${formatNumber(stats.currentPopulation || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Entries</div>
        <div class="stat-value">${formatNumber(stats.cumulativePopulation || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Goals Met</div>
        <div class="stat-value">${formatNumber(stats.metGoal || 0)}</div>
        <div class="stat-trend">${(stats.goalPerformance || 0).toFixed(1)}% success</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Exited Flow</div>
        <div class="stat-value">${formatNumber(stats.metExitCriteria || 0)}</div>
      </div>
    </div>
  `;

  let activitiesHtml = activities.slice(0, 8).map(a => `
      <div style="display:flex; align-items:center; gap:10px; background:#F8F9FA; border:1px solid var(--border); border-radius:8px; padding:10px">
        <div class="detail-info">
          <div class="detail-name" style="font-size:0.75rem">${a.name || a.type}</div>
          <div class="detail-key" style="font-size:0.62rem">${a.type}</div>
        </div>
      </div>
    `).join('');

  itemDetailsContent.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-end">
      <div class="detail-group" style="flex:1">
        <div class="detail-label-sub">Journey Name (v${currentVersion})</div>
        <div style="font-size:1.1rem; font-weight:600; color:var(--text-primary)">${name}</div>
      </div>
      <div class="status-badge ${status.toLowerCase() === 'executing' ? 'active' : 'draft'}">${status}</div>
    </div>

    <div class="detail-group">
      <div class="detail-label-sub">Entry Trigger</div>
      ${triggerHtml}
    </div>

    <div class="detail-group">
      <div class="detail-label-sub">Performance Statistics</div>
      ${statsHtml}
    </div>

    <div class="detail-group">
      <div class="detail-label-sub">Journey Canvas Preview</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px">
        ${activitiesHtml}
      </div>
    </div>
  `;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function showNotConfigured() {
  dashboardContent.style.display = 'none';
  notConfigured.classList.add('visible');
  setStatus('', 'Not configured');
}

function showDashboard() {
  dashboardContent.style.display = '';
  notConfigured.classList.remove('visible');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Navigation
  $('btnSettings').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  $('btnGoSettings').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  $('btnLaunchDashboard').addEventListener('click', () => openDashboard('journeys'));
  btnBack.addEventListener('click', hideDetails);
  btnBackToItems.addEventListener('click', hideItemDetail);

  // Tabs
  detailsTabs.addEventListener('click', handleTabClick);
  
  // Search
  searchInput.addEventListener('input', handleSearch);

  // Cards to Details -> Open Dashboard
  cardContacts.addEventListener('click', () => openDashboard('contacts'));
  cardDataExt.addEventListener('click', () => openDashboard('data-ext'));
  cardAutomations.addEventListener('click', () => openDashboard('automations'));
  cardSms.addEventListener('click', () => openDashboard('sms'));
  cardEmail.addEventListener('click', () => openDashboard('email'));
  cardJourneys.addEventListener('click', () => openDashboard('journeys'));
  cardUsers.addEventListener('click', () => openDashboard('users'));

  // Refresh
  btnRefresh.addEventListener('click', () => loadMetrics(true));
  btnRefreshHeader.addEventListener('click', () => loadMetrics(true));

  setStatus('loading', 'Checking config…');

  chrome.storage.local.get(['sfmc_credentials'], (r) => {
    if (!r.sfmc_credentials || !r.sfmc_credentials.clientId) {
      showNotConfigured();
      return;
    }
    showDashboard();
    chrome.storage.local.get(['sfmc_metrics_cache'], async (rc) => {
      const cached = rc.sfmc_metrics_cache;
      if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        renderMetrics({ ...cached.data, fromCache: true });
        loadMetrics(false).catch(() => {});
      } else {
        await loadMetrics(false);
      }
    });
  });
}

init();
