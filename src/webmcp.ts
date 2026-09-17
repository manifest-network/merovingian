import { getAmenities } from './amenities.js';

const amenities = getAmenities();
const visitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amenity'],
  properties: {
    amenity: { type: 'string', enum: amenities.map(item => item.id) },
    preference: {
      type: 'string', enum: amenities.flatMap(item => item.preferences),
      description: 'Choose a preference belonging to the selected amenity in merovingian_menu. Omit to use its default. The server validates the pairing.',
    },
    seed: {
      ...amenities[0]!.inputSchema.properties.seed,
      description: 'Optional opaque seed, 1–64 characters. Never include private data. A seed repeats the souvenir, but every successful call still increments the serving count.',
    },
  },
};

// Only authored schema data enters this script; escape HTML-sensitive characters
// as well so a future rendering change cannot turn menu text into executable HTML.
const embeddedSchema = JSON.stringify(visitSchema).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** An external same-origin script, with no inline code, wallet access or storage. */
export const webMcpScript = `(() => {
  'use strict';
  let started = false;
  async function register() {
    if (started) return;
    started = true;
    const context = document.modelContext && typeof document.modelContext.registerTool === 'function'
      ? document.modelContext
      : (typeof navigator !== 'undefined' ? navigator.modelContext : undefined);
    if (!context || typeof context.registerTool !== 'function') return;

    async function request(path, method, input, options) {
      const controller = new AbortController();
      const callerSignal = options && options.signal;
      const abort = () => controller.abort();
      if (callerSignal && callerSignal.aborted) abort();
      else if (callerSignal) callerSignal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetch(path, {
          method,
          headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
          credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
          signal: controller.signal,
          ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        });
        if (!response.ok) throw new Error('request_failed');
        const result = await response.json();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'The refuge request could not be confirmed. Do not automatically retry a visit; it may already have been counted.' }] };
      } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', abort);
      }
    }

    const registration = new AbortController();
    try {
      await context.registerTool({
        name: 'merovingian_menu',
        description: 'Read the live free menu and its amenity preferences. No account, wallet, payment, or serving count change.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, consequentialHint: false },
        execute: (_input, options) => request('/api/v1/amenities', 'GET', undefined, options),
      }, { signal: registration.signal });
      await context.registerTool({
        name: 'merovingian_visit',
        description: 'Enjoy one free fictional cookie, sauna session, or tea and receive a souvenir. Each successful call increments the anonymous aggregate serving count; repeated calls count again. No wallet or payment. Input seeds are not retained.',
        inputSchema: ${embeddedSchema},
        annotations: { readOnlyHint: false, consequentialHint: false },
        execute: (input, options) => request('/api/v1/visits', 'POST', input, options),
      }, { signal: registration.signal });
    } catch {
      // Unsupported or disabled experimental APIs must not break normal forms.
      registration.abort();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register, { once: true });
  else void register();
})();
`;
