// @ts-nocheck
/**
 * Catering Variant Drawer — standalone ES module.
 * Listens for `catering:open-variant-drawer` custom event, opens the global
 * drawer with a variant-selector UI, and dispatches `catering:add-to-cart`
 * when the merchant picks a variant.
 *
 * No @theme/* imports — fully self-contained, loaded via <script type="module">.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Variant card HTML ────────────────────────────────────────────────────────

function buildVariantCardHtml(variant, isSelected, productImages) {
  const selectable = isVariantSelectable(variant);
  const stock = getVariantStock(variant); // total cap (Infinity when untracked)
  const cardClasses = ['catering-variant-card'];
  if (isSelected) cardClasses.push('is-selected');
  if (!selectable) cardClasses.push('is-unavailable');
  const imgSrc = (variant.featured_image && variant.featured_image.src)
    ? variant.featured_image.src
    : (productImages && productImages.length > 0 ? productImages[0] : '');

  const imgHtml = imgSrc
    ? `<img class="catering-variant-card__media" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(variant.title)}" width="64" height="64" loading="lazy">`
    : `<div class="catering-variant-card__media catering-variant-card__media--placeholder"></div>`;

  // "Out of stock" only when there's genuinely no stock (or unavailable).
  // When stock exists but the requested qty can't be met — including when it's
  // all already in the sticky cart — show the total cap ("Only N available").
  let noteHtml = '';
  if (!variant.available || stock <= 0) {
    noteHtml = `<span class="catering-variant-card__note">Out of stock</span>`;
  } else if (!selectable) {
    noteHtml = `<span class="catering-variant-card__note">Only ${stock} available</span>`;
  }

  return `
    <div
      data-cvd-variant="${variant.id}"
      class="${cardClasses.join(' ')}"
      role="button"
      tabindex="${selectable ? '0' : '-1'}"
      aria-selected="${isSelected}"
      aria-disabled="${!selectable}"
    >
      ${imgHtml}
      <div class="catering-variant-card__body">
        <span class="catering-variant-card__name">${escapeHtml(variant.title)}</span>
        <span class="catering-variant-card__price">${formatPrice(variant.price)}</span>
        ${noteHtml}
      </div>
    </div>`;
}

// ── Full drawer content HTML ─────────────────────────────────────────────────

function buildDrawerContentHtml(product, selectedVariantId) {
  const productImages = product.images || [];
  const variantCardsHtml = product.variants
    .map((v) => buildVariantCardHtml(v, v.id === selectedVariantId, productImages))
    .join('');

  // Enabled only when a selectable variant is currently chosen.
  const btnDisabled = !selectedVariantId;

  return `
    <div data-catering-variant-drawer data-cvd-product-id="${product.id}" class="catering-variant-drawer">
      <div class="catering-variant-drawer__body">
        <h3 class="catering-variant-drawer__title">${escapeHtml(product.title)}</h3>
        <div data-cvd-variant-list class="catering-variant-drawer__list">
          ${variantCardsHtml}
        </div>
      </div>
      <div class="catering-variant-drawer__footer">
        <button
          data-cvd-add-to-cart
          type="button"
          class="catering-variant-drawer__add"
          ${btnDisabled ? 'disabled' : ''}
        >Add</button>
      </div>
    </div>`;
}

// ── State ────────────────────────────────────────────────────────────────────

let _currentProduct = null;
let _selectedVariantId = null;
let _originProductId = null;
let _pendingQuantity = 1;
let _inventory = null; // { [variantId]: { tracked, policy, qty } } from the card
let _reserved = null;  // { [variantId]: qty already in the in-memory cart }

// Per-handle product cache so a product's variants are fetched only once per
// page session — subsequent clicks open the drawer immediately.
const _productCache = new Map();

/** Signal that the variant fetch has settled, so the ATC button loader stops. */
function dispatchFetchEnd() {
  document.dispatchEvent(new CustomEvent('catering:variant-fetch-end'));
}

// ── Inventory / selectability ─────────────────────────────────────────────────

/**
 * Total stock a variant can ever fulfil. Untracked inventory or a "continue"
 * (oversell) policy means unlimited; otherwise the tracked stock count.
 */
function getVariantStock(variant) {
  const info = _inventory && _inventory[variant.id];
  if (!info || !info.tracked || info.policy === 'continue') return Infinity;
  return Math.max(0, parseInt(info.qty, 10) || 0);
}

/**
 * Quantity still available to ADD now = total stock minus what's already in the
 * in-memory cart for this variant (two-way binding with the sticky cart).
 */
function getVariantRemaining(variant) {
  const total = getVariantStock(variant);
  if (total === Infinity) return Infinity;
  const reserved = (_reserved && _reserved[variant.id]) || 0;
  return Math.max(0, total - reserved);
}

/** Selectable when available AND enough remaining stock for the requested qty. */
function isVariantSelectable(variant) {
  return Boolean(variant.available) && getVariantRemaining(variant) >= _pendingQuantity;
}

// ── Event handlers ───────────────────────────────────────────────────────────

function handleVariantSelect(variantId) {
  if (!_currentProduct) return;
  const variant = _currentProduct.variants.find((v) => v.id === variantId);
  if (!variant || !isVariantSelectable(variant)) return;

  _selectedVariantId = variantId;

  // Update card borders and name weights
  const wrapper = document.querySelector('[data-catering-variant-drawer]');
  if (!wrapper) return;

  wrapper.querySelectorAll('[data-cvd-variant]').forEach((card) => {
    const id = parseInt(card.dataset.cvdVariant, 10);
    const isSelected = id === variantId;
    // `.is-selected` drives both the border colour and the bold variant name.
    card.classList.toggle('is-selected', isSelected);
    card.setAttribute('aria-selected', String(isSelected));
  });

  // Enable ATC button — appearance is driven by the `:disabled` CSS rule.
  const btn = wrapper.querySelector('[data-cvd-add-to-cart]');
  if (btn) btn.disabled = false;
}

/**
 * Dispatch the in-memory add-to-cart event for a resolved product + variant.
 * Consumed by catering-cart.js, which owns the sticky-bar state.
 */
function dispatchAddToCart(product, variant, quantity) {
  const productImages = product.images || [];
  const image = (variant.featured_image && variant.featured_image.src)
    ? variant.featured_image.src
    : (productImages.length > 0 ? productImages[0] : '');

  document.dispatchEvent(new CustomEvent('catering:add-to-cart', {
    detail: {
      variantId: variant.id,
      productId: product.id,
      title: product.title,
      variantTitle: variant.title,
      price: variant.price,
      image: image,
      quantity: Math.max(1, parseInt(quantity, 10) || 1),
      maxQuantity: getVariantStock(variant),
    },
  }));
}

function resetState() {
  _currentProduct = null;
  _selectedVariantId = null;
  _originProductId = null;
  _pendingQuantity = 1;
  _inventory = null;
  _reserved = null;
}

function handleAddToCart() {
  if (!_currentProduct || !_selectedVariantId) return;

  const variant = _currentProduct.variants.find((v) => v.id === _selectedVariantId);
  if (!variant) return;

  dispatchAddToCart(_currentProduct, variant, _pendingQuantity);

  // Close the global drawer
  if (window.GlobalDrawer && typeof window.GlobalDrawer.closeDrawer === 'function') {
    window.GlobalDrawer.closeDrawer();
  }

  resetState();
}

// ── Delegated click handler ──────────────────────────────────────────────────

function handleDocumentClick(e) {
  const wrapper = e.target.closest('[data-catering-variant-drawer]');
  if (!wrapper) return;

  // Variant card click
  const variantCard = e.target.closest('[data-cvd-variant]');
  if (variantCard) {
    const variantId = parseInt(variantCard.dataset.cvdVariant, 10);
    if (!isNaN(variantId)) handleVariantSelect(variantId);
    return;
  }

  // Add to cart button click
  const atcBtn = e.target.closest('[data-cvd-add-to-cart]');
  if (atcBtn && !atcBtn.disabled) {
    handleAddToCart();
  }
}

// ── Open drawer flow ─────────────────────────────────────────────────────────

async function openVariantDrawer(detail) {
  const { handle, productId, quantity, inventory, reserved } = detail;
  if (!handle) return;

  _originProductId = productId;
  _pendingQuantity = Math.max(1, parseInt(quantity, 10) || 1);
  _inventory = inventory || null;
  _reserved = reserved || null;

  // Use cached product data when available; otherwise fetch once and cache.
  // Fetching before opening lets us skip the drawer for single-variant products.
  let product = _productCache.get(handle);

  if (!product) {
    try {
      const response = await fetch(`/products/${encodeURIComponent(handle)}.js`);
      if (!response.ok) throw new Error(`Product fetch failed: ${response.status}`);
      product = await response.json();
      _productCache.set(handle, product);
    } catch (err) {
      console.error('[catering-variant-drawer] Failed to load product:', err);
      dispatchFetchEnd(); // stop the button loader even on failure
      return;
    }
  }

  // Fetch settled (or cache hit) — clear the trigger button's loader.
  dispatchFetchEnd();

  _currentProduct = product;

  // Single-variant product that can meet the requested quantity: add straight to
  // the sticky cart, no drawer. If it can't (tracked stock < requested qty), fall
  // through to the drawer so the customer sees the same "Only N available"
  // feedback and a disabled Add button — consistent with multi-variant products.
  if (product.variants.length === 1 && isVariantSelectable(product.variants[0])) {
    const variant = product.variants[0];
    _selectedVariantId = variant.id;
    dispatchAddToCart(product, variant, _pendingQuantity);
    resetState();
    return;
  }

  // Multi-variant: open the selector drawer.
  if (!window.GlobalDrawer || typeof window.GlobalDrawer.openDrawer !== 'function') {
    console.warn('[catering-variant-drawer] GlobalDrawer not available');
    return;
  }

  // Drawer title from the first option name (e.g. "Select size").
  let drawerTitle = 'Select variant';
  if (product.options && product.options.length > 0) {
    const firstName = typeof product.options[0] === 'string'
      ? product.options[0]
      : (product.options[0].name || 'variant');
    drawerTitle = `Select ${firstName.toLowerCase()}`;
  }

  // Auto-select the first variant that can meet the requested quantity.
  const firstSelectable = product.variants.find((v) => isVariantSelectable(v));
  _selectedVariantId = firstSelectable ? firstSelectable.id : null;

  window.GlobalDrawer.openDrawer({
    title: drawerTitle,
    content: buildDrawerContentHtml(product, _selectedVariantId),
    drawerStyle: { width: '358px', desktopWidth: '512px' },
    titleStyle: { preset: 'h4', color: '#464646', weight: '600' },
    showBack: true,
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  document.addEventListener('catering:open-variant-drawer', (e) => {
    openVariantDrawer(e.detail || {});
  });

  document.addEventListener('click', handleDocumentClick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
