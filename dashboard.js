import { SFMC_TIERS, getClientConfig, saveClientConfig, calculateUsage } from './limits.js';

// ─── Helpers ────────────────────────────────────────────────────────────────


const $ = (id) => document.getElementById(id);

function sendMsg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response || !response.ok) return reject(new Error(response?.error || 'Unknown error'));
      resolve(response.data);
    });
  });
}

function formatNumber(n) {
  if (n === null || n === undefined || n === '') return '0';
  return Number(n).toLocaleString();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── State ──────────────────────────────────────────────────────────────────

let currentCategory = 'journeys';
let currentItemId = null;
let allItems = [];
let filteredItems = [];
let aiMessages = [];
let lastCategoryItems = [];

// ─── DOM Refs ───────────────────────────────────────────────────────────────

const pageListContainer = $('pageListContainer');
const pageDetailContent = $('pageDetailContent');
const pageDetailSection = $('pageDetailSection');
const viewTitle         = $('viewTitle');
const pageTabs          = $('pageTabs');
const breadcrumbCategory = $('breadcrumbCategory');
const breadcrumbDetail   = $('breadcrumbDetail');
const pageSearchInput    = $('pageSearchInput');

// ─── Initialization ─────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('category');
  const id  = params.get('id');

  if (cat) {
    currentCategory = cat;
  }

  // Set up sidebar nav highlights
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === currentCategory);
    item.onclick = (e) => {
      e.preventDefault();
      switchCategory(item.dataset.category);
    };
  });

  // Search
  pageSearchInput.oninput = () => {
    filterAndRenderList();
  };

  // Notifications Logic
  const notifBtn = $('btnNotifications');
  const notifDropdown = $('notifDropdown');
  if (notifBtn && notifDropdown) {
      notifBtn.onclick = (e) => {
          e.stopPropagation();
          notifDropdown.classList.toggle('hidden');
      };
      // Close dropdown if clicked outside
      document.addEventListener('click', (e) => {
          if (!notifBtn.contains(e.target) && !notifDropdown.contains(e.target)) {
              notifDropdown.classList.add('hidden');
          }
      });
      // Prevent closing when clicking inside dropdown
      notifDropdown.addEventListener('click', (e) => e.stopPropagation());
  }

  // Initial load
  const initialCat = currentCategory;
  currentCategory = null; // Reset to force switchCategory to run
  await switchCategory(initialCat);

  if (id) {
     selectItem(id);
  }
}

// ─── Category Management ───────────────────────────────────────────────────

async function switchCategory(cat) {
  if (cat === currentCategory) return;
  currentCategory = cat;
  
  // Hide details view if switching categories
  pageDetailSection.classList.remove('visible');

  // Update UI
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === currentCategory);
  });
  
  breadcrumbCategory.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
  breadcrumbDetail.textContent = 'List';
  viewTitle.textContent = cat.charAt(0).toUpperCase() + cat.slice(1) + ' Overview';
  
  // Update URL without reloading
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.set('category', cat);
  newUrl.searchParams.delete('id');
  window.history.pushState({}, '', newUrl);

  // Preserve loaded items for AI context before clearing
  if (allItems.length > 0) lastCategoryItems = allItems;

  // Clear stale data to prevent mixing
  allItems = [];

  // Toggle AI layout mode on the list section
  document.querySelector('.list-section').classList.toggle('ai-mode', cat === 'ai');

  // Load
  if (cat === 'limits') {
    await renderLimitsDashboard();
  } else if (cat === 'data-ext') {
    await renderDataExtensionsOverview();
  } else if (cat === 'ai') {
    renderAIView();
  } else {
    await loadCategoryData(cat);
  }
}


async function loadCategoryData(cat) {
  pageListContainer.innerHTML = '<div class="loading-state">Fetching ' + cat + '...</div>';
  renderTabs(cat);

  try {
    const items = await sendMsg('FETCH_DETAILS', { category: cat });
    allItems = items;
    filterAndRenderList();
  } catch (err) {
    pageListContainer.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
  }
}

function renderTabs(cat) {
  if (cat === 'journeys') {
    pageTabs.innerHTML = `
      <button class="tab-btn active" data-tab="all">All</button>
      <button class="tab-btn" data-tab="active">Active</button>
      <button class="tab-btn" data-tab="published">Published</button>
      <button class="tab-btn" data-tab="draft">Draft</button>
      <button class="tab-btn" data-tab="stopped">Stopped</button>
    `;
  } else if (cat === 'automations') {
    pageTabs.innerHTML = `
      <button class="tab-btn active" data-tab="all">All</button>
      <button class="tab-btn" data-tab="ready">Ready</button>
      <button class="tab-btn" data-tab="scheduled">Scheduled</button>
      <button class="tab-btn" data-tab="triggered">Triggered</button>
      <button class="tab-btn" data-tab="error">Error</button>
    `;
  } else if (cat === 'users') {
    pageTabs.innerHTML = `
      <button class="tab-btn active" data-tab="all">All</button>
      <button class="tab-btn" data-tab="active">Active</button>
      <button class="tab-btn" data-tab="api">API Users</button>
    `;
  } else {
    pageTabs.innerHTML = '';
  }

  pageTabs.onclick = (e) => {
    if (e.target.classList.contains('tab-btn')) {
      pageTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      filterAndRenderList();
    }
  };
}

function filterAndRenderList() {
  const query = pageSearchInput.value.toLowerCase();
  const activeTabBtn = pageTabs.querySelector('.tab-btn.active');
  const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'all';

  let filtered = allItems;

  // Tab Filtering
  if (currentCategory === 'journeys') {
    if (activeTab === 'active') filtered = allItems.filter(i => ['Executing', 'Paused', 'Scheduled'].includes(i.meta));
    else if (activeTab === 'published') filtered = allItems.filter(i => i.meta === 'Published');
    else if (activeTab === 'draft') filtered = allItems.filter(i => i.meta === 'Draft');
    else if (activeTab === 'stopped') filtered = allItems.filter(i => ['Stopped', 'Deleted'].includes(i.meta));
  } else if (currentCategory === 'automations') {
    if (activeTab === 'ready') filtered = allItems.filter(i => Number(i.meta) === 2);
    else if (activeTab === 'scheduled') filtered = allItems.filter(i => Number(i.meta) === 6);
    else if (activeTab === 'triggered') filtered = allItems.filter(i => Number(i.meta) === 7);
    else if (activeTab === 'error') filtered = allItems.filter(i => Number(i.meta) === 0 || Number(i.meta) === -1);
  } else if (currentCategory === 'users') {
    if (activeTab === 'active') filtered = allItems.filter(i => i.active === 'True' || i.active === 'true' || i.active === true);
    else if (activeTab === 'api') filtered = allItems.filter(i => i.isApi === 'True' || i.isApi === 'true' || i.isApi === true);
  }

  // Search Filtering
  if (query) {
    filtered = filtered.filter(i => 
      (i.name && i.name.toLowerCase().includes(query)) || 
      (i.key && i.key.toLowerCase().includes(query))
    );
  }

  if (currentCategory === 'data-ext') {
    // For DEs, we use the specific search function
    renderDEListSearch(query);
  } else {
    renderList(filtered);
  }
}

/** Specific search for DEs within the Hub */
function renderDEListSearch(query) {
    if (!deCategorizedData) return;
    
    // Find which pill is active
    const activePill = pageTabs.querySelector('.stat-pill.active');
    const filterType = activePill ? activePill.dataset.filter : 'all';
    
    let baseItems = deCategorizedData.all;
    if (filterType === 'active') baseItems = deCategorizedData.active;
    if (filterType === 'empty') baseItems = deCategorizedData.empty;
    
    const filtered = baseItems.filter(i => 
        (i.name && i.name.toLowerCase().includes(query)) || 
        (i.key && i.key.toLowerCase().includes(query))
    );
    
    // Logic from renderFilteredDEList but without re-rendering the whole structure
    const tbody = $('de-table-body');
    if (!tbody) {
        // If user is searching but we're not in the table view (unlikely), force it
        renderFilteredDEList(filterType);
        return;
    }
    
    tbody.innerHTML = '';
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${filterType === 'empty' ? '4' : '3'}" style="text-align:center; padding:40px">Aucun résultat</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'table-row';
        const eName   = escapeHtml(item.name);
        const eKey    = escapeHtml(item.key);
        const eCatId  = escapeHtml(item.categoryId || '0');
        tr.innerHTML = `
            <td class="col-name" title="${eName}">${eName}</td>
            <td class="col-key" title="${eKey}">${eKey}</td>
            <td><span class="badge">${eCatId}</span></td>
            ${filterType === 'empty' ? `<td><button class="btn-danger btn-delete-de" data-key="${eKey}">Supprimer</button></td>` : ''}
        `;
        tr.onclick = (e) => {
            if (e.target.classList.contains('btn-delete-de')) {
                e.stopPropagation();
                handleDeleteDE(item.key, tr);
                return;
            }
            selectItem(item.id);
        };
        tbody.appendChild(tr);
    });
}

function renderList(items) {
  if (items.length === 0) {
    pageListContainer.innerHTML = '<div class="details-empty">No records found.</div>';
    return;
  }

  pageListContainer.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Nom</th>
            <th>Clé externe</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody id="list-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = pageListContainer.querySelector('#list-tbody');
  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    
    let displayMeta = item.meta || '-';
    if (currentCategory === 'automations') {
      const numMeta = Number(item.meta);
      const am = { 2:'Ready', 6:'Scheduled', 7:'Triggered', 3:'Running', 0:'Error', '-1':'Error' };
      displayMeta = am[numMeta] || item.meta;
    }

    const eName = escapeHtml(item.name || 'Unnamed');
    const eKey  = escapeHtml(item.key);
    const eMeta = escapeHtml(displayMeta);
    tr.innerHTML = `
      <td class="col-name" title="${eName}">${eName}</td>
      <td class="col-key" title="${eKey}">${eKey}</td>
      <td><span class="badge">${eMeta}</span></td>
    `;

    tr.onclick = () => selectItem(item.id);
    tbody.appendChild(tr);
  });
}

// ─── Detail Logic ──────────────────────────────────────────────────────────

async function selectItem(id) {
  currentItemId = id;
  // Update list selection UI (except for Data Extensions which use a different Hub view)
  if (currentCategory !== 'data-ext') {
    document.querySelectorAll('.table-row').forEach(el => el.classList.remove('active'));
    // No need to re-render the whole list just for selection in the main renderList
  }

  // Show details
  pageDetailSection.classList.add('visible');
  pageDetailContent.classList.remove('hidden'); // Fix: ensure the content wrapper is visible
  pageDetailContent.innerHTML = '<div class="loading-box"><div class="spinner"></div><span>Chargement...</span></div>';

  try {
    if (currentCategory === 'journeys') {
      const [data, history] = await Promise.all([
        sendMsg('FETCH_JOURNEY_BY_ID', { id }),
        sendMsg('FETCH_JOURNEY_HISTORY', { id })
      ]);
      const versions = await sendMsg('FETCH_JOURNEY_VERSIONS', { key: data.key });
      renderJourneyDetail(data, history, versions);
    } else if (currentCategory === 'automations') {
      const data = await sendMsg('FETCH_AUTOMATION_BY_ID', { id });
      renderAutomationDetail(data);
    } else if (currentCategory === 'data-ext') {
      const item = deCategorizedData ? deCategorizedData.all.find(i => i.id === id) : null;
      if (!item) throw new Error('Détails introuvables');
      const recordCount = await sendMsg('FETCH_DE_RECORD_COUNT', { key: item.key });
      renderDataExtensionDetail(item, recordCount);
    } else if (currentCategory === 'users') {
      const item = allItems.find(i => i.id === id);
      renderUserDetail(item);
    }
  } catch (err) {
    pageDetailContent.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
  }
}

function renderJourneyDetail(data, history, versions) {
  const trigger = data.triggers?.[0] || {};
  const meta = trigger.metaData || {};
  const triggerName = meta.title || trigger.name || trigger.type || 'None';
  
  const stats = data.stats || {};
  const activities = (data.activities || []).slice(0, 12);

  const SVG_MAIL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
  const SVG_SMS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  const SVG_WAIT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
  const SVG_SPLIT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>`;
  const SVG_DEFAULT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>`;

  const activitiesHtml = activities.map(a => {
    let icon = SVG_DEFAULT;
    const type = a.type?.toLowerCase() || '';
    if (type.includes('email')) icon = SVG_MAIL;
    else if (type.includes('sms')) icon = SVG_SMS;
    else if (type.includes('wait')) icon = SVG_WAIT;
    else if (type.includes('split')) icon = SVG_SPLIT;
    const aLabel = escapeHtml(a.name || a.type);
    const aType  = escapeHtml(a.type);
    return `
      <div class="canvas-activity">
        <div class="canvas-activity-icon">${icon}</div>
        <div class="canvas-activity-info">
          <div class="canvas-activity-name" title="${aLabel}">${aLabel}</div>
          <div class="canvas-activity-type">${aType}</div>
        </div>
      </div>
    `;
  }).join('');

  breadcrumbDetail.textContent = data.name;

  const jName    = escapeHtml(data.name);
  const jKey     = escapeHtml(data.key);
  const jVersion = Number(data.version);
  const jStatus  = escapeHtml(data.status);
  const jTrigger = escapeHtml(triggerName);

  pageDetailContent.innerHTML = `
    <div class="detail-header-bar">
        <button class="btn-back" id="btnBack">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <div style="flex:1">
            <h2 style="font-size:1.5rem; font-weight:800; letter-spacing: -0.03em;">${jName}</h2>
            <div style="font-size:0.85rem; color:var(--text-muted); font-weight:500">Version ${jVersion} • ${jKey}</div>
        </div>
        <div>
            <span class="badge-clean ${data.status.toLowerCase() === 'executing' ? 'active' : 'stopped'}">${jStatus}</span>
        </div>
    </div>

    <div class="detail-body">
        <div class="detail-grid">
            <div class="detail-card">
              <span class="label-sm">Contacts Actifs</span>
              <div class="value-large-stats">${formatNumber(stats.currentPopulation)}</div>
            </div>
            <div class="detail-card">
              <div class="label-sm">Entrées Totales</div>
              <div class="value-lg">${formatNumber(stats.cumulativePopulation)}</div>
            </div>
            <div class="detail-card">
              <div class="label-sm">Taux de Succès</div>
              <div class="value-lg">${(stats.goalPerformance || 0).toFixed(1)}%</div>
            </div>
            <div class="detail-card">
              <div class="label-sm">Source d'Entrée</div>
              <div class="value-lg" style="font-size:1rem">${jTrigger}</div>
            </div>
        </div>

        <div class="detail-group" style="margin-top:24px">
            <div class="label-sm" style="margin-bottom:12px">Aperçu du Parcours</div>
            <div class="canvas-grid">
                ${activitiesHtml}
            </div>
        </div>
    </div>
  `;

  $('btnBack').onclick = () => pageDetailSection.classList.remove('visible');
}

function calculateAnnualRuns(icalRecur) {
    if (!icalRecur) return 0;
    
    const parts = icalRecur.split(';');
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
         return 0; // Déjà terminé
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
        default: multiplier = 0; break;
    }
    return multiplier;
}

function renderAutomationDetail(data) {
  breadcrumbDetail.textContent = data.name;
  const s = data.status || data.statusId;
  let statusText = 'Ready';
  if (s === 6) statusText = 'Scheduled';
  else if (s === 7) statusText = 'Awaiting Trigger';
  else if (s === 3) statusText = 'Running';
  else if (s === 4) statusText = 'Paused';
  else if (s === 0 || s === -1) statusText = 'Error';

  const badgeClass = (s === 0 || s === -1) ? 'stopped' : 'active';

  // Extract variables safely
  const createdDate = data.createdDate ? new Date(data.createdDate).toLocaleDateString() : '-';
  const lastRunTime = data.lastRunTime ? new Date(data.lastRunTime).toLocaleString() : 'Jamais ex\u00E9cut\u00E9e';
  const createdByName = (data.createdBy && data.createdBy.name) ? data.createdBy.name : 'Syst\u00E8me';
  
  const ical = data.schedule?.icalRecur || '';
  const totalRuns12M = ical ? calculateAnnualRuns(ical) : 0;
  const typeStr = data.type || (data.schedule ? 'Scheduled' : 'Triggered');

  const aName    = escapeHtml(data.name);
  const aKey     = escapeHtml(data.customerKey || data.key);
  const aId      = escapeHtml(data.id);
  const aCatId   = escapeHtml(String(data.categoryId || '-'));
  const aType    = escapeHtml(typeStr);
  const aCreator = escapeHtml(createdByName);
  const aIcal    = escapeHtml(ical || 'Une seule fois');

  pageDetailContent.innerHTML = `
    <div class="detail-header-bar">
        <button class="btn-back" id="btnBack">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <div style="flex:1">
            <h2 style="font-size:1.5rem; font-weight:800; letter-spacing: -0.03em;">${aName}</h2>
            <div style="font-size:0.85rem; color:var(--text-muted); font-weight:500">${aKey} • ID: ${aId}</div>
        </div>
        <div>
            <span class="badge-clean ${badgeClass}">${escapeHtml(statusText)}</span>
        </div>
    </div>

    <div class="detail-body">
      <div class="detail-grid">
        <div class="detail-card">
          <div class="label-sm">Catégorie / BU</div>
          <div class="value-lg">${aCatId}</div>
        </div>
        <div class="detail-card">
          <div class="label-sm">Type</div>
          <div class="value-lg">${aType}</div>
        </div>
        <div class="detail-card">
          <div class="label-sm">Dernière Exécution</div>
          <div class="value-lg" style="font-size:0.95rem">${escapeHtml(lastRunTime)}</div>
        </div>
        <div class="detail-card">
          <div class="label-sm">Date de Création</div>
          <div class="value-lg">${escapeHtml(createdDate)}</div>
        </div>
        <div class="detail-card">
          <div class="label-sm">Créé par</div>
          <div class="value-lg">${aCreator}</div>
        </div>
        <div class="detail-card">
          <div class="label-sm">Total Runs 12M (Proj.)</div>
          <div class="value-large-stats">${formatNumber(totalRuns12M)} <span style="font-size:40%; opacity:0.6; font-weight:500;">runs</span></div>
        </div>
        <div class="detail-card full-width">
          <div class="label-sm">Recurrence (iCal)</div>
          <div class="value-mono">${aIcal}</div>
        </div>
      </div>
    </div>
  `;
  $('btnBack').onclick = () => pageDetailSection.classList.remove('visible');
}



function renderUserDetail(item) {
  breadcrumbDetail.textContent = item.name || item.email;
  
  const isActive = item.active === 'True' || item.active === 'true' || item.active === true;
  const isApi = item.isApi === 'True' || item.isApi === 'true' || item.isApi === true;

  const uName  = escapeHtml(item.name || 'Unnamed User');
  const uEmail = escapeHtml(item.email);
  const uCreated   = escapeHtml(item.created);
  const uLastLogin = escapeHtml(item.lastLogin || 'Never recorded');

  pageDetailContent.innerHTML = `
    <div class="detail-header-bar">
        <button class="btn-back" id="btnBack">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <div style="flex:1">
            <h2 style="font-size:1.5rem; font-weight:800; letter-spacing: -0.03em;">${uName}</h2>
            <div style="font-size:0.85rem; color:var(--text-muted); font-weight:500">${uEmail}</div>
        </div>
        <div>
            <span class="badge-clean ${isActive ? 'active' : 'stopped'}">${isActive ? 'Active' : 'Inactive'}</span>
        </div>
    </div>

    <div class="detail-body">
      <div class="detail-grid">
        <div class="detail-card">
          <span class="label-sm">Access Method</span>
          <div class="value-lg">${isApi ? 'API User' : 'Standard UI'}</div>
        </div>
        <div class="detail-card">
            <span class="label-sm">Created Date</span>
            <div class="value-lg">${uCreated}</div>
        </div>
        <div class="detail-card full-width">
            <span class="label-sm">Last Successful Login</span>
            <div class="value-lg">${uLastLogin}</div>
        </div>
      </div>
    </div>
  `;
  $('btnBack').onclick = () => pageDetailSection.classList.remove('visible');
}


// ─── Limits Dashboard Logic ────────────────────────────────────────────────

async function renderLimitsDashboard() {
  pageListContainer.innerHTML = '<div class="loading-state">Analyzing capacity...</div>';
  pageTabs.innerHTML = '';
  breadcrumbDetail.textContent = 'Synthesis';

  try {
    const config = await getClientConfig();
    
    // If no clients defined, show onboarding
    if (!config.clients || config.clients.length === 0) {
      renderOnboardingView();
      return;
    }

    // Currently showing the first/main client (can expand to multiple later)
    const client = config.clients[0];
    const tier = SFMC_TIERS[client.tier.toLowerCase()] || SFMC_TIERS.pro;

    // Fetch live metrics
    const stats = await sendMsg('FETCH_ALL_METRICS', { force: true });
    const annualAutomations = await sendMsg('FETCH_AUTOMATION_ANNUAL_VOLUME');

    pageListContainer.innerHTML = `
      <div class="limits-view">
        <div class="detail-header">
           <div class="detail-header-info">
             <h2>Capacité SFMC — ${client.name}</h2>
             <div class="detail-header-metadata">
               <span>Période: Annuelle / YTD</span>
               <span class="separator">•</span>
               <span class="status-badge active">${tier.name} Tier</span>
             </div>
           </div>
        </div>

        <div class="limits-grid">
          ${renderLimitCard('Contacts', stats.contacts || 0, tier.limits.contacts, 'user')}
          ${renderLimitCard('Automations', annualAutomations, tier.limits.automations, 'zap')}
          ${renderLimitCard('Active Users', stats.users || 0, tier.limits.users, 'users')}
          ${renderLimitCard('Data Extensions', stats.dataExtensions || 0, tier.limits.storage * 100, 'database', '', 'DEs est.')}
        </div>

        <div class="detail-group">
            <div class="detail-group-title">Configuration</div>
            <div style="display:flex; gap:12px">
                <button class="btn-sidebar-refresh" id="btnEditConfig" style="max-width:200px">
                    Changer de Licence
                </button>
            </div>
        </div>
      </div>
    `;

    $('btnEditConfig').onclick = () => renderOnboardingView();

  } catch (err) {
    pageListContainer.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
  }
}

function renderLimitCard(title, usage, limit, icon, unit = '', subtext = 'restant') {
  const analysis = calculateUsage(usage, limit);
  const formattedLimit = limit === 0 ? 'Illimité' : formatNumber(limit) + unit;
  const formattedUsage = formatNumber(usage) + unit;

  const SVG_CONTACTS = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
  const SVG_STORAGE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`;
  const SVG_ZAP = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>`;
  const SVG_USERS = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

  let currentIcon = SVG_CONTACTS;
  if (icon === 'database') currentIcon = SVG_STORAGE;
  if (icon === 'zap') currentIcon = SVG_ZAP;
  if (icon === 'users') currentIcon = SVG_USERS;

  return `
    <div class="limit-card status-${analysis.status}">
      <div class="limit-header">
        <div class="limit-icon">${currentIcon}</div>
        <div class="alert-badge">${analysis.status}</div>
      </div>
      <div class="limit-info">
        <div class="limit-title">${title}</div>
        <div class="limit-value-box">
          <span class="limit-current">${formattedUsage}</span>
          <span class="limit-total">/ ${formattedLimit}</span>
        </div>
      </div>
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${analysis.percent}%"></div>
        </div>
        <div class="limit-footer">
          <span class="limit-percent">${analysis.percent}% utilisé</span>
          <span class="limit-remaining">${limit === 0 ? '' : formatNumber(analysis.remaining) + ' ' + subtext}</span>
        </div>
      </div>
    </div>
  `;
}

async function renderOnboardingView() {
    pageListContainer.innerHTML = `
        <div class="onboarding-view">
            <div class="onboarding-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
            </div>
            <h2>Configuration de la Licence</h2>
            <p style="color:var(--text-muted); margin-top:12px; max-width:400px">
                Sélectionnez votre type de licence Salesforce Marketing Cloud pour activer le suivi des limites.
            </p>
            
            <div style="margin-top:32px; display:flex; flex-direction:column; gap:16px; width:100%; max-width:320px; text-align:left">
                <div class="field">
                    <label style="font-weight:700; font-size:0.85rem; margin-bottom:8px; display:block">TYPE DE LICENCE</label>
                    <select id="setup_client_tier" style="width:100%; padding:12px; border-radius:10px; border:1.5px solid var(--border-dark); font-family:inherit; font-weight:600">
                        <option value="pro">Pro Edition</option>
                        <option value="corporate">Corporate Edition</option>
                        <option value="enterprise">Enterprise Edition</option>
                        <option value="basic">Basic Edition</option>
                    </select>
                </div>
            </div>

            <button class="btn-primary" id="btnSaveOnboarding" style="margin-top:32px">Activer le Dashboard</button>
        </div>
    `;

    $('btnSaveOnboarding').onclick = async () => {
        const tier = $('setup_client_tier').value;
        const config = {
            clients: [{ name: 'Instance SFMC', tier, manualStorageGb: 0 }]
        };
        
        await saveClientConfig(config);
        renderLimitsDashboard();
    };
}


// ─── Data Extension Advanced Logic ────────────────────────────────────────

let deCategorizedData = null;

async function renderDataExtensionsOverview() {
    breadcrumbDetail.textContent = 'Hub';
    viewTitle.textContent = 'Data Extension Hub';
    pageTabs.innerHTML = ''; // Clear any tabs from previous categories (Automations, etc.)
    
    // Check if we already have the data in memory to avoid full refetch every time
    // but we can also just show the table immediately with a loading state
    pageListContainer.innerHTML = `
        <div class="de-hub-view">
            <div id="deStatsBar" class="stats-summary-bar">
                <div class="stat-pill active" data-filter="all">Total DEs <span class="pill-count">...</span></div>
                <div class="stat-pill" data-filter="active">Actives <span class="pill-count">...</span></div>
                <div class="stat-pill" data-filter="empty">Vides <span class="pill-count">...</span></div>
            </div>
            <div id="deListContainer">
                <div class="loading-state">Initialisation de la liste...</div>
            </div>
        </div>
    `;

    // Attach pill events
    const pills = pageListContainer.querySelectorAll('.stat-pill');
    pills.forEach(pill => {
        pill.onclick = () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            renderFilteredDEList(pill.dataset.filter);
        };
    });

    try {
        // If we don't have categorization data, fetch it
        if (!deCategorizedData) {
            const data = await sendMsg('FETCH_DE_CATEGORY_COUNTS');
            deCategorizedData = data;
        }

        // Process Notifications
        checkRetentionWarnings(deCategorizedData.all);

        // Update pills counts
        const valAll = pageListContainer.querySelector('[data-filter="all"] .pill-count');
        const valActive = pageListContainer.querySelector('[data-filter="active"] .pill-count');
        const valEmpty = pageListContainer.querySelector('[data-filter="empty"] .pill-count');
        
        if (valAll) valAll.textContent = deCategorizedData.total;
        if (valActive) valActive.textContent = deCategorizedData.active.length;
        if (valEmpty) valEmpty.textContent = deCategorizedData.empty.length;

        // Render the "All" list by default
        renderFilteredDEList('all');

    } catch (err) {
        pageListContainer.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
    }
}

function renderFilteredDEList(type) {
    if (!deCategorizedData) return;
    
    let items = deCategorizedData.all;
    if (type === 'active') items = deCategorizedData.active;
    if (type === 'empty') items = deCategorizedData.empty;

    const listContainer = $('deListContainer');
    if (!listContainer) return;

    listContainer.innerHTML = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Nom</th>
                        <th>Clé Externe</th>
                        <th>Détail</th>
                        ${type === 'empty' ? '<th>Action</th>' : ''}
                    </tr>
                </thead>
                <tbody id="de-table-body"></tbody>
            </table>
        </div>
    `;
    
    const tbody = listContainer.querySelector('#de-table-body');
    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${type === 'empty' ? '4' : '3'}" style="text-align:center; padding:40px">Aucun résultat</td></tr>`;
        return;
    }

    items.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'table-row';
        const eName  = escapeHtml(item.name);
        const eKey   = escapeHtml(item.key);
        const eCatId = escapeHtml(item.categoryId || '0');
        tr.innerHTML = `
            <td class="col-name" title="${eName}">${eName}</td>
            <td class="col-key" title="${eKey}">${eKey}</td>
            <td><span class="badge">${eCatId}</span></td>
            ${type === 'empty' ? `<td><button class="btn-danger btn-delete-de" data-key="${eKey}">Supprimer</button></td>` : ''}
        `;

        tr.onclick = (e) => {
            if (e.target.classList.contains('btn-delete-de')) {
                e.stopPropagation();
                handleDeleteDE(item.key, tr);
                return;
            }
            selectItem(item.id);
        };
        tbody.appendChild(tr);
    });
}

// Removed renderDEListItems as it is now part of renderFilteredDEList

function renderDataExtensionDetail(item, recordCount) {
    breadcrumbDetail.textContent = item.name;
    pageDetailSection.classList.add('visible');
    
    let retention = 'Aucune';
    const hasRetention = (item.deleteAtEnd === 'true' || item.deleteAtEnd === 'True' || item.deleteAtEnd === true);

    if (hasRetention) {
        if (item.retentionLength && item.retentionLength !== '0') {
            const isRowBased = (item.rowBasedRetention === 'true' || item.rowBasedRetention === 'True' || item.rowBasedRetention === true);
            const unitTranslation = {
                'Days': 'Jours',
                'Weeks': 'Semaines',
                'Months': 'Mois',
                'Years': 'Années'
            };
            const unit = unitTranslation[item.retentionUnit] || escapeHtml(item.retentionUnit);
            const scope = isRowBased ? '(Par enregistrement)' : '(Toute la Data Extension)';
            retention = `${escapeHtml(String(item.retentionLength))} ${unit} <span style="opacity:0.6; font-size:0.8em; margin-left:6px">${scope}</span>`;
        } else if (item.retainUntil && item.retainUntil !== '1/1/0001 12:00:00 AM') {
            retention = `Jusqu'au ${new Date(item.retainUntil).toLocaleDateString()}`;
        }
    }

    const created = item.createdDate ? new Date(item.createdDate).toLocaleDateString() : '-';

    const deName = escapeHtml(item.name);
    const deKey  = escapeHtml(item.key);

    pageDetailContent.innerHTML = `
      <div class="detail-header-bar">
          <button class="btn-back" id="btnBack">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
          </button>
          <div style="flex:1">
              <h2 id="detail-title" style="font-size:1.5rem; font-weight:800; letter-spacing: -0.03em;">${deName}</h2>
          </div>
          <div class="action-bar">
              <button class="btn-action" id="btnShowSchema">Voir le Schéma</button>
              <button class="btn-action btn-primary-sc" id="btnEditRetention">Modifier la Rétention</button>
          </div>
      </div>

      <div class="detail-body">
        <div class="detail-grid">
          <div class="detail-card">
            <span class="label-sm">Nom de la Data Extension</span>
            <span class="value-lg">${deName}</span>
          </div>
          <div class="detail-card">
            <span class="label-sm">Clé Externe (Customer Key)</span>
            <span class="value-mono">${deKey}</span>
          </div>
          <div class="detail-card">
            <span class="label-sm">Créé le</span>
            <span class="value-lg">${escapeHtml(created)}</span>
          </div>
          <div class="detail-card">
            <span class="label-sm">Nombre d'enregistrements</span>
            <span class="value-large-stats">${formatNumber(recordCount)}</span>
          </div>
          <div class="detail-card full-width">
            <span class="label-sm">Politique de Rétention</span>
            <span class="value-lg">${retention}</span>
          </div>
        </div>
      </div>
    `;

    pageDetailContent.classList.remove('hidden');
    
    const bBtn = $('btnBack');
    if (bBtn) bBtn.onclick = () => pageDetailSection.classList.remove('visible');
    
    const sBtn = $('btnShowSchema');
    if (sBtn) sBtn.onclick = () => showSchemaModal(item.key, item.name);
    
    const rBtn = $('btnEditRetention');
    if (rBtn) rBtn.onclick = () => showRetentionModal(item.key, item.name, item.retentionLength, item.retentionUnit, hasRetention);
}

async function showSchemaModal(key, name) {
    showModal('Chargement...', '<div class="loading-state">Récupération des champs...</div>');
    
    try {
        const fields = await sendMsg('FETCH_DE_FIELDS', { key });
        const pkCount = fields.filter(f => f.isPrimaryKey === 'true' || f.isPrimaryKey === true).length;
        
        let html = `
            <div class="schema-header-summary" style="margin-bottom:16px; display:flex; gap:12px">
                <div class="badge-clean">${fields.length} champs</div>
                <div class="badge-clean active">${pkCount} clés primaires</div>
            </div>
            <div class="schema-viewer">
                <table class="schema-table">
                    <thead>
                        <tr>
                            <th>Champ</th>
                            <th>Type</th>
                            <th style="text-align:center">PK</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${fields.map(f => {
                            const isPK = f.isPrimaryKey === 'true' || f.isPrimaryKey === true;
                            const isReq = f.isRequired === 'true' || f.isRequired === true;
                            const type = f.type ? f.type.toLowerCase() : 'text';
                            
                            let typeClass = 'type-text';
                            if (type.includes('number') || type.includes('int')) typeClass = 'type-number';
                            else if (type.includes('date')) typeClass = 'type-date';
                            else if (type.includes('boolean')) typeClass = 'type-boolean';
                            else if (type.includes('decimal') || type.includes('currency')) typeClass = 'type-decimal';

                            const fName = escapeHtml(f.name);
                            const fType = escapeHtml(f.type);
                            const fLen  = f.length ? escapeHtml(f.length) : '';
                            return `
                                <tr>
                                    <td>
                                        <div style="font-weight:700; color:var(--text-main)">
                                            ${fName} ${isReq ? '<span class="required-mark">*</span>' : ''}
                                        </div>
                                    </td>
                                    <td>
                                        <span class="schema-badge ${typeClass}">
                                            ${fType}${fLen ? ` (${fLen})` : ''}
                                        </span>
                                    </td>
                                    <td style="text-align:center">
                                        ${isPK ? '<span class="pk-icon">K</span>' : '<span style="opacity:0.2">-</span>'}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
        showModal(`Schéma : ${name}`, html);
    } catch (err) {
        showModal('Erreur', `<div class="error-state">${err.message}</div>`);
    }
}

function showRetentionModal(key, name, currentLength, currentUnit, isCurrentlyEnabled) {
    
    // Default values if we choose to enable it
    const displayLength = isCurrentlyEnabled ? currentLength : 3;
    const displayUnit = (currentUnit && currentUnit !== '0' && currentUnit !== '') ? currentUnit : 'Months';

    const html = `
        <div class="modal-form">
            <div class="field" style="margin-bottom: 20px; display: flex; align-items: center; gap: 10px; background: #F8FAFC; padding: 12px; border-radius: 8px;">
                <input type="checkbox" id="retention_enabled" ${isCurrentlyEnabled ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;" />
                <label for="retention_enabled" style="font-weight: 700; font-size: 0.9rem; cursor: pointer; user-select: none;">Activer la rétention de données</label>
            </div>

            <div id="retention_settings_group" style="${isCurrentlyEnabled ? '' : 'opacity: 0.5; pointer-events: none;'}">
                <div class="field">
                    <label style="font-weight:700; font-size:0.85rem; margin-bottom:8px; display:block">DataRetentionPeriodLength</label>
                    <div style="display:flex; gap:10px">
                        <input type="number" id="retention_length" value="${displayLength}" style="flex:1; padding:10px; border-radius:8px; border:1px solid #E2E8F0" />
                        <select id="retention_unit" style="flex:1; padding:10px; border-radius:8px; border:1px solid #E2E8F0">
                            <option value="Days" ${displayUnit === 'Days' ? 'selected' : ''}>Days</option>
                            <option value="Weeks" ${displayUnit === 'Weeks' ? 'selected' : ''}>Weeks</option>
                            <option value="Months" ${displayUnit === 'Months' ? 'selected' : ''}>Months</option>
                            <option value="Years" ${displayUnit === 'Years' ? 'selected' : ''}>Years</option>
                        </select>
                    </div>
                </div>
                <p style="font-size: 0.75rem; color: #64748B; margin-top: 8px;">
                    Note: Les enregistrements seront supprimés définitivement après cette période.
                </p>
            </div>

            <div class="modal-actions" style="margin-top:24px; display:flex; gap:12px">
                <button class="btn-primary-sc" id="btnConfirmRetention" style="flex:1; padding:12px; border-radius:8px; border:none; color:white; font-weight:700; cursor:pointer">Confirmer</button>
                <button class="btn-action" id="btnCancelRetention" style="flex:1">Annuler</button>
            </div>
        </div>
    `;
    
    showModal(`Modifier : ${name}`, html);

    const toggle = $('retention_enabled');
    const group = $('retention_settings_group');
    
    toggle.onchange = () => {
        group.style.opacity = toggle.checked ? '1' : '0.5';
        group.style.pointerEvents = toggle.checked ? 'auto' : 'none';
        
        // If enabling for the very first time, set default values, otherwise keep the ones loaded
        if (toggle.checked && !isCurrentlyEnabled && $('retention_length').value === '') {
             $('retention_length').value = 3;
             $('retention_unit').value = 'Months';
        }
    };
    
    $('btnConfirmRetention').onclick = async () => {
        const enabled = toggle.checked;
        const length = $('retention_length').value;
        const unit = $('retention_unit').value;
        
        try {
            await sendMsg('UPDATE_DE_RETENTION', { key, name, length, unit, enabled });
            closeModal();
            showToast(enabled ? 'Rétention mise à jour' : 'Rétention désactivée');
            
            // Refresh local data & UI
            if (deCategorizedData) {
                const item = deCategorizedData.all.find(i => i.key === key);
                if (item) {
                   item.deleteAtEnd = enabled ? 'true' : 'false';
                   item.retentionLength = enabled ? length : '';
                   item.retentionUnit = enabled ? unit : '';
                }
            }
            selectItem(currentItemId);
        } catch (err) {
            alert(`Erreur: ${err.message}`);
        }
    };
    
    $('btnCancelRetention').onclick = closeModal;
}

async function handleDeleteDE(key, element) {
    if (!confirm(`Êtes-vous sûr de vouloir supprimer la DE "${key}" ? Cette action est irréversible.`)) return;
    
    try {
        await sendMsg('DELETE_DE', { key });
        showToast('Data Extension supprimée');
        
        // Update local data to keep filters consistent
        if (deCategorizedData) {
            deCategorizedData.all = deCategorizedData.all.filter(i => i.key !== key);
            deCategorizedData.active = deCategorizedData.active.filter(i => i.key !== key);
            deCategorizedData.empty = deCategorizedData.empty.filter(i => i.key !== key);
            deCategorizedData.total = deCategorizedData.all.length;
            
            // Update pills counts without full re-render
            const valAll = document.querySelector('[data-filter="all"] .pill-count');
            const valActive = document.querySelector('[data-filter="active"] .pill-count');
            const valEmpty = document.querySelector('[data-filter="empty"] .pill-count');
            if (valAll) valAll.textContent = deCategorizedData.total;
            if (valActive) valActive.textContent = deCategorizedData.active.length;
            if (valEmpty) valEmpty.textContent = deCategorizedData.empty.length;
        }

        element.style.opacity = '0';
        element.style.transform = 'translateY(10px)';
        setTimeout(() => element.remove(), 300);
    } catch (err) {
        alert(`Cette DE ne peut pas être supprimée (data relationship existante).`);
    }
}

// ─── Notifications System ──────────────────────────────────────────────────

function checkRetentionWarnings(items) {
    const notifBadge = $('notifBadge');
    const notifBody = $('notifBody');
    if (!notifBadge || !notifBody) return;

    const expiringDEs = [];
    const now = Date.now();
    const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;

    items.forEach(item => {
        // We only care about Object-based retention (the whole DE gets deleted)
        const isDeleteAtEnd = (item.deleteAtEnd === 'true' || item.deleteAtEnd === 'True' || item.deleteAtEnd === true);
        const isRowBased = (item.rowBasedRetention === 'true' || item.rowBasedRetention === 'True' || item.rowBasedRetention === true);
        
        // Let's include BOTH RowBased and ObjectBased if they have a delete limitation, 
        // to show more alerts according to user feedback (though object-based is the only true deletion).
        // The user asked to show DEs whose retention is in 1 week. If they enable row-based, it still has a retention policy.
        // We will compute for all that have `isDeleteAtEnd`.
        if (isDeleteAtEnd) {
            let expirationDate = null;
            
            // If SFMC gives us an exact date
            if (item.retainUntil && item.retainUntil !== '1/1/0001 12:00:00 AM') {
                expirationDate = new Date(item.retainUntil).getTime();
            } else if (item.createdDate && item.retentionLength && item.retentionLength !== '0') {
                // Approximate it: CreatedDate + RetentionLength
                const created = new Date(item.createdDate).getTime();
                const length = parseInt(item.retentionLength, 10);
                const unit = item.retentionUnit;
                
                let msToAdd = 0;
                switch(unit) {
                    case 'Days': msToAdd = length * 24 * 60 * 60 * 1000; break;
                    case 'Weeks': msToAdd = length * 7 * 24 * 60 * 60 * 1000; break;
                    case 'Months': msToAdd = length * 30 * 24 * 60 * 60 * 1000; break; // Approx
                    case 'Years': msToAdd = length * 365 * 24 * 60 * 60 * 1000; break;
                }
                if (msToAdd > 0) {
                    expirationDate = created + msToAdd;
                }
            }

            if (expirationDate) {
                const timeDiff = expirationDate - now;
                // Between 0 and 15 days
                if (timeDiff >= 0 && timeDiff <= FIFTEEN_DAYS) {
                    const daysLeft = Math.ceil(timeDiff / (24 * 60 * 60 * 1000));
                    expiringDEs.push({ name: item.name, id: item.id, daysLeft, isRowBased });
                }
            }
        }
    });

    if (expiringDEs.length === 0) {
        notifBadge.classList.add('hidden');
        notifBody.innerHTML = `
            <div class="notif-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                <span>Aucune péremption prévue<br>dans les 15 prochains jours.</span>
            </div>
        `;
        // Also update header
        const dropHeader = $('notifDropdown').querySelector('.notif-header');
        if (dropHeader) dropHeader.innerHTML = `Alertes Rétention (≤ 15 jours) <span class="badge-count" style="background:var(--success)">0</span>`;
        return;
    }

    // Sort by days left (closest first)
    expiringDEs.sort((a, b) => a.daysLeft - b.daysLeft);

    notifBadge.textContent = expiringDEs.length > 9 ? '9+' : expiringDEs.length;
    notifBadge.classList.remove('hidden');

    const dropHeader = $('notifDropdown').querySelector('.notif-header');
    if (dropHeader) dropHeader.innerHTML = `Alertes Rétention <span class="badge-count">${expiringDEs.length}</span>`;

    notifBody.innerHTML = expiringDEs.map(de => {
        const isCritical = de.daysLeft <= 7;
        const iconClass = isCritical ? '' : 'warning';
        const textClass = isCritical ? '' : 'warning';
        const typeText = de.isRowBased ? 'Données' : 'Structure';
        const daysLeft = Number(de.daysLeft);

        return `
        <div class="notif-item" data-de-id="${escapeHtml(de.id)}">
            <div class="notif-item-icon ${iconClass}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    ${isCritical
                        ? '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
                        : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'}
                </svg>
            </div>
            <div class="notif-item-content">
                <div class="notif-title" title="${escapeHtml(de.name)}">${escapeHtml(de.name)}</div>
                <div class="notif-desc ${textClass}">
                    ${typeText} expire dans <strong>${daysLeft} jour${daysLeft > 1 ? 's' : ''}</strong>
                </div>
            </div>
        </div>
        `;
    }).join('');

    // Attach click handlers via event delegation instead of inline onclick
    notifBody.querySelectorAll('.notif-item').forEach(el => {
        el.addEventListener('click', () => selectItem(el.dataset.deId));
    });
}

// ─── Modal System ─────────────────────────────────────────────────────────

function showModal(title, content) {
    let modal = $('globalModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'globalModal';
        modal.className = 'modal-overlay';
        document.body.appendChild(modal);
    }
    
    modal.innerHTML = `
        <div class="modal-container">
            <div class="modal-header">
                <h3>${escapeHtml(title)}</h3>
                <button class="modal-close" id="btnCloseModal">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
            <div class="modal-content">
                ${content}
            </div>
        </div>
    `;
    
    modal.classList.add('active');
    $('btnCloseModal').onclick = closeModal;
    modal.onclick = (e) => { 
        if (e.target === modal) closeModal(); 
    };
}

function closeModal() {
    const modal = $('globalModal');
    if (modal) modal.classList.remove('active');
}

function showToast(msg, duration = 3000) {
    const toast = $('toast');
    if (toast) {
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), duration);
    }
}

// ─── AI Chat View ────────────────────────────────────────────────────────────

function renderAIView() {
  pageTabs.innerHTML = '';
  breadcrumbDetail.textContent = 'Assistant';
  viewTitle.textContent = 'AI Assistant';

  const historyHTML = aiMessages.length > 0
    ? aiMessages.map(m => buildAIMessageHTML(m.role, m.content)).join('')
    : buildAIWelcomeHTML();

  pageListContainer.innerHTML = `
    <div class="ai-view">
      <div class="ai-messages" id="aiMessages">${historyHTML}</div>
      <div class="ai-input-row">
        <textarea class="ai-textarea" id="aiInput" placeholder="Ask anything about your SFMC instance… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
        <button class="ai-send-btn" id="aiSendBtn" title="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>
  `;

  // Scroll to bottom if resuming a conversation
  if (aiMessages.length > 0) {
    const msgs = $('aiMessages');
    msgs.scrollTop = msgs.scrollHeight;
  }

  // Suggestion pill handlers
  pageListContainer.querySelectorAll('.ai-suggestion-btn').forEach(btn => {
    btn.onclick = () => {
      $('aiInput').value = btn.dataset.q;
      submitAIQuestion();
    };
  });

  // Auto-grow textarea
  const textarea = $('aiInput');
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });

  // Enter to send
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitAIQuestion();
    }
  });

  $('aiSendBtn').onclick = submitAIQuestion;
  textarea.focus();
}

function buildAIWelcomeHTML() {
  return `
    <div class="ai-welcome">
      <div class="ai-welcome-icon">✨</div>
      <h3>SFMC AI Assistant</h3>
      <p>Ask questions about your instance in natural language.<br>
         For best results, open the relevant tab first so the AI can see the full item list.</p>
      <div class="ai-suggestions">
        <button class="ai-suggestion-btn" data-q="Rapport de santé complet : donne-moi les chiffres clés de l'instance (contacts, DEs, automations, journeys, users) et signale toutes les anomalies détectées.">Rapport de santé</button>
        <button class="ai-suggestion-btn" data-q="Quelles automations sont en erreur (statut 0 ou -1) ? Liste leurs noms. Y a-t-il des automations en cours d'exécution ou en pause ?">Audit automations</button>
        <button class="ai-suggestion-btn" data-q="Quelles Data Extensions ont une rétention active (deleteAtEnd = true) ? Lesquelles expirent dans les 90 prochains jours ? Lesquelles n'ont aucune politique de rétention ?">Rétention des DEs</button>
        <button class="ai-suggestion-btn" data-q="Liste tous les utilisateurs API (isApi = true). Liste aussi les utilisateurs désactivés (active = false). Y a-t-il des comptes suspects ?">Audit utilisateurs</button>
        <button class="ai-suggestion-btn" data-q="Quels journeys sont actifs (Executing) en ce moment ? Combien de contacts sont en cours ? Y a-t-il des journeys en Executing mais sans contacts ?">Journeys actifs</button>
        <button class="ai-suggestion-btn" data-q="Quelles sont les automations planifiées (scheduledTime renseigné) ? Donne leurs noms et prochaine heure d'exécution.">Automations planifiées</button>
      </div>
    </div>
  `;
}

function buildAIMessageHTML(role, content, isThinking = false) {
  const avatarEmoji = role === 'user' ? '👤' : '✨';
  const bubbleContent = isThinking
    ? `<div class="ai-thinking-dots"><span></span><span></span><span></span></div>`
    : renderMarkdown(content);
  return `
    <div class="ai-message-row ${role}">
      <div class="ai-avatar ${role}">${avatarEmoji}</div>
      <div class="ai-bubble ${role}">${bubbleContent}</div>
    </div>
  `;
}

async function submitAIQuestion() {
  const input = $('aiInput');
  const question = input.value.trim();
  if (!question) return;

  const sendBtn = $('aiSendBtn');
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  const messagesEl = $('aiMessages');
  if (!messagesEl) return;

  // Fix 1: Guard — ensure SFMC metrics are loaded before calling AI
  const cached = await chrome.storage.local.get('sfmc_metrics_cache');
  if (!cached.sfmc_metrics_cache?.data) {
    try {
      await sendMsg('FETCH_ALL_METRICS');
    } catch {
      const welcome = messagesEl.querySelector('.ai-welcome');
      if (welcome) welcome.remove();
      messagesEl.insertAdjacentHTML('beforeend', buildAIMessageHTML('assistant',
        'Load your SFMC data first by visiting any category.'));
      sendBtn.disabled = false;
      input.value = question;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
  }

  // Fix 3: Consent banner — shown once per install
  const consentData = await chrome.storage.local.get('sfmc_ai_consent_shown');
  if (!consentData.sfmc_ai_consent_shown) {
    showToast(
      'Your SFMC data (names, counts) is sent to Anthropic to generate this response. No data is stored between sessions.',
      6000
    );
    await chrome.storage.local.set({ sfmc_ai_consent_shown: true });
  }

  // Remove welcome screen on first question
  const welcome = messagesEl.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  // Append user bubble
  aiMessages.push({ role: 'user', content: question });
  messagesEl.insertAdjacentHTML('beforeend', buildAIMessageHTML('user', question));

  // Append thinking indicator
  const thinkingId = 'ai-thinking-' + Date.now();
  messagesEl.insertAdjacentHTML('beforeend', `
    <div id="${thinkingId}" class="ai-message-row assistant">
      <div class="ai-avatar assistant">✨</div>
      <div class="ai-bubble assistant"><div class="ai-thinking-dots"><span></span><span></span><span></span></div></div>
    </div>
  `);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const contextItems = deCategorizedData
      ? deCategorizedData.all
      : (allItems.length > 0 ? allItems : lastCategoryItems);

    // Multi-turn — pass last 10 messages (excluding the one just pushed)
    const history = aiMessages.slice(0, -1).slice(-10);

    // Enrich uiContext with cached metrics so AI has top-level counts without extra fetch
    const cachedMeta = await chrome.storage.local.get('sfmc_metrics_cache');
    const cachedMetrics = cachedMeta.sfmc_metrics_cache?.data ?? null;

    const reply = await sendMsg('ASK_AI', {
      question,
      history,
      uiContext: {
        currentCategory: currentCategory === 'ai' ? null : currentCategory,
        currentItems: contextItems.slice(0, 200),
        totalItemsAvailable: contextItems.length,
        cachedMetrics,
      }
    });

    document.getElementById(thinkingId)?.remove();
    aiMessages.push({ role: 'assistant', content: reply });
    messagesEl.insertAdjacentHTML('beforeend', buildAIMessageHTML('assistant', reply));

  } catch (err) {
    document.getElementById(thinkingId)?.remove();
    const errMsg = resolveAIError(err.message);
    messagesEl.insertAdjacentHTML('beforeend', `
      <div class="ai-message-row assistant">
        <div class="ai-avatar assistant">✨</div>
        <div class="ai-bubble assistant"><span class="ai-error-msg">${errMsg}</span></div>
      </div>
    `);
  } finally {
    sendBtn.disabled = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    input.focus();
  }
}

function resolveAIError(code) {
  if (code === 'AI_NOT_CONFIGURED')  return 'AI API key not configured. Please add your Anthropic API key in Settings.';
  if (code === 'AI_AUTH_FAILED')     return 'Invalid Anthropic API key. Please check Settings.';
  if (code === 'AI_RATE_LIMIT')      return 'Rate limit reached. Please wait a moment and try again.';
  if (code === 'AI_MAX_ITERATIONS')  return 'The question required too many data fetches. Try asking something more specific.';
  if (code === 'AI_EMPTY_RESPONSE')  return 'No response received from the AI. Please try again.';
  if (code?.startsWith('AI_NETWORK')) return 'Network error. Check your connection and try again.';
  return `Error: ${code}`;
}

function renderMarkdown(text) {
  // Escape HTML entities
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks (``` ... ```)
  html = html.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) =>
    `<pre class="ai-code-block"><code>${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  // Headers → bold lines
  html = html.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');

  // Markdown tables — must run before bullet list processing
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const lines = block.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return block;
    const isHeaderSep = (l) => /^\|[-:| ]+\|$/.test(l.trim());
    let thead = '';
    let tbody = '';
    let inHeader = true;
    for (const line of lines) {
      if (isHeaderSep(line)) { inHeader = false; continue; }
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (inHeader) {
        thead = `<tr>${cells.map(c => `<th>${c}</th>`).join('')}</tr>`;
      } else {
        tbody += `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
      }
    }
    return `<table class="ai-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  // Bullet lists: group consecutive lines starting with "- " or "* "
  html = html.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, (block) => {
    const items = block.trim().split('\n').map(l =>
      `<li>${l.replace(/^[ \t]*[-*] /, '').trim()}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Numbered lists
  html = html.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (block) => {
    const items = block.trim().split('\n').map(l =>
      `<li>${l.replace(/^\d+\. /, '').trim()}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // Split into blocks on double newline, wrap non-block elements in <p>
  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(ul|ol|pre|table|h[1-6])/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html || '<p></p>';
}

// Initialization context
window.switchVersion = (id) => selectItem(id);
init();

