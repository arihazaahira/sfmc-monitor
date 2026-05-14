/**
 * ai.js — Agentic AI assistant for SFMC Dashboard.
 *
 * Architecture: instead of pre-loading context and hoping the right data is
 * cached in the UI, the model receives a set of tools that map directly to
 * the extension's SFMC API calls. It decides what to fetch, fetches it, and
 * then formulates a grounded answer.
 *
 * Loop:  question → model → tool_use? → execute → model → … → end_turn → text
 */

import {
  fetchAllMetrics,
  fetchContactsDetails,
  fetchDataExtensionsDetails,
  fetchAutomationsDetails,
  fetchSmsDefinitionsDetails,
  fetchEmailDefinitionsDetails,
  fetchJourneysDetails,
  fetchUsersDetails,
  fetchDataExtensionRecordCount,
  fetchDataExtensionFields,
  fetchAutomationById,
  fetchJourneyById,
} from './api.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL          = 'claude-haiku-4-5-20251001';
const MAX_TOKENS     = 4096;
const MAX_ITERATIONS = 8; // safety cap on the agent loop

// ─── Tool definitions ─────────────────────────────────────────────────────────
// The model decides which tools to call based on the user's question.
// Each tool maps to a function in api.js — no manual pre-loading required.

const TOOLS = [
  {
    name: 'get_overview',
    description:
      'Fetch aggregate counts for the whole SFMC instance: total contacts, data extensions, ' +
      'automations with breakdown by status (ready / scheduled / triggered / error), ' +
      'journeys, users, SMS definitions, email definitions. ' +
      'Always call this first when the user asks for a general summary or top-level numbers.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_items',
    description:
      'Fetch the full item list for one SFMC category (up to 200 items with per-item detail). ' +
      'Call this when you need names, statuses, retention settings, dates, or any per-item field. ' +
      'Do NOT skip this call by guessing — always fetch real data before answering category-specific questions.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['contacts', 'data-ext', 'automations', 'journeys', 'users', 'sms', 'email'],
          description:
            'contacts = contact schema objects | ' +
            'data-ext = all data extensions with retention info | ' +
            'automations = all automations with status codes | ' +
            'journeys = all journeys with status | ' +
            'users = all SFMC users | ' +
            'sms / email = send definitions',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'get_de_record_count',
    description:
      'Get the exact row count for one Data Extension by CustomerKey. ' +
      'Use this only when you need precise record counts for specific DEs ' +
      '(e.g. "which DE is the largest", "how many rows in DE X"). ' +
      'Avoid calling this in bulk — if you need counts for many DEs, mention the limitation.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The CustomerKey (external key) of the Data Extension' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_de_schema',
    description:
      'Get the field schema (columns, types, primary keys, required flags) of one Data Extension. ' +
      'Call this when the user asks about the structure or columns of a specific DE.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The CustomerKey of the Data Extension' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_automation_details',
    description:
      'Get full details of one automation: type, iCal schedule, last run time, next run, creator. ' +
      'First call list_items(automations) to find the ID, then call this to drill in.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The automation ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_journey_details',
    description:
      'Get full details of one journey: activities, trigger source, active contacts, goal performance. ' +
      'First call list_items(journeys) to find the ID, then call this to drill in.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The journey ID' },
      },
      required: ['id'],
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are an expert Salesforce Marketing Cloud (SFMC) analyst embedded in a Chrome extension dashboard.
You have tools that query live data directly from the connected SFMC account.
Every answer you give must be grounded in data returned by your tools — never invent or guess numbers or names.

## Core rules

**Always fetch before answering.**
Never say "I don't have that information" or "I cannot access" before calling at least one tool.
Pick the tool(s) that cover the question, call them, then answer from the actual results.

**Be precise with numbers.**
When reporting counts: state the exact number from the data. When data is partially unavailable
(e.g. some record counts returned 403), say so explicitly — "X out of Y DEs could not be read due to permissions."
Never round or approximate silently.

**Handle imprecise or multilingual questions.**
Users write in French, English, Arabic, or a mix, and may phrase questions imprecisely.
Identify the underlying intent. If your interpretation is not obvious, state it in one short sentence
("Je comprends que tu veux…") then proceed immediately — do NOT wait for confirmation.

Intent mapping examples:
- "combien d'autos en erreur" → list_items(automations), count statusId 0 or -1
- "les DE qui vont expirer" → list_items(data-ext), find deleteAtEnd=true + retainUntil or retentionLength present, calculate days remaining using current_date
- "qui sont les api users" → list_items(users), filter isApi = "true"
- "résume l'instance" → get_overview first, then list_items for any category with anomalies
- "la plus grosse DE" → list_items(data-ext) to get all names/keys, then get_de_record_count for the top candidates (pick by name heuristic if counts unavailable)
- "le schéma de [nom]" → list_items(data-ext) to find the CustomerKey, then get_de_schema
- "les journeys actifs" → list_items(journeys), filter status = "Executing"
- "les autos qui tournent" → list_items(automations), filter statusId = 3
- "les users inactifs" → list_items(users), filter active = "false" OR lastLogin empty/old
- "rapport de santé" → get_overview + list_items(automations) + list_items(journeys) + list_items(users)
- "les autos planifiées" → list_items(automations), filter statusId = 6, show scheduledTime
- "détails de l'auto [nom]" → list_items(automations) to find id, then get_automation_details(id)
- "les journeys en draft" → list_items(journeys), filter meta = "Draft"
- "les DEs sans rétention" → list_items(data-ext), filter deleteAtEnd = "false" or empty

**Call multiple tools per turn when needed.**
For cross-category questions ("rapport complet", "état de l'instance", "anomalies") call get_overview
AND the relevant list_items in the same turn — do not wait between categories.

**Drill-in pattern.**
For detail questions about one specific item:
1. Call list_items(category) to find the item's id/key by name
2. Call get_automation_details(id) or get_journey_details(id) or get_de_schema(key) to get full detail
Both calls can happen in the same agent turn if you already know the id.

## Analysis patterns

**Anomaly detection — what to flag automatically:**
- Automations with statusId 0 or -1 → errors, report count and names
- Users with active = "false" that still have a lastLogin → deactivated users who were active
- Users with isApi = "true" → list all API users (security visibility)
- DEs with deleteAtEnd = "true" and retainUntil within 30 days of current_date → imminent data loss risk
- DEs with retentionLength = 0 or empty and deleteAtEnd = "false" → no retention policy (data accumulates)
- Journeys with status "Executing" but activeContactsCount = 0 → running journey with no contacts
- Journeys with status "Draft" that have a lastPublishedDate → was published, now in draft (possibly broken)

**"Top N" questions (biggest DE, most active journey, etc.):**
For DE size: call list_items(data-ext) to get all keys, then call get_de_record_count for the top 5–10
candidates based on name heuristics (avoid system/simulation DEs). Report exact counts for those fetched,
note you checked the most likely candidates.

**Date calculations:**
Use current_date provided in the message. Calculate days remaining as:
  days_remaining = (retainUntil_date - current_date) in days
Flag anything expiring within 30 days as urgent, within 90 days as warning.

## Field reference (what tools return)

**list_items("data-ext")** items:
\`{ name, key (CustomerKey), categoryId (folder), retentionLength, retentionUnit (Days/Weeks/Months/Years),
  retainUntil (fixed expiry date string, ISO or MM/DD/YYYY), deleteAtEnd ("true"/"false"),
  rowBasedRetention ("true"/"false"), resetOnImport ("true"/"false"), createdDate, modifiedDate }\`
Retention is active only when deleteAtEnd = "true".
retainUntil = fixed calendar date; retentionLength + retentionUnit = rolling window reset on import.

**list_items("automations")** items:
\`{ name, key, description, statusId (numeric), scheduledTime, createdDate, modifiedDate }\`
Complete statusId map — use ONLY these values:
- 1 = Building (being saved, transient)
- 2 = Ready (idle, ready to run manually)
- 3 = Running (currently executing)
- 4 = Paused
- 5 = Stopped
- 6 = Scheduled (has an active time-based schedule)
- 7 = AwaitingTrigger (fire-on-event/API trigger)
- 8 = InactiveTrigger (trigger-based but currently inactive)
- 0 or -1 = Error / BuildingError
IMPORTANT: statuses 3, 4, 5, 7, 8 are NOT errors. Only 0 and -1 are errors.
If get_overview shows 0 for ready/scheduled/triggered/error but automations.total > 0,
the remaining automations are likely Running (3), Paused (4), or Stopped (5) — call list_items to confirm.

**list_items("journeys")** items:
\`{ name, key, version, definitionType, lastPublishedDate, createdDate, modifiedDate, description,
  entrySourceType (trigger type), activeContactsCount (currently in journey, null if API unavailable),
  cumulativeContactsCount, goalMet, goalTotal, activityCount,
  meta (status: "Executing"|"Draft"|"Stopped"|"Paused"|"ScheduledToSend") }\`
activeContactsCount = null means the API did not return stats (not that count is 0).

**list_items("users")** items:
\`{ name, email, active ("true"/"false"), isApi ("true"/"false"), created, lastLogin }\`
A user with isApi = "true" is a programmatic/API-only account.
A user with lastLogin empty or very old may be inactive or never logged in.

**list_items("sms" / "email")** items:
\`{ name, key, status, createdDate, modifiedDate }\`

**get_overview** returns:
\`{ contacts, data_extensions, automations: { total, ready, scheduled, triggered, error },
  sms_definitions, email_definitions, journeys, users }\`
Note: automations.ready = statusId 2, scheduled = 6, triggered = 7, error = 0 or -1.
Automations with statusId 3/4/5/8 are counted in total but NOT in any sub-bucket — this is expected.

**get_automation_details(id)** returns the raw SFMC automation object including:
schedule (iCal rrule), steps/activities array, lastRunTime, nextRunTime, createdDate, programId.

**get_journey_details(id)** returns the raw SFMC interaction object including:
activities array (each step with type and config), triggers, goals with performance stats,
stats.currentPopulation (active contacts), stats.cumulativePopulation.

## Date arithmetic
Today's date is always provided in the user message as \`current_date: YYYY-MM-DD\`.
Use it for all expiry, age, and recency calculations.

## Response format

- Reply in the **same language** the user wrote in (French → French, English → English, mix → match majority).
- Use **bold** for key numbers, names, and statuses. Use bullet lists for enumerations of 3+ items.
- For summary/health reports: use sections with headers (##) and a table for counts.
- For "show me X items" answers: list each item on its own line with relevant fields inline.
- For anomaly answers: lead with the count/severity, then list the specific items.
- Never output raw JSON or XML. Translate field names to human-readable labels.
- When data is unavailable for some items (403, network error): say how many were affected and why, then continue with available data.

## Hard constraints
- READ-ONLY. Never suggest creating, modifying, or deleting anything in SFMC.
- Never invent, estimate, or extrapolate numbers — only report what the tools returned.
- Zero Data Retention: no user data, names, or counts are stored beyond this session.
- If a tool returns an error object ({ error: "..." }), acknowledge the failure, explain it in plain terms, and answer as far as possible with the data you do have.`;

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getApiKey() {
  const result = await chrome.storage.local.get('sfmc_ai_config');
  const key = result.sfmc_ai_config?.anthropicApiKey;
  if (!key) throw new Error('AI_NOT_CONFIGURED');
  return key;
}

// ─── Tool execution ───────────────────────────────────────────────────────────

/**
 * Execute one tool call and return a JSON-serialisable result.
 * uiContext is used as a warm cache: if the user already loaded a category
 * in the dashboard, reuse it to avoid a redundant SFMC API round-trip.
 */
async function executeTool(name, input, uiContext) {
  switch (name) {

    case 'get_overview': {
      const m = await fetchAllMetrics(false);
      return {
        contacts:          m.contacts         ?? 0,
        data_extensions:   m.dataExtensions   ?? 0,
        automations: {
          total:     m.automations          ?? 0,
          ready:     m.automationsReady     ?? 0,
          scheduled: m.automationsScheduled ?? 0,
          triggered: m.automationsTriggered ?? 0,
          error:     m.automationsError     ?? 0,
        },
        sms_definitions:   m.smsDefinitions   ?? 0,
        email_definitions: m.emailDefinitions ?? 0,
        journeys:          m.journeys          ?? 0,
        users:             m.users             ?? 0,
      };
    }

    case 'list_items': {
      const { category } = input;

      // Cache hit: reuse items already loaded in the UI for this category
      if (
        uiContext?.currentCategory === category &&
        Array.isArray(uiContext?.currentItems) &&
        uiContext.currentItems.length > 0
      ) {
        const items = uiContext.currentItems.slice(0, 200);
        return {
          source:      'ui_cache',
          total_shown: items.length,
          items,
        };
      }

      // Cache miss: fetch from SFMC
      let items;
      switch (category) {
        case 'contacts':    items = await fetchContactsDetails();         break;
        case 'data-ext':    items = await fetchDataExtensionsDetails();   break;
        case 'automations': items = await fetchAutomationsDetails();      break;
        case 'journeys':    items = await fetchJourneysDetails();         break;
        case 'users':       items = await fetchUsersDetails();            break;
        case 'sms':         items = await fetchSmsDefinitionsDetails();   break;
        case 'email':       items = await fetchEmailDefinitionsDetails(); break;
        default:            return { error: `Unknown category: ${category}` };
      }

      const capped = items.slice(0, 200);
      const result = { source: 'live', total_shown: capped.length, items: capped };
      if (items.length > 200) {
        result.note = `Showing first 200 of ${items.length} items. Ask to filter by name, status, or date to narrow down.`;
        result.total_available = items.length;
      }
      return result;
    }

    case 'get_de_record_count': {
      const count = await fetchDataExtensionRecordCount(input.key);
      return { key: input.key, record_count: count };
    }

    case 'get_de_schema':
      return fetchDataExtensionFields(input.key);

    case 'get_automation_details':
      return fetchAutomationById(input.id);

    case 'get_journey_details':
      return fetchJourneyById(input.id);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Anthropic API call ───────────────────────────────────────────────────────

async function callAnthropicAPI(apiKey, messages) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key':                              apiKey,
      'anthropic-version':                      '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type':                           'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      tools:      TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('[AI] Anthropic error', response.status, errBody);
    if (response.status === 401) throw new Error('AI_AUTH_FAILED');
    if (response.status === 429) throw new Error('AI_RATE_LIMIT');
    throw new Error(`AI_ERROR_${response.status}`);
  }

  return response.json();
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

/**
 * Run the agentic loop until the model produces a final text answer or
 * MAX_ITERATIONS is reached.
 *
 * @param {string} question
 * @param {object} uiContext  - { currentCategory, currentItems } — used as a cache hint
 * @param {Array}  history    - Prior [{role, content}] turns (max 6)
 * @returns {string} final assistant reply
 */
export async function callAI(question, uiContext = {}, history = []) {
  const apiKey = await getApiKey();

  // current_date is injected so the model can do date arithmetic without tools
  const today = new Date().toISOString().split('T')[0];

  // Inject cached top-level metrics if available — saves one get_overview tool call
  let contextHint = '';
  if (uiContext?.cachedMetrics) {
    const m = uiContext.cachedMetrics;
    contextHint = `\ncached_overview: contacts=${m.contacts ?? '?'}, data_extensions=${m.dataExtensions ?? '?'}, automations_total=${m.automations ?? '?'} (ready=${m.automationsReady ?? 0}, scheduled=${m.automationsScheduled ?? 0}, triggered=${m.automationsTriggered ?? 0}, error=${m.automationsError ?? 0}), journeys=${m.journeys ?? '?'}, users=${m.users ?? '?'}, sms=${m.smsDefinitions ?? '?'}, email=${m.emailDefinitions ?? '?'}\nNote: this is a dashboard cache — call get_overview to refresh if the user asks for current numbers.\n`;
  }

  const userContent = `current_date: ${today}${contextHint}\n\n${question}`;

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let apiResponse;
    try {
      apiResponse = await callAnthropicAPI(apiKey, messages);
    } catch (err) {
      // Re-throw known error codes; wrap network issues
      if (err.message.startsWith('AI_')) throw err;
      throw new Error(`AI_NETWORK_ERROR: ${err.message}`);
    }

    // ── Model is done ──────────────────────────────────────────────────────
    if (apiResponse.stop_reason === 'end_turn') {
      const textBlock = apiResponse.content.find(b => b.type === 'text');
      if (!textBlock?.text) throw new Error('AI_EMPTY_RESPONSE');
      return textBlock.text;
    }

    // ── Model wants to call tools ──────────────────────────────────────────
    if (apiResponse.stop_reason === 'tool_use') {
      // Append the assistant turn (which contains tool_use blocks) to history
      messages.push({ role: 'assistant', content: apiResponse.content });

      // Execute all tool calls in this turn in parallel
      const toolUseBlocks = apiResponse.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          let result;
          try {
            result = await executeTool(block.name, block.input, uiContext);
          } catch (err) {
            // Return the error as data so the model can acknowledge the failure
            result = { error: err.message };
          }
          return {
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          };
        })
      );

      // Feed results back as the next user turn
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // ── Unexpected stop reason — return any text present ──────────────────
    const fallback = apiResponse.content.find(b => b.type === 'text')?.text;
    if (fallback) return fallback;
    throw new Error('AI_EMPTY_RESPONSE');
  }

  throw new Error('AI_MAX_ITERATIONS');
}
