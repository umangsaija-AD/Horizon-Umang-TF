import { CART_ITEM_TYPES, CART_PROPERTY_KEYS } from '@theme/cart-contract';
import { CartUpdateEvent, ThemeEvents } from '@theme/events';

/**
 * Bundle Builder product-card CTA coupling.
 *
 * The Bundle Builder button block (blocks/_bundle-builder-button.liquid) renders a
 * `[data-bb-product-cta][data-product-id]` wrapper when it sits inside a product card
 * (closest.product present). This module makes that CTA mirror the committed cart and
 * drive the bundle flow:
 *   - Add    → window.bundleBuilderAddProduct(productId): opens the BB drawer + the
 *              secondary drawer (variant / gift-wrap) for that product.
 *   - Remove → strips that product's bundle line(s) (+ linked gift-wrap children).
 *
 * A button shows "Remove" when at least one of its product's variants is in the cart
 * with `_item_type: bundle_line_item`. State refreshes on load and on every
 * `cart:update` (fires on add / remove / qty change, and after the cart drawer closes
 * with changes). Standalone bundle buttons (no product, e.g. homepage) are untouched —
 * they keep their `data-bundle-builder-trigger` drawer-open behavior.
 */

const BUNDLE_TYPE = CART_ITEM_TYPES.bundleLineItem;
const ITEM_TYPE_KEY = CART_PROPERTY_KEYS.itemType;
const ADD_TO_CART_ID_KEY = CART_PROPERTY_KEYS.addToCartId;

const REMOVE_LABEL = 'Remove';
const DEFAULT_ADD_LABEL = 'Add';

const WRAPPER_SELECTOR = '[data-bb-product-cta][data-product-id]';
const CTA_SELECTOR = '[data-bb-product-cta] button, [data-bb-product-cta] a';

let syncing = false;

/** @returns {Promise<object|null>} */
async function getCart() {
  try {
    const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Set of product ids present in the cart as bundle line items. */
function bundleProductIds(cart) {
  const ids = new Set();
  if (!cart || !Array.isArray(cart.items)) return ids;
  for (const item of cart.items) {
    const props = item.properties || {};
    if (String(props[ITEM_TYPE_KEY]) === BUNDLE_TYPE) {
      ids.add(String(item.product_id));
    }
  }
  return ids;
}

/** Apply Add/Remove visual + data state to a CTA wrapper. */
function applyState(wrapper, isInCart) {
  const clickable = wrapper.querySelector('button, a');
  if (!clickable) return;
  const addLabel = wrapper.dataset.bbAddLabel || DEFAULT_ADD_LABEL;
  wrapper.dataset.bbState = isInCart ? 'remove' : 'add';
  clickable.textContent = isInCart ? REMOVE_LABEL : addLabel;
  clickable.classList.toggle('bb-cta--remove', isInCart);
  clickable.setAttribute('aria-label', isInCart ? REMOVE_LABEL : addLabel);
}

/** Toggle the loading state on a CTA (CSS spinner replaces the label; clicks ignored). */
function setLoading(clickable, on) {
  if (!clickable) return;
  const wrapper = clickable.closest(WRAPPER_SELECTOR);
  clickable.classList.toggle('bb-cta--loading', on);
  if (on) clickable.setAttribute('aria-busy', 'true');
  else clickable.removeAttribute('aria-busy');
  if (wrapper) wrapper.dataset.bbLoading = on ? 'true' : 'false';
}

/** Refresh every bundle CTA's Add/Remove state from the live cart. */
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const wrappers = document.querySelectorAll(WRAPPER_SELECTOR);
    if (!wrappers.length) return;
    const ids = bundleProductIds(await getCart());
    for (const wrapper of wrappers) {
      applyState(wrapper, ids.has(String(wrapper.dataset.productId)));
    }
  } finally {
    syncing = false;
  }
}

/**
 * Remove a product's bundle line(s) — and their linked gift-wrap children — from the
 * cart. `clickable` shows a loading state for the duration of the request.
 */
async function removeProduct(productId, clickable) {
  const done = () => setLoading(clickable, false);

  try {
    const cart = await getCart();
    if (!cart || !Array.isArray(cart.items)) {
      done();
      return;
    }

    const pid = String(productId);
    const groupIds = new Set();
    const updates = {};

    // Bundle lines for this product.
    for (const item of cart.items) {
      const props = item.properties || {};
      if (String(item.product_id) === pid && String(props[ITEM_TYPE_KEY]) === BUNDLE_TYPE) {
        updates[item.key] = 0;
        const gid = props[ADD_TO_CART_ID_KEY];
        if (gid) groupIds.add(String(gid));
      }
    }

    // Gift-wrap (and any other) children linked to those bundle lines.
    if (groupIds.size) {
      for (const item of cart.items) {
        const props = item.properties || {};
        const gid = props[ADD_TO_CART_ID_KEY];
        if (gid && groupIds.has(String(gid)) && String(props[ITEM_TYPE_KEY]) !== BUNDLE_TYPE) {
          updates[item.key] = 0;
        }
      }
    }

    if (!Object.keys(updates).length) {
      done();
      return;
    }

    const res = await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) {
      done();
      return;
    }
    const updated = await res.json();
    // Clear loading before re-rendering, then refresh header bubble + cart drawer + CTAs.
    done();
    document.dispatchEvent(new CartUpdateEvent(updated, 'bb-product-card-cta'));
    await sync();
  } catch {
    // Leave the committed state untouched; next cart:update reconciles.
    done();
  }
}

/**
 * Capture-phase click handler — runs before the bundle drawer's bubble-phase
 * trigger handler and any default action, so a product-coupled CTA never also
 * fires the plain drawer-open path.
 * @param {MouseEvent} event
 */
function onClick(event) {
  const clickable = event.target.closest(CTA_SELECTOR);
  if (!clickable) return;
  const wrapper = clickable.closest(WRAPPER_SELECTOR);
  if (!wrapper) return;

  event.preventDefault();
  event.stopPropagation();

  // Ignore clicks while a remove request is in flight.
  if (wrapper.dataset.bbLoading === 'true') return;

  const productId = wrapper.dataset.productId;
  if (!productId) return;

  if (wrapper.dataset.bbState === 'remove') {
    setLoading(clickable, true);
    removeProduct(productId, clickable);
  } else if (typeof window.bundleBuilderAddProduct === 'function') {
    window.bundleBuilderAddProduct(productId);
  } else if (typeof window.openBundleBuilderDrawer === 'function') {
    window.openBundleBuilderDrawer();
  }
}

function init() {
  document.addEventListener('click', onClick, true);
  document.addEventListener(ThemeEvents.cartUpdate, () => sync());
  sync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
