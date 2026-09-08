/**
 * Cart Conflict Modal
 *
 * Prevents incompatible products from sharing a cart. Two conflict
 * dimensions are enforced:
 *   1. on-goody vs normal products (`_is_on_goody`)
 *   2. bundle vs non-bundle products (`_item_type: bundle_line_item`)
 * so the cart stays either ALL bundle (discount-eligible) or none.
 * Intercepts /cart/add requests via fetch override, checks for
 * type conflicts, and shows a modal when a conflict is detected.
 */

import { CART_ITEM_TYPES } from '@theme/cart-contract';

const originalFetch = window.fetch.bind(window);

/** @type {string} Line-item property value marking a Bundle Builder item. */
const BUNDLE_ITEM_TYPE = CART_ITEM_TYPES.bundleLineItem;

/**
 * Accessory line types that are neutral in the bundle/non-bundle dimension.
 * Gift wraps and greeting cards are free/companion lines attached to a bundle
 * (or a personalized product) and must NOT be classified as "non-bundle" — else
 * a bundle+wrap cart would trip the conflict modal on the next bundle add.
 * @type {Set<string>}
 */
const BUNDLE_NEUTRAL_TYPES = new Set([
  CART_ITEM_TYPES.giftWrap,
  CART_ITEM_TYPES.greetingCard,
  CART_ITEM_TYPES.giftMessage,
  CART_ITEM_TYPES.digitalCard,
]);

/** @type {string} Last recorded data-on-goody value from a click */
let lastOnGoodyValue = 'false';

/** @type {HTMLDialogElement|null} */
const modalEl = /** @type {HTMLDialogElement|null} */ (document.getElementById('cart-conflict-modal'));

/**
 * Capture-phase click listener to record the data-on-goody attribute
 * from the nearest ATC container before any other handler runs.
 */
document.addEventListener(
  'click',
  (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const onGoodyContainer = target.closest('[data-on-goody]');
    if (onGoodyContainer) {
      lastOnGoodyValue = onGoodyContainer.getAttribute('data-on-goody') || 'false';
    }
  },
  true
);

// ── Modal Controller ──────────────────────────────────────────────

/** @type {function|null} Resolver for the modal promise */
let modalResolver = null;

/**
 * Shows the cart conflict modal and returns a promise that resolves
 * with 'clear' or 'keep' based on user action.
 * @returns {Promise<'clear'|'keep'>}
 */
function showModal() {
  if (!modalEl) return Promise.resolve('keep');

  return new Promise((resolve) => {
    modalResolver = resolve;
    // showModal() puts the dialog in the browser top layer so it stacks above
    // the Personalization / Cart drawers (also modal <dialog>s). Guard against
    // an already-open dialog (showModal throws otherwise).
    if (typeof modalEl.showModal === 'function' && !modalEl.open) {
      modalEl.showModal();
    } else {
      // Defensive fallback for environments without HTMLDialogElement.showModal
      // (very old browsers). This renders the dialog inline — NOT in the top
      // layer — so it will not stack above the drawers and Escape/cancel + inert
      // background parity from showModal() do not apply here.
      modalEl.setAttribute('open', '');
    }
    document.body.style.overflow = 'hidden';

    const clearBtn = /** @type {HTMLElement|null} */ (modalEl.querySelector('[data-cart-conflict-clear]'));
    if (clearBtn) clearBtn.focus();
  });
}

/**
 * Hides the modal and resolves with the given action.
 * @param {'clear'|'keep'} action
 */
function hideModal(action) {
  if (!modalEl) return;
  if (typeof modalEl.close === 'function' && modalEl.open) {
    modalEl.close();
  } else {
    modalEl.removeAttribute('open');
  }
  document.body.style.overflow = '';

  if (modalResolver) {
    modalResolver(action);
    modalResolver = null;
  }
}

// Bind modal button events
if (modalEl) {
  modalEl.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);

    if (target.closest('[data-cart-conflict-clear]')) {
      hideModal('clear');
      return;
    }

    if (target.closest('[data-cart-conflict-keep]') || target.closest('[data-cart-conflict-close]')) {
      hideModal('keep');
      return;
    }
  });

  // Escape on a modal <dialog> fires `cancel` and would auto-close without
  // resolving the promise — intercept it and route through hideModal('keep').
  modalEl.addEventListener('cancel', (event) => {
    event.preventDefault();
    hideModal('keep');
  });
}

// ── Request Body Helpers ──────────────────────────────────────────

/**
 * Injects _is_on_goody property into a JSON request body string.
 * Handles both single-item and items-array formats.
 * @param {string} bodyStr - JSON string body
 * @param {string} onGoodyValue - 'true' or 'false'
 * @returns {string} Modified JSON string
 */
function injectOnGoodyIntoJSON(bodyStr, onGoodyValue) {
  try {
    const body = JSON.parse(bodyStr);

    if (Array.isArray(body.items)) {
      // Items-array format (e.g. personalization drawer)
      for (const item of body.items) {
        if (!item.properties) item.properties = {};
        item.properties._is_on_goody = onGoodyValue;
      }
    } else {
      // Single-item format
      if (!body.properties) body.properties = {};
      body.properties._is_on_goody = onGoodyValue;
    }

    return JSON.stringify(body);
  } catch {
    return bodyStr;
  }
}

/**
 * Injects _is_on_goody into a FormData body.
 * @param {FormData} formData
 * @param {string} onGoodyValue
 * @returns {FormData}
 */
function injectOnGoodyIntoFormData(formData, onGoodyValue) {
  formData.set('properties[_is_on_goody]', onGoodyValue);
  return formData;
}

/**
 * Clones the request body and injects _is_on_goody.
 * Returns a new Request with the modified body.
 * @param {Request} request
 * @param {string} onGoodyValue
 * @returns {Promise<Request>}
 */
async function injectOnGoodyIntoRequest(request, onGoodyValue) {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const text = await request.text();
    const modified = injectOnGoodyIntoJSON(text, onGoodyValue);
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: modified,
      credentials: request.credentials,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
    });
  }

  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    injectOnGoodyIntoFormData(formData, onGoodyValue);
    return new Request(request.url, {
      method: request.method,
      body: formData,
      credentials: request.credentials,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
    });
  }

  // Unknown content type — try to parse body as text (JSON)
  try {
    const text = await request.text();
    const modified = injectOnGoodyIntoJSON(text, onGoodyValue);
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: modified,
      credentials: request.credentials,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
    });
  } catch {
    return request;
  }
}

// ── Cart Conflict Detection ───────────────────────────────────────

/**
 * @typedef {Object} CartFlags
 * @property {boolean} empty
 * @property {boolean} hasOnGoody  - cart contains at least one on-goody item
 * @property {boolean} hasNormal   - cart contains at least one non-on-goody item
 * @property {boolean} hasBundle   - cart contains at least one bundle_line_item
 * @property {boolean} hasNonBundle- cart contains at least one non-bundle item
 */

/** @type {CartFlags} Default flags used when the cart can't be read. */
const EMPTY_FLAGS = { empty: true, hasOnGoody: false, hasNormal: false, hasBundle: false, hasNonBundle: false };

/**
 * Inspects the current cart and flags which item kinds it contains.
 * @returns {Promise<CartFlags>}
 */
async function getCartFlags() {
  try {
    const response = await originalFetch('/cart.js', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    const cart = await response.json();

    if (!cart.items || cart.items.length === 0) return { ...EMPTY_FLAGS };

    let hasOnGoody = false;
    let hasNormal = false;
    let hasBundle = false;
    let hasNonBundle = false;

    for (const item of cart.items) {
      const props = item.properties || {};
      if (String(props._is_on_goody) === 'true') {
        hasOnGoody = true;
      } else {
        hasNormal = true;
      }
      const itemType = String(props._item_type || '');
      if (itemType === BUNDLE_ITEM_TYPE) {
        hasBundle = true;
      } else if (!BUNDLE_NEUTRAL_TYPES.has(itemType)) {
        hasNonBundle = true;
      }
    }

    return { empty: false, hasOnGoody, hasNormal, hasBundle, hasNonBundle };
  } catch {
    // If we can't read the cart, allow the add
    return { ...EMPTY_FLAGS };
  }
}

/**
 * Determines whether the incoming /cart/add request is adding a bundle item
 * by inspecting its request body (single-item or items-array, JSON or form).
 * Peeks via a clone so the forwardable body stays intact.
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<boolean>}
 */
async function detectNewItemBundle(input, init) {
  try {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      // Matches both `properties[_item_type]` (single) and
      // `items[0][properties][_item_type]` (items-array) form formats.
      for (const [key, value] of formData.entries()) {
        if (key.endsWith('properties[_item_type]') && String(value) === BUNDLE_ITEM_TYPE) {
          return true;
        }
      }
      return false;
    }

    const text = await request.text();
    if (!text) return false;
    const body = JSON.parse(text);

    if (Array.isArray(body.items)) {
      return body.items.some(
        (item) => item.properties && String(item.properties._item_type) === BUNDLE_ITEM_TYPE
      );
    }
    return !!(body.properties && String(body.properties._item_type) === BUNDLE_ITEM_TYPE);
  } catch {
    return false;
  }
}

/**
 * Determines whether EVERY item in the incoming /cart/add request is a bundle-neutral
 * companion line (gift message, greeting card, gift wrap, digital card). These ride
 * along with whatever is already in the cart and must be allowed into ANY cart —
 * bundle or not, goody or not — so they never trigger the conflict modal. A mixed
 * batch that also contains a real product line (e.g. the PDP personalization add)
 * returns false and is checked normally.
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<boolean>}
 */
async function detectNewItemNeutral(input, init) {
  try {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      let found = false;
      let allNeutral = true;
      for (const [key, value] of formData.entries()) {
        if (key.endsWith('properties[_item_type]')) {
          found = true;
          if (!BUNDLE_NEUTRAL_TYPES.has(String(value))) allNeutral = false;
        }
      }
      return found && allNeutral;
    }

    const text = await request.text();
    if (!text) return false;
    const body = JSON.parse(text);

    if (Array.isArray(body.items)) {
      if (body.items.length === 0) return false;
      return body.items.every((item) => BUNDLE_NEUTRAL_TYPES.has(String(item.properties?._item_type)));
    }
    return BUNDLE_NEUTRAL_TYPES.has(String(body.properties?._item_type));
  } catch {
    return false;
  }
}

/**
 * Clears the cart and cart attributes.
 * @returns {Promise<void>}
 */
async function clearCartAndAttributes() {
  await originalFetch('/cart/clear.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  await originalFetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes: {} }),
  });
}

// ── Fetch Interceptor ─────────────────────────────────────────────

/**
 * Checks if a URL is a /cart/add endpoint.
 * @param {string|URL|Request} input
 * @returns {boolean}
 */
function isCartAddRequest(input) {
  let url = '';
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (input instanceof Request) {
    url = input.url;
  }
  return url.includes('/cart/add');
}

/**
 * Overridden fetch that intercepts /cart/add POST requests.
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
window.fetch = async function (input, init) {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (method !== 'POST' || !isCartAddRequest(input)) {
    return originalFetch(input, init);
  }

  const isNewItemBundle = await detectNewItemBundle(input, init);
  const isNewItemNeutral = await detectNewItemNeutral(input, init);
  // Bundle products are never on-goody. Force the add (bundle lines + their
  // companion greeting card / gift message / gift wrap) to non-goody so a stale
  // on-goody click can't wrongly stamp them and trip the on-goody conflict.
  const onGoodyValue = isNewItemBundle ? 'false' : lastOnGoodyValue;
  const isNewItemOnGoody = onGoodyValue === 'true';

  // Check current cart state
  const flags = await getCartFlags();

  // Bundle-neutral companion lines (gift message, greeting card, gift wrap, digital
  // card) ride along with any cart — bundle or not, goody or not. Allow them through
  // without a conflict prompt, matching their on-goody flag to the current cart so a
  // stale click value can't mis-stamp them.
  if (isNewItemNeutral) {
    const neutralOnGoody = flags.hasOnGoody && !flags.hasNormal ? 'true' : 'false';
    return forwardWithOnGoody(input, init, neutralOnGoody);
  }

  // No conflict if cart is empty
  if (flags.empty) {
    return forwardWithOnGoody(input, init, onGoodyValue);
  }

  // on-goody vs normal: cart is purely one kind and the new item is the other.
  const onGoodyConflict =
    (flags.hasOnGoody && !flags.hasNormal && !isNewItemOnGoody) ||
    (flags.hasNormal && !flags.hasOnGoody && isNewItemOnGoody);

  // bundle vs non-bundle: keep the cart all-bundle (discount-eligible) or none.
  const bundleConflict =
    (flags.hasBundle && !isNewItemBundle) ||
    (flags.hasNonBundle && isNewItemBundle);

  if (!onGoodyConflict && !bundleConflict) {
    return forwardWithOnGoody(input, init, onGoodyValue);
  }

  // Conflict detected — show modal
  const action = await showModal();

  if (action === 'clear') {
    await clearCartAndAttributes();
    return forwardWithOnGoody(input, init, onGoodyValue);
  }

  // User chose to keep cart — reject the add
  return new Response(
    JSON.stringify({ message: 'Cart conflict: item not added', status: 409 }),
    { status: 409, headers: { 'Content-Type': 'application/json' } }
  );
};

/**
 * Forwards the add-to-cart request with _is_on_goody injected.
 * @param {RequestInfo|URL} input
 * @param {RequestInit} [init]
 * @param {string} onGoodyValue
 * @returns {Promise<Response>}
 */
async function forwardWithOnGoody(input, init, onGoodyValue) {
  // Build a Request object from input+init so we can inspect/modify the body
  let request;

  if (input instanceof Request) {
    // Clone the request so we can read the body
    request = input.clone();
  } else {
    request = new Request(input, init);
  }

  const modifiedRequest = await injectOnGoodyIntoRequest(request, onGoodyValue);
  return originalFetch(modifiedRequest);
}
