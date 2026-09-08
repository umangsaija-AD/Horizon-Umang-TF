// @ts-nocheck
// Theme JS runs without a tsconfig; type annotations would require build tooling
// not available in this Shopify context.
/**
 * Catering Cart — standalone ES module.
 * Intercepts ATC clicks on the catering collection page, manages an in-memory
 * cart (resets on page load), and renders a sticky cart bar.
 *
 * Dispatches `catering:cart:updated` on document after every cart change.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_CHECKOUT_CENTS = 10000; // $100.00

// ── In-memory cart state ──────────────────────────────────────────────────────
// NOTE: getCart() returns a live reference to _cart. Callers that mutate the
// returned array MUST call setCart() afterwards to fire the update event.

let _cart = [];

// Cached DOM references — set in init() once the DOM is ready
let _cartBar = null;
let _checkoutBtn = null;

// Latest saved catering event details (from catering-event.js via the
// `catering:event:saved` event). Resets on page load, like the cart. Used to
// gate Add-to-cart on the customer having entered event details first.
let _eventData = null;

function getCart() { return _cart; }

/** Whether catering event details have been captured this session. */
function hasEventDetails() {
  return Boolean(_eventData);
}

function setCart(items) {
  _cart = items;
  document.dispatchEvent(new CustomEvent('catering:cart:updated'));
}

// ── Utilities ─────────────────────────────────────────────────────────────────
// NOTE: escapeHtml is also defined in catering-event.js. Until these modules
// share a common utility file, keep both copies in sync.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatCurrency(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function parsePriceToCents(text) {
  if (!text) return 0;
  const num = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : Math.round(num * 100);
}

function calcSubtotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

// ── Product data extraction ───────────────────────────────────────────────────

/**
 * Extract product data from a product card DOM element.
 * Returns null if the variant ID or parent card cannot be found.
 */
function extractProductData(atcWrapper) {
  const variantInput = atcWrapper.querySelector('input[name="id"]');
  const variantId = variantInput?.value;
  if (!variantId) return null;

  const card = atcWrapper.closest('.product-card');
  if (!card) return null;

  const productId = card.dataset.productId || '';

  // Title — prefer the canonical product link; fall back to any title-like element
  let title = '';
  const titleEl = card.querySelector('.product-card__body a[href*="/products/"]');
  if (titleEl) {
    title = titleEl.textContent.trim();
  } else {
    const anyTitle = card.querySelector('[class*="product-title"], h3, h2, .product-card__body a');
    if (anyTitle) title = anyTitle.textContent.trim();
  }

  let variantTitle = '';
  const variantEl = card.querySelector('[class*="variant"], [class*="option"]');
  if (variantEl) variantTitle = variantEl.textContent.trim();

  // Price — try structured price element; scan card body for a $ value as fallback
  let price = 0;
  const priceEl = card.querySelector('[class*="price"] .money, [class*="price"] [data-price], .price .money');
  if (priceEl) {
    price = parsePriceToCents(priceEl.textContent);
  } else {
    for (const el of card.querySelectorAll('.product-card__body *')) {
      if (el.children.length === 0 && el.textContent.includes('$')) {
        const parsed = parsePriceToCents(el.textContent);
        if (parsed > 0) { price = parsed; break; }
      }
    }
  }

  let image = '';
  const imgEl = card.querySelector('.product-card__media img, .product-card img');
  if (imgEl) image = imgEl.src || imgEl.dataset.src || '';

  return { variantId, productId, title, variantTitle, price, image, quantity: 1 };
}

// ── Checkout button state ───────────────────────────────────────────────────

/**
 * Enable/disable the checkout button. Appearance (red vs. grey) is driven by
 * the `:disabled` rule in catering-cart-bar.liquid.
 */
function setCheckoutBtnEnabled(enabled) {
  const btn = _checkoutBtn || document.querySelector('[data-checkout-btn]');
  if (!btn) return;
  btn.disabled = !enabled;
}

// ── ATC button loading state ──────────────────────────────────────────────────

// Preserves each ATC button's original markup while it shows the spinner.
const _atcButtonContent = new WeakMap();

/**
 * Replace a product card's ATC button label with a spinner while its variant
 * data is fetched. `.catering-atc-spinner` is defined in catering-cart-bar.liquid.
 */
function setAtcButtonLoading(btn) {
  if (!btn || btn.dataset.cateringLoading === 'true') return;
  btn.dataset.cateringLoading = 'true';
  // `.catering-atc-loading` disables pointer events and centres the spinner.
  btn.classList.add('catering-atc-loading');
  _atcButtonContent.set(btn, btn.innerHTML);
  btn.innerHTML = '<span class="catering-atc-spinner" aria-hidden="true"></span>';
}

/**
 * Restore the original label on any ATC button currently loading. Fired on
 * `catering:variant-fetch-end` (success, cache hit, or fetch error).
 */
function clearAtcButtonLoading() {
  document.querySelectorAll('[data-catering-atc] [data-catering-loading="true"]').forEach((btn) => {
    delete btn.dataset.cateringLoading;
    btn.classList.remove('catering-atc-loading');
    if (_atcButtonContent.has(btn)) {
      btn.innerHTML = _atcButtonContent.get(btn);
      _atcButtonContent.delete(btn);
    }
  });
}

// ── ATC click interception ────────────────────────────────────────────────────

/**
 * Capture-phase listener so we intercept before the personalization-drawer
 * and Shopify's native cart handlers, which listen at bubble phase.
 *
 * Dispatches `catering:open-variant-drawer` instead of adding directly,
 * so the user picks a variant before the item enters the in-memory cart.
 */
function handleAtcClick(e) {
  if (!document.querySelector('[data-catering-cart-bar]')) return;

  const atcWrapper = e.target.closest('[data-catering-atc]');
  if (!atcWrapper) return;

  // Quantity stepper controls live inside the wrapper — handle them inline and
  // never open the drawer for these clicks.
  const stepBtn = e.target.closest('[data-catering-qty-step]');
  if (stepBtn) {
    e.stopImmediatePropagation();
    e.preventDefault();
    stepCardQuantity(atcWrapper, stepBtn.dataset.cateringQtyStep);
    return;
  }

  const triggerBtn = e.target.closest('button, a');
  if (!triggerBtn) return;

  e.stopImmediatePropagation();
  e.preventDefault();

  // Gate on event details: if the customer hasn't entered them yet, open the
  // event-details drawer instead of proceeding. Reuses the existing banner
  // trigger ([data-open-catering-drawer]) which catering-event.js already wires.
  if (!hasEventDetails()) {
    const trigger = document.querySelector('[data-open-catering-drawer]');
    if (trigger) {
      trigger.click();
    } else {
      // Fallback: ask catering-event.js to open via custom event.
      document.dispatchEvent(new CustomEvent('catering:open-event-drawer'));
    }
    return;
  }

  const handle = atcWrapper.dataset.productHandle;
  const productId = atcWrapper.dataset.productId || '';

  if (!handle) return;

  const quantity = readCardQuantity(atcWrapper);
  const inventory = readCardInventory(atcWrapper);
  const reserved = buildReservedMap();

  // Show a loader on the button while variant data is fetched. Cleared by the
  // `catering:variant-fetch-end` event (success, cache hit, or fetch error).
  setAtcButtonLoading(triggerBtn);

  document.dispatchEvent(new CustomEvent('catering:open-variant-drawer', {
    detail: { handle, productId, quantity, inventory, reserved },
  }));
}

/** Quantity already in the in-memory cart, keyed by variant id. */
function buildReservedMap() {
  const reserved = {};
  getCart().forEach((item) => {
    reserved[item.variantId] = (reserved[item.variantId] || 0) + item.quantity;
  });
  return reserved;
}

/** Read the per-variant inventory map embedded in a product card (or null). */
function readCardInventory(wrapper) {
  const el = wrapper.querySelector('[data-catering-inventory]');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

// ── Product card quantity stepper ───────────────────────────────────────────

/** Read the chosen quantity from a product card's stepper (defaults to 1). */
function readCardQuantity(wrapper) {
  const input = wrapper.querySelector('[data-catering-qty-count]');
  if (!input) return 1;
  return Math.max(1, parseInt(input.value, 10) || 1);
}

/** Toggle a card's minus button based on its current quantity. */
function syncQtyMinus(wrapper, qty) {
  const minusBtn = wrapper && wrapper.querySelector('[data-catering-qty-step="down"]');
  if (minusBtn) minusBtn.disabled = !(qty > 1);
}

/** Increment/decrement a product card's quantity; minus disables at 1. */
function stepCardQuantity(wrapper, direction) {
  const input = wrapper.querySelector('[data-catering-qty-count]');
  if (!input) return;
  let qty = Math.max(1, parseInt(input.value, 10) || 1);
  qty = direction === 'up' ? qty + 1 : Math.max(1, qty - 1);
  input.value = String(qty);
  syncQtyMinus(wrapper, qty);
}

/** Live-update the minus button as the customer types in the quantity field. */
function handleCardQtyInput(e) {
  const input = e.target.closest('[data-catering-qty-count]');
  if (!input) return;
  syncQtyMinus(input.closest('[data-catering-atc]'), parseInt(input.value, 10));
}

/** Coerce an empty/invalid typed quantity back to a minimum of 1 on commit. */
function handleCardQtyChange(e) {
  const input = e.target.closest('[data-catering-qty-count]');
  if (!input) return;
  let qty = parseInt(input.value, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  input.value = String(qty);
  syncQtyMinus(input.closest('[data-catering-atc]'), qty);
}

/**
 * Handle the `catering:add-to-cart` event dispatched by the variant drawer.
 * Receives the chosen variant data and pushes it into the in-memory cart.
 */
function handleVariantDrawerAdd(e) {
  const { variantId, productId, title, variantTitle, price, image, quantity, maxQuantity } = e.detail || {};
  if (!variantId) return;

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const max = typeof maxQuantity === 'number' ? maxQuantity : Infinity;
  const cart = getCart();

  // Adding is never blocked: re-adding the same variant bumps its quantity by
  // the chosen amount, while a different variant becomes a new line. The total
  // is capped at the variant's stock so the cart can't exceed what's available.
  const existing = cart.find((item) => String(item.variantId) === String(variantId));
  if (existing) {
    existing.quantity = Math.min(existing.quantity + qty, max);
    existing.maxQuantity = max;
  } else {
    // Newest item goes to the front of the list.
    cart.unshift({
      variantId,
      productId,
      title: title || '',
      variantTitle: variantTitle || '',
      price: typeof price === 'number' ? price : 0,
      image: image || '',
      quantity: Math.min(qty, max),
      maxQuantity: max,
    });
  }
  setCart(cart);
}

// ── Cart bar rendering ────────────────────────────────────────────────────────

/**
 * Return the HTML string for a single cart item card matching the Figma
 * sticky-bar design (relative container, 64×64 image, name/variant/price,
 * quantity stepper, absolute-positioned remove button).
 */
function buildCartItemHtml(item, i) {
  const max = typeof item.maxQuantity === 'number' ? item.maxQuantity : Infinity;
  const plusDisabled = item.quantity >= max;

  const imgHtml = item.image
    ? `<img class="catering-cart-item__media" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" width="64" height="64">`
    : '<div class="catering-cart-item__media catering-cart-item__media--placeholder"></div>';

  // Always render the variant line (keeps card height consistent), but hide the
  // text for single-variant products whose title is Shopify's "Default Title".
  const variantLabel = (item.variantTitle || '').trim();
  const showVariant = variantLabel && variantLabel !== 'Default Title';
  const variantHtml = `<span class="catering-cart-item__variant">${showVariant ? escapeHtml(variantLabel) : '&nbsp;'}</span>`;

  return `
    <div class="catering-cart-item">
      ${imgHtml}
      <div class="catering-cart-item__body">
        <div class="catering-cart-item__heading">
          <span class="catering-cart-item__title">${escapeHtml(item.title)}</span>
          ${variantHtml}
        </div>
        <div class="catering-cart-item__row">
          <span class="catering-cart-item__price">${formatCurrency(item.price)}</span>
          <div class="catering-cart-item__stepper">
            <button data-qty-minus="${i}" type="button" class="catering-cart-item__step" aria-label="Decrease quantity">
              <svg width="12" height="2" viewBox="0 0 12 2" fill="none"><line x1="0" y1="1" x2="12" y2="1" stroke="#1D1D1D" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <span class="catering-cart-item__count">${item.quantity}</span>
            <button data-qty-plus="${i}" type="button" class="catering-cart-item__step" ${plusDisabled ? 'disabled' : ''} aria-label="Increase quantity">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="6" y1="0" x2="6" y2="12" stroke="#1D1D1D" stroke-width="1.5" stroke-linecap="round"/><line x1="0" y1="6" x2="12" y2="6" stroke="#1D1D1D" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
      </div>
      <button data-remove-item="${i}" type="button" class="catering-cart-item__remove" aria-label="Remove item">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="#1D1D1D" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="#1D1D1D" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;
}

/**
 * Re-render the sticky cart bar to reflect current in-memory cart state.
 */
function renderCartBar() {
  const bar = _cartBar || document.querySelector('[data-catering-cart-bar]');
  if (!bar) return;

  const cart = getCart();

  if (cart.length === 0) {
    bar.classList.remove('is-visible');
    return;
  }

  bar.classList.add('is-visible');

  const itemsContainer = bar.querySelector('[data-cart-items]');
  if (itemsContainer) {
    itemsContainer.innerHTML = cart.map(buildCartItemHtml).join('');
  }

  const subtotalCents = calcSubtotal(cart);

  const totalEl = bar.querySelector('[data-cart-total]');
  if (totalEl) totalEl.textContent = formatCurrency(subtotalCents);

  const minMsg = bar.querySelector('[data-min-message]');
  const freeMsg = bar.querySelector('[data-free-delivery]');
  const meetsMinimum = subtotalCents >= MIN_CHECKOUT_CENTS;

  // Below the minimum: show the "$100 minimum" note. Once met: swap it for the
  // "Free delivery unlocked!" message.
  if (minMsg) minMsg.classList.toggle('is-hidden', meetsMinimum);
  if (freeMsg) freeMsg.classList.toggle('is-hidden', !meetsMinimum);
  setCheckoutBtnEnabled(meetsMinimum);
}

// ── Cart item mutations ───────────────────────────────────────────────────────

function incrementCartItem(cart, idx) {
  const item = cart[idx];
  if (!item) return;
  const max = typeof item.maxQuantity === 'number' ? item.maxQuantity : Infinity;
  if (item.quantity < max) item.quantity += 1;
}

function decrementCartItem(cart, idx) {
  if (!cart[idx]) return;
  cart[idx].quantity -= 1;
  if (cart[idx].quantity <= 0) cart.splice(idx, 1);
}

function removeCartItem(cart, idx) {
  if (idx >= 0 && cart[idx]) cart.splice(idx, 1);
}

/**
 * Delegated handler for quantity buttons and remove buttons inside the cart bar.
 */
function handleCartBarClick(e) {
  const plusBtn   = e.target.closest('[data-qty-plus]');
  const minusBtn  = e.target.closest('[data-qty-minus]');
  const removeBtn = e.target.closest('[data-remove-item]');
  if (!plusBtn && !minusBtn && !removeBtn) return;

  const cart = getCart();

  if (plusBtn)        incrementCartItem(cart, parseInt(plusBtn.dataset.qtyPlus, 10));
  else if (minusBtn)  decrementCartItem(cart, parseInt(minusBtn.dataset.qtyMinus, 10));
  else if (removeBtn) removeCartItem(cart, parseInt(removeBtn.dataset.removeItem, 10));

  setCart(cart);
}

// ── Checkout ──────────────────────────────────────────────────────────────────

const CART_CREATE_MUTATION = `
  mutation CartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { checkoutUrl totalQuantity attributes { key value } }
      userErrors { field message }
    }
  }`;

/**
 * Format a stored guest count as "N guests" for readability in the admin order.
 */
function formatGuestCount(value) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return value;
  return `${n} ${n === 1 ? 'guest' : 'guests'}`;
}

/**
 * Format an ISO-ish date string (e.g. "2026-07-04") as "July 4, 2026" for the
 * admin order. Falls back to the raw value if it isn't a parseable date.
 */
function formatEventDate(value) {
  if (!value) return value;
  // Parse as local date parts to avoid timezone shifting the day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Build structured cart attributes from the latest catering event details.
 * These surface under "Additional details" on the order in Shopify admin.
 * Empty values are dropped — the Storefront API rejects blank attribute values.
 */
function buildCartAttributes() {
  const ev = _eventData;
  if (!ev) return [];

  const store = ev.store || {};
  const storeLabel = [store.name, [store.city, store.state].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' — ');
  const timeKey = ev.orderType === 'Delivery' ? 'Delivery Time' : 'Pickup Time';
  const instructionKey = ev.orderType === 'Delivery' ? 'Delivery Instructions' : 'Pickup Instructions';

  return [
    { key: 'Event Date', value: formatEventDate(ev.date) },
    { key: 'Guest Count', value: ev.guestCount ? formatGuestCount(ev.guestCount) : '' },
    { key: 'Order Type', value: ev.orderType },
    { key: timeKey, value: ev.time },
    { key: 'Store', value: storeLabel },
    { key: 'Store Phone', value: store.phone },
    { key: 'Zip Code', value: ev.zipCode },
    { key: instructionKey, value: ev.instruction },
    // Curbside details ride along only when the pickup is curbside.
    { key: 'Curbside Pickup', value: ev.curbside ? 'Yes' : '' },
    { key: 'Vehicle Model', value: ev.curbside ? ev.vehicleModel : '' },
    { key: 'Vehicle Color', value: ev.curbside ? ev.vehicleColor : '' },
  ].filter((attr) => attr.value);
}

/** Toggle the checkout button between idle and busy ("Redirecting…") states. */
function setCheckoutBtnBusy(busy) {
  const btn = _checkoutBtn || document.querySelector('[data-checkout-btn]');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Redirecting…' : 'Review & Checkout';
}

/** Show (or, with no message, hide) the inline checkout error text. */
function showCheckoutError(message) {
  const el = document.querySelector('[data-checkout-error]');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-hidden', !message);
}

/**
 * Create a checkout for the in-memory catering cart via the Storefront API and
 * redirect to it. `cartCreate` builds a cart that is completely independent of
 * the online-store (AJAX) cart, so catering items never enter the customer's
 * persistent cart. Event details ride along as structured cart attributes that
 * appear on the order in admin.
 *
 * Storefront API requires variant GIDs (gid://shopify/ProductVariant/123),
 * unlike cart permalinks which take numeric IDs.
 */
async function handleCheckout() {
  const cart = getCart();
  if (cart.length === 0 || calcSubtotal(cart) < MIN_CHECKOUT_CENTS) return;

  const cfg = window.cateringCheckoutConfig || {};
  if (!cfg.token || !cfg.domain) {
    console.error('[catering-cart] Storefront API token/domain not configured');
    showCheckoutError('Checkout is temporarily unavailable. Please try again later.');
    return;
  }

  const lines = cart
    .map((item) => ({
      merchandiseId: `gid://shopify/ProductVariant/${parseInt(item.variantId, 10)}`,
      quantity: item.quantity,
    }))
    .filter((line) => /ProductVariant\/\d+$/.test(line.merchandiseId) && line.quantity > 0);

  if (lines.length === 0) return;

  const expectedQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);

  showCheckoutError('');
  setCheckoutBtnBusy(true);

  try {
    const response = await fetch(`https://${cfg.domain}/api/${cfg.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': cfg.token,
      },
      body: JSON.stringify({
        query: CART_CREATE_MUTATION,
        variables: { input: { lines, attributes: buildCartAttributes() } },
      }),
    });

    const json = await response.json();
    const result = json && json.data && json.data.cartCreate;
    const userErrors = (result && result.userErrors) || [];
    const cart_ = result && result.cart;
    const checkoutUrl = cart_ && cart_.checkoutUrl;

    if (userErrors.length > 0 || !checkoutUrl) {
      throw new Error(userErrors[0] ? userErrors[0].message : 'cartCreate returned no checkout URL');
    }

    // Silent-drop guard: if a variant isn't visible to the token's publication,
    // cartCreate omits that line without an error. Warn so it's caught in
    // testing rather than the customer reaching a short checkout.
    if (typeof cart_.totalQuantity === 'number' && cart_.totalQuantity !== expectedQuantity) {
      console.warn(
        `[catering-cart] checkout quantity mismatch — sent ${expectedQuantity}, ` +
        `cart has ${cart_.totalQuantity}. A product may not be published to the token's catalog.`
      );
    }

    window.location.href = checkoutUrl;
  } catch (err) {
    console.error('[catering-cart] checkout failed:', err);
    setCheckoutBtnBusy(false);
    showCheckoutError('Something went wrong starting checkout. Please try again.');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  _cartBar     = document.querySelector('[data-catering-cart-bar]');
  _checkoutBtn = document.querySelector('[data-checkout-btn]');

  // Capture phase beats personalization-drawer and Shopify's native cart listeners
  document.addEventListener('click', handleAtcClick, { capture: true });
  document.addEventListener('click', handleCartBarClick);

  // Manual quantity typing on product cards
  document.addEventListener('input', handleCardQtyInput);
  document.addEventListener('change', handleCardQtyChange);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-checkout-btn]')) handleCheckout();
  });

  // Listen for variant drawer → add-to-cart events
  document.addEventListener('catering:add-to-cart', handleVariantDrawerAdd);

  // Track saved event details so Add-to-cart can require them first.
  document.addEventListener('catering:event:saved', (e) => { _eventData = e.detail || null; });

  // Clear the ATC button loader once the variant fetch settles.
  document.addEventListener('catering:variant-fetch-end', clearAtcButtonLoading);

  document.addEventListener('catering:cart:updated', renderCartBar);

  // When the page is restored from the back/forward cache (e.g. the customer
  // taps Back from checkout), scripts don't re-run but JS state is preserved —
  // so the checkout button can stay stuck on "Redirecting…". Reset it here.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    setCheckoutBtnBusy(false);
    showCheckoutError('');
    renderCartBar();
  });

  renderCartBar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
