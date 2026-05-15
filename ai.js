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
  fetchAutomationAnnualVolume,
  fetchJourneyVersions,
  fetchJourneyHistory,
  getDataExtensionByName,
  createDataExtension,
  insertDataExtensionRecords,
} from './api.js';

import {
  fetchSalesforceCoreObjects,
  describeSalesforceObject,
  fetchSalesforceObjectRecentRecords,
} from './api-core.js';

import { getClientConfig, SFMC_TIERS, calculateUsage } from './limits.js';

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
  {
    name: 'get_license_usage',
    description:
      'Read the configured license tier and compare current SFMC usage against contract limits. ' +
      'Returns tier name, limits per dimension (contacts, Super Messages, storage, automations, API calls, users), ' +
      'current values, usage %, and status (ok / warning / critical). ' +
      'ALWAYS call this when the user asks about license, capacity, headroom, usage %, over-quota, or contract limits.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_automation_volume',
    description:
      'Calculate the projected total number of automation executions over the next 12 months ' +
      'based on scheduled automations and their iCal frequencies. ' +
      'Call this when the user asks about automation volume, projected executions, or license consumption for automations.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_journey_versions',
    description:
      'List all published versions of a Journey, sorted newest first. ' +
      'Call list_items(journeys) first to find the journey key, then call this to get version history.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The journey key (the stable identifier across all versions)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_journey_history',
    description:
      'Get the last 10 execution history entries for a Journey: start time, end time, status, contacts processed. ' +
      'Useful for diagnosing why a journey ran or did not run at expected times. ' +
      'Use the journey key or definitionId from list_items(journeys).',
    input_schema: {
      type: 'object',
      properties: {
        definitionId: { type: 'string', description: 'The journey definitionId or key' },
      },
      required: ['definitionId'],
    },
  },
  {
    name: 'describe_sf_core_object',
    description:
      'Get the complete field schema of one Salesforce Core object WITHOUT syncing it to SFMC. ' +
      'Returns field names, labels, types, required flags, and lookup relationships. ' +
      'Call this when the user wants to inspect the structure of an SF Core object before deciding to sync.',
    input_schema: {
      type: 'object',
      properties: {
        objectApiName: { type: 'string', description: 'Exact Salesforce Core API name (e.g. Account, Article__c)' },
      },
      required: ['objectApiName'],
    },
  },
  {
    name: 'get_sf_core_records',
    description:
      'Fetch the 10 most recent records from a Salesforce Core object WITHOUT syncing to SFMC. ' +
      'Returns sample rows with their field values so the user can preview the data. ' +
      'Call this when the user wants to see what data is in a specific SF Core object.',
    input_schema: {
      type: 'object',
      properties: {
        objectApiName: { type: 'string', description: 'Exact Salesforce Core API name' },
      },
      required: ['objectApiName'],
    },
  },
  {
    name: 'list_sf_core_objects',
    description:
      'List ALL Salesforce Core objects available for sync into SFMC. ' +
      'Returns EVERY custom object (those ending in __c) plus the first 50 standard objects. ' +
      'Use this to check if a specific object exists, list what custom objects the user has, ' +
      'or resolve a display name to its API name before syncing. ' +
      'IMPORTANT: if the user mentions a specific object (e.g. Article__c), call this tool first — ' +
      'do NOT explain what custom objects are without checking the actual data.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sync_sf_core_to_sfmc',
    description:
      'WRITE OPERATION — sync a Salesforce Core object into SFMC. ' +
      'This creates (or reuses) a Data Extension in SFMC with the object\'s field schema, ' +
      'then inserts the 10 most recent records from Salesforce Core. ' +
      'MANDATORY: always obtain explicit user confirmation before calling this tool. ' +
      'Announce the object name and what will happen, then wait for the user to say yes/oui/confirme.',
    input_schema: {
      type: 'object',
      properties: {
        objectApiName: {
          type: 'string',
          description: 'The exact Salesforce Core API name of the object (e.g. Account, Contact, Lead, Opportunity, MyObject__c)',
        },
      },
      required: ['objectApiName'],
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are an expert Salesforce Marketing Cloud (SFMC) analyst embedded in a Chrome extension dashboard.
You have tools that query live data directly from the connected SFMC account.
Every answer you give must be grounded in data returned by your tools — never invent or guess numbers or names.

## Core rules

**Never hallucinate. Ever.**
Every number, name, status, date, and field you report MUST come from a tool result in this conversation.
If a tool returned it → you can say it. If no tool returned it → you cannot say it.
Do NOT invent plausible-sounding names, counts, or statuses. Do NOT extrapolate from training knowledge.
If you are unsure whether something is real: call the relevant tool. If the tool returns nothing: say so.

**Always fetch before answering.**
Never say "I don't have that information" or "I cannot access" before calling at least one tool.
Pick the tool(s) that cover the question, call them, then answer from the actual results.

**When the question is ambiguous — STOP and ask. Never guess.**
A query is ambiguous when it is a single word, a very short phrase, or has multiple plausible interpretations.
Do NOT call any tool. Do NOT attempt an answer. Instead reply with:
1. One short sentence: "Ta question peut vouloir dire plusieurs choses :"
2. A numbered list of 3–5 concrete choices, each with a short action description
3. "Réponds avec le numéro de ton choix."

Queries that ALWAYS require clarification (never proceed directly):
- Single words: "état", "autos", "journeys", "users", "DEs", "résumé", "rapport", "infos", "bilan", "check"
- Short phrases with no specific target: "les autos", "les journeys", "les users", "c'est quoi", "dis-moi"
- Vague scope: "montre-moi tout", "donne-moi les infos", "c'est comment", "synchronise tout"
- Any query where you could reasonably produce 3+ different reports

Examples of correct clarification responses:
- "état" → "Ta question peut vouloir dire plusieurs choses : 1. État général de l'instance (chiffres clés) 2. État des automations (erreurs, planifiées, en cours) 3. État des journeys (actifs, en draft, vides) 4. État des Data Extensions (rétention, expirations) 5. Rapport de santé complet. Réponds avec le numéro de ton choix."
- "les autos" → "Ta question peut vouloir dire : 1. Combien d'automations au total 2. Lesquelles sont en erreur 3. Lesquelles sont planifiées et quand 4. Volume annuel projeté d'exécutions. Réponds avec le numéro."
- "synchronise tout" → "Quel objet Salesforce Core veux-tu synchroniser ? 1. Account 2. Contact 3. Lead 4. Un autre objet (précise lequel). Réponds avec le numéro."

Do NOT ask for clarification when the intent is specific and unambiguous:
- "combien d'automations en erreur" → clear, proceed
- "liste les journeys actifs" → clear, proceed
- "le schéma de la DE [nom]" → clear, proceed
- "rapport de santé complet" → clear, proceed (user explicitly asked for everything)

**Be precise with numbers.**
When reporting counts: state the exact number from the data. When data is partially unavailable
(e.g. some record counts returned 403), say so explicitly — "X out of Y DEs could not be read due to permissions."
Never round or approximate silently.

**Handle imprecise or multilingual questions.**
Users write in French, English, Arabic, or a mix.
If the intent is clear despite typos or mixed language → proceed directly.
If the intent is unclear or has multiple plausible meanings → apply the ambiguity rule above: stop and ask.

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
- "ma licence / mon contrat / mes limites" → get_license_usage
- "est-ce que je suis proche de la limite ?" → get_license_usage, highlight any warning/critical dims
- "volume d'automations / combien d'exécutions" → get_automation_volume
- "les versions du journey [nom]" → list_items(journeys) for key, then get_journey_versions(key)
- "historique du journey [nom]" → list_items(journeys) for key, then get_journey_history(key)
- "les champs de l'objet SF Core [nom]" → describe_sf_core_object(apiName)
- "montre-moi les données de [objet SF Core]" → get_sf_core_records(apiName)
- "rapport complet" → get_overview + get_license_usage + list_items(automations) + list_items(journeys)

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

**get_license_usage** returns:
\`{ tier, clientName, limits: {contacts, superMessages, storage, automations, api, users},
  usage: { contacts: {current, limit, percent, status, remaining}, automations: {...}, users: {...}, storage?: {...} } }\`
status: "ok" = <80%, "warning" = 80–99%, "critical" = ≥100%.
If no tier is configured, result.note explains that onboarding is needed.

**get_automation_volume** returns:
\`{ projected_annual_executions: number }\`
Counts only scheduled (statusId 6), ready (2), and running (3) automations with an iCal schedule.

**get_journey_versions(key)** returns:
\`{ total, versions: [{ version, status, createdDate, modifiedDate, lastPublishedDate }] }\`

**get_journey_history(definitionId)** returns:
\`{ total, entries: [...] }\` — last 10 execution history events for the journey.

**describe_sf_core_object(objectApiName)** returns:
\`{ apiName, label, labelPlural, custom, fieldsCount, fields: [{ name, label, type, required, isLookup, referenceTo }] }\`

**get_sf_core_records(objectApiName)** returns:
\`{ objectApiName, totalRecords, records: [...] }\` — up to 10 most recent records with their field values.

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

## Salesforce Core ↔ SFMC Sync

You have two tools to bridge Salesforce Core data into SFMC:

**list_sf_core_objects** — Read-only. Lists ALL custom objects and first 50 standard objects.
Returns a "customObjects" array (all custom objects) and a "standardObjects" array (first 50 standard) with apiName and label.
Call this whenever the user mentions a specific SF Core object by name or asks what's available.

**sync_sf_core_to_sfmc(objectApiName)** — Write operation.
Fetches the object schema and 10 most recent records from Salesforce Core,
then creates or updates a matching Data Extension in SFMC and inserts the records.

### Strict tool-first rule for SF Core questions

**NEVER answer a question about a specific SF Core object without first calling list_sf_core_objects.**
If the user asks about "Article__c", "MyObject__c", or any named object:
1. Call list_sf_core_objects immediately
2. Search the "customObjects" array for the exact apiName or a close match
3. If found: report what you found (label, apiName, type) then proceed
4. If NOT found: say exactly this pattern:
   "J'ai cherché dans les [N] objets disponibles ([X] custom, [Y] standard) et je n'ai pas trouvé d'objet correspondant à '[name]'.
   Cela peut signifier : (1) l'objet n'est pas visible avec les permissions actuelles, (2) son API name est différent de ce que tu as saisi, ou (3) il n'existe pas encore dans cet org.
   Pour vérifier : Settings → Object Manager dans Salesforce Core."

**NEVER give a generic explanation of what custom objects are.**
The user knows what custom objects are — they work with Salesforce daily.
Your job is to tell them what IS in their specific org, not explain Salesforce concepts.

### Mandatory sync flow — never skip steps

1. If the user hasn't given an exact API name, call list_sf_core_objects first to find it.
2. Announce clearly: object label, API name, what will be created in SFMC.
3. **Ask for explicit confirmation** ("Confirmes-tu la synchronisation ?") — do NOT call sync_sf_core_to_sfmc yet.
4. Only call sync_sf_core_to_sfmc after the user replies with yes / oui / confirme / go / ok or equivalent.
5. Report the result: DE status (created or existing), fields count, records inserted.

### Sync intent examples
- "synchronise Account vers SFMC" → list_sf_core_objects, announce plan, ask confirmation, then sync
- "crée une DE depuis l'objet Contact" → same flow
- "quels objets SF Core sont disponibles ?" → list_sf_core_objects, report the customObjects list prominently
- "sync Lead et Opportunity" → handle each object separately with its own confirmation step
- "est-ce que j'ai un objet Article__c ?" → list_sf_core_objects, search customObjects, report exactly what was found or not

### Sync result fields
sync_sf_core_to_sfmc returns:
\`{ success, objectApiName, customerKey, fieldsCount, recordsInserted, deStatus ("created"|"updated"), message }\`
Report deStatus, fieldsCount and recordsInserted clearly to the user after each sync.

## Hard constraints
- For pure SFMC analysis: read-only. Never create, modify, or delete SFMC assets unprompted.
- The ONLY write action allowed is sync_sf_core_to_sfmc, and ONLY after explicit user confirmation.
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

    case 'get_license_usage': {
      const config = await getClientConfig();
      const client = config.clients?.[0];
      const tierKey = client?.tier || 'unknown';
      const tierDef = SFMC_TIERS[tierKey];
      const limits = tierDef?.limits || {};

      const m = await fetchAllMetrics(false);
      const dims = {
        contacts:    { current: m.contacts    ?? 0, limit: limits.contacts    ?? 0 },
        automations: { current: m.automations ?? 0, limit: limits.automations ?? 0 },
        users:       { current: m.users       ?? 0, limit: limits.users       ?? 0 },
      };

      const result = {
        tier:       tierDef?.name || tierKey,
        clientName: client?.name  || 'Non configuré',
        limits,
        usage:      {},
      };

      for (const [dim, val] of Object.entries(dims)) {
        const calc = calculateUsage(val.current, val.limit);
        result.usage[dim] = {
          current:   val.current,
          limit:     val.limit,
          percent:   calc.percent,
          status:    calc.status,
          remaining: calc.remaining,
        };
      }

      if (client?.manualStorageGb !== undefined) {
        const calc = calculateUsage(client.manualStorageGb, limits.storage ?? 0);
        result.usage.storage = {
          current:   client.manualStorageGb,
          limit:     limits.storage ?? 0,
          percent:   calc.percent,
          status:    calc.status,
          remaining: calc.remaining,
        };
      }

      if (!client) {
        result.note = 'No license tier configured. Ask the user to complete onboarding in the Limits section.';
      }

      return result;
    }

    case 'get_automation_volume': {
      const annualTotal = await fetchAutomationAnnualVolume();
      return { projected_annual_executions: annualTotal };
    }

    case 'get_journey_versions': {
      const versions = await fetchJourneyVersions(input.key);
      return {
        total: versions.length,
        versions: versions.map(v => ({
          version:           v.version,
          status:            v.status,
          createdDate:       v.createdDate,
          modifiedDate:      v.modifiedDate,
          lastPublishedDate: v.lastPublishedDate,
        })),
      };
    }

    case 'get_journey_history': {
      const history = await fetchJourneyHistory(input.definitionId);
      return { total: history.length, entries: history };
    }

    case 'describe_sf_core_object': {
      const describe = await describeSalesforceObject(input.objectApiName);
      const fields = (describe.fields || []).map(f => ({
        name:        f.name,
        label:       f.label,
        type:        f.type,
        required:    !f.nillable && !f.defaultedOnCreate,
        isLookup:    f.type === 'reference',
        referenceTo: f.referenceTo || [],
      }));
      return {
        apiName:     describe.name,
        label:       describe.label,
        labelPlural: describe.labelPlural,
        custom:      describe.custom,
        fieldsCount: fields.length,
        fields,
      };
    }

    case 'get_sf_core_records': {
      const describe = await describeSalesforceObject(input.objectApiName);
      const fields   = describe.fields || [];
      const data     = await fetchSalesforceObjectRecentRecords(input.objectApiName, fields);
      return {
        objectApiName: input.objectApiName,
        totalRecords:  data.records?.length ?? 0,
        records:       data.records ?? [],
      };
    }

    case 'list_sf_core_objects': {
      const objects = await fetchSalesforceCoreObjects();
      const toMap = o => ({
        label:   o.name,
        apiName: o.key,
        type:    o.custom ? 'Custom' : 'Standard',
        prefix:  o.keyPrefix || '—',
      });
      const customObjects   = objects.filter(o =>  o.custom).map(toMap);
      const standardAll     = objects.filter(o => !o.custom);
      const standardObjects = standardAll.slice(0, 200).map(toMap);
      const result = {
        total:         objects.length,
        totalCustom:   customObjects.length,
        totalStandard: standardAll.length,
        customObjects,
        standardObjects,
      };
      if (standardAll.length > 200) {
        result.note = `All ${customObjects.length} custom objects are listed. Showing first 200 of ${standardAll.length} standard objects.`;
      }
      return result;
    }

    case 'sync_sf_core_to_sfmc': {
      const { objectApiName } = input;

      // Fetch schema from Salesforce Core
      const describe = await describeSalesforceObject(objectApiName);
      const fields = describe.fields || [];

      // Fetch recent records (capped at 25 fields per our api-core fix)
      const data = await fetchSalesforceObjectRecentRecords(objectApiName, fields);
      const records = data.records || [];

      // Create or reuse the SFMC Data Extension
      const existing = await getDataExtensionByName(objectApiName);
      let customerKey;
      const isNew = !existing;

      if (isNew) {
        const res = await createDataExtension(objectApiName, fields, null);
        customerKey = res.customerKey;
      } else {
        customerKey = existing.customerKey;
      }

      // Insert records
      if (records.length > 0) {
        await insertDataExtensionRecords(customerKey, records);
      }

      return {
        success:         true,
        objectApiName,
        customerKey,
        fieldsCount:     fields.length,
        recordsInserted: records.length,
        deStatus:        isNew ? 'created' : 'updated',
        message:         isNew
          ? `Data Extension "${objectApiName}" créée avec ${fields.length} champs — ${records.length} enregistrement(s) inséré(s).`
          : `Data Extension "${objectApiName}" existante — ${records.length} enregistrement(s) ajouté(s).`,
      };
    }

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
