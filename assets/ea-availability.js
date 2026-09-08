/**
 * Shared availability data client for the EA storefront.
 *
 * Provides stateless fetch helpers for the Celigo App Proxy (product
 * availability + store location) and a lightweight localStorage-backed
 * store-selection context that any component can read/write.
 *
 * This module is a plain ES module with named exports — no custom element.
 * Caching is intentionally left to the consumer (e.g. pdp-availability.js
 * owns its own per-ZIP / per-date caches as private class fields).
 */

import { AVAILABILITY_API } from '@theme/ea-api-endpoints';

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_CONTEXT_KEY = 'ea_store_context';

/**
 * @typedef {object} StoreContextData
 * @property {string}      zip             - 5-digit ZIP code
 * @property {string}      country         - ISO 3166-1 alpha-2 country code
 * @property {string}      fulfillmentMode - 'delivery' | 'pickup'
 * @property {string|null} date            - ISO date string or null
 * @property {string|null} timeOption      - 'one-hour' | 'same-day' | 'next-day' | 'select-date' | null
 * @property {object|null} store           - Selected store object or null
 * @property {number}      updatedAt       - Unix-ms timestamp of last write
 */

/**
 * @typedef {object} StoreLocationResult
 * @property {string}  storeNumber
 * @property {string}  name
 * @property {string}  address
 * @property {string}  city
 * @property {string}  state
 * @property {string}  zip
 * @property {string}  phone
 * @property {number}  distance
 * @property {boolean} hasCurbside
 * @property {boolean} hasSmoothies
 * @property {boolean} isKosher
 */

// ── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Fetch product availability from the Celigo proxy.
 *
 * @param {object}          params
 * @param {string}          params.zip           - 5-digit ZIP code
 * @param {string}          params.country       - ISO country code (e.g. 'US')
 * @param {string}          params.date          - ISO date string (YYYY-MM-DD)
 * @param {string[]}        params.variantIds    - Shopify numeric variant IDs
 * @param {string}          [params.mode]        - 'delivery' | 'pickup'
 * @param {AbortSignal}     [params.signal]      - AbortController signal
 * @returns {Promise<object>} Raw JSON from the Celigo proxy
 * @throws {Error} On network failure or non-OK response
 */
export async function fetchProductAvailability({
  zip,
  country = 'US',
  date,
  variantIds,
  mode,
  signal,
}) {
  const body = {
    zip,
    country,
    date,
    variantIds,
  };
  if (mode) body.mode = mode;

  const response = await fetch(AVAILABILITY_API.product, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Availability fetch failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch nearby stores from the Celigo proxy.
 *
 * @param {object}          params
 * @param {string}          params.zip       - 5-digit ZIP code
 * @param {string}          [params.country] - ISO country code (default 'US')
 * @param {AbortSignal}     [params.signal]  - AbortController signal
 * @returns {Promise<StoreLocationResult[]>} Array of store objects
 * @throws {Error} On network failure or non-OK response
 */
export async function fetchStores({ zip, country = 'US', signal }) {
  const response = await fetch(AVAILABILITY_API.storeLocation, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zip, country }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Store location fetch failed: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : data.stores || [];
}

// ── Store context (localStorage) ─────────────────────────────────────────────

/**
 * Build a normalised store-context object from partial input.
 * Missing fields are set to safe defaults.
 *
 * @param {Partial<StoreContextData>} partial
 * @returns {StoreContextData}
 */
export function buildStoreState(partial = {}) {
  return {
    zip: partial.zip || '',
    country: partial.country || 'US',
    fulfillmentMode: partial.fulfillmentMode || 'delivery',
    date: partial.date || null,
    timeOption: partial.timeOption || null,
    store: partial.store || null,
    updatedAt: Date.now(),
  };
}

/**
 * Persist the store-selection context to localStorage.
 *
 * @param {StoreContextData} context
 */
export function saveStoreContext(context) {
  try {
    localStorage.setItem(STORE_CONTEXT_KEY, JSON.stringify(context));
  } catch {
    // Storage full or blocked — fail silently
  }
}

/**
 * Read the persisted store-selection context from localStorage.
 *
 * @returns {StoreContextData | null}
 */
export function readStoreContext() {
  try {
    const raw = localStorage.getItem(STORE_CONTEXT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Sync the current store context to Shopify cart attributes via /cart/update.js.
 * This ensures the backend knows the selected store / ZIP / date for
 * order routing and fulfillment.
 *
 * @param {StoreContextData} context
 * @returns {Promise<object>} Cart JSON from /cart/update.js
 */
export async function syncCartAttributes(context) {
  const attributes = {
    'Zip Code': context.zip,
    'Fulfillment Type': context.fulfillmentMode,
  };

  if (context.date) {
    attributes['Event Date'] = context.date;
  }

  if (context.store?.storeNumber) {
    attributes['Store Number'] = context.store.storeNumber;
  }

  const response = await fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes }),
  });

  if (!response.ok) {
    throw new Error(`Cart attribute sync failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Dispatch a bubbling custom event on `document` so any component on the page
 * can react to a store-selection change.
 *
 * @param {StoreContextData} context
 */
export function emitStoreChange(context) {
  document.dispatchEvent(
    new CustomEvent('ea:store:change', {
      bubbles: true,
      detail: context,
    })
  );
}
