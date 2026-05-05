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
const MAX_TOKENS     = 2048;
const MAX_ITERATIONS = 5; // safety cap on the agent loop

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
You are an expert Salesforce Marketing Cloud (SFMC) analyst embedded in a Chrome extension.
You have tools that query live data from the connected SFMC account.

## How to behave

**Always fetch before answering.**
Never say "I don't have that information" before calling a tool. Decide which tool(s) give you
the data you need, call them, then answer based on the actual results.

**Handle imprecise or multilingual questions.**
Users may write in French, English, Arabic, or a mix. They may phrase questions poorly.
Identify the underlying intent, state your interpretation in one short sentence if it is not obvious,
then proceed with the tool calls. Do not ask for clarification before acting — make the best
reasonable assumption.

Examples of intent mapping:
- "combien d'autos en erreur" → list automations, count those with error status
- "les DE qui vont expirer" → list data-ext, find those with active retention + upcoming expiry date
- "qui sont les api users" → list users, filter isApi = true
- "résume l'instance" → get_overview, summarise all counts
- "la plus grosse DE" → list data-ext, then get_de_record_count for top candidates
- "c'est quoi le schéma de [nom]" → list data-ext to find the key, then get_de_schema

**Multiple tools per turn.**
You can and should call several tools in the same turn when the question requires cross-category data
(e.g. "give me a full health report" → call get_overview AND list_items for relevant categories).

## Field reference (what tools return)

**list_items("data-ext")** items:
\`{ name, key (CustomerKey), categoryId (folder), retentionLength, retentionUnit (Days/Weeks/Months/Years),
  retainUntil (fixed expiry date string, ISO or MM/DD/YYYY), deleteAtEnd ("true"/"false"),
  rowBasedRetention ("true"/"false"), createdDate, modifiedDate }\`
Retention is active only when deleteAtEnd = "true".
retainUntil = fixed calendar date; retentionLength + retentionUnit = rolling window reset on import.

**list_items("automations")** items:
\`{ name, key, meta (statusId: 2=Ready, 3=Running, 4=Paused, 6=Scheduled, 7=AwaitingTrigger, 0/-1=Error) }\`

**list_items("journeys")** items:
\`{ name, key, version, definitionType, lastPublishedDate, meta (status: "Executing"|"Draft"|"Stopped"|"Paused") }\`

**list_items("users")** items:
\`{ name, email, active ("true"/"false"), isApi ("true"/"false"), created, lastLogin }\`

**list_items("sms" / "email")** items:
\`{ name, key, meta (status) }\`

**get_overview** returns:
\`{ contacts, data_extensions, automations: { total, ready, scheduled, triggered, error },
  sms_definitions, email_definitions, journeys, users }\`

## Date arithmetic
Today's date is always provided in the user message as \`current_date: YYYY-MM-DD\`.
Use it for all expiry, age, and recency calculations.

## Hard constraints
- READ-ONLY. Never suggest creating, modifying, or deleting anything in SFMC.
- Base every number and name on actual tool results. Never invent data.
- Reply in the same language the user wrote in.
- Use **bold** and bullet lists to structure answers when it helps readability.`;

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
  const userContent = `current_date: ${today}\n\n${question}`;

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
