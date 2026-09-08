import { DialogComponent } from '@theme/dialog';
import { CartAddEvent, CartUpdateEvent, ThemeEvents } from '@theme/events';
import { sectionRenderer, morphSection, normalizeSectionId } from '@theme/section-renderer';
import { CART_ITEM_TYPES, CART_PROPERTY_KEYS, CYO_ROLES } from '@theme/cart-contract';
import { formatMoney as formatShopifyMoney } from '@theme/money-formatting';
import { buildAddonGroups, collectRefs, fetchAddonProducts, resolveGroups } from '@theme/addons-source';

/**
 * Read a technical cart property.
 * @param {Record<string, string>|null|undefined} properties
 * @param {string} key
 * @returns {string|null}
 */
function readCartProperty(properties, key) {
  return properties?.[key] ?? null;
}

/**
 * @typedef {Object} EaCartDrawerRefs
 * @property {HTMLDialogElement} dialog - The dialog element
 * @property {HTMLElement} mainView - Main cart view container
 * @property {HTMLElement} variantPanel - Change variant subview panel
 * @property {HTMLElement} loadingState - Loading skeleton container
 */

/** @extends {DialogComponent} */
class EaCartDrawer extends DialogComponent {
  /** @type {AbortController|null} */
  #fetchController = null;

  /** @type {string|null} */
  #currentLineKey = null;

  /** @type {string|null} */
  #pendingVariantId = null;

  /** @type {number} */
  #currentQuantity = 1;

  /** @type {boolean} */
  #busy = false;

  /** @type {Record<string, string>} */
  #i18n = {};

  /** @type {number} - Invalidates stale Edit Item async work */
  #editRequestVersion = 0;

  /** @type {Map<string, Object>} - Staged add-on selections: variantId → details */
  #addonsStagedSelections = new Map();

  /** @type {Set<string>} - Variant IDs of existing add-on children for the current parent */
  #addonsCurrentCart = new Set();

  /** @type {string|null} - Line key of the parent for add-on editing */
  #addonsParentLineKey = null;

  /** @type {string|null} - _add_to_cart_id of the parent for add-on editing */
  #addonsParentAddToCartId = null;

  /** @type {Array} - Resolved add-on/upgrade groups from the shared source layer */
  #addonsGroups = [];

  /** @type {number} - Monotonic sequence guard for #hideEmptyUpgradeCtas */
  #hideCtasSeq = 0;

  /** @type {Map<string, Array>} - Cached resolved groups per _add_to_cart_id for CTA hiding */
  #hideCtasCache = new Map();

  /** @type {number|null} - Timer that auto-dismisses the recoverable error banner */
  #errorTimer = null;

  /* ---- Personal message state ---- */

  /** @type {string} - Saved gift message text */
  #giftMessageText = '';

  /** @type {Object|null} - Saved greeting card data from Printible */
  #greetingCardData = null;

  /** @type {string|null} - Variant ID for the complimentary gift-message product */
  #giftMessageVariantId = null;

  /** @type {string|null} - Variant ID for the greeting card product */
  #greetingCardVariantId = null;

  /** @type {string|null} - Selected occasion slug for Printible iframe */
  #greetingCardOccasionId = null;

  /** @type {string|null} - Selected occasion label for gift-message generation */
  #selectedOccasion = null;

  /** @type {string} - Base URL for the Printible iframe */
  #greetingCardBaseUrl = '';

  /** @type {number} - Max characters for the gift message (from PD config) */
  #messageMaxChars = 300;

  /** @type {Object|null} - Cached message config read from the PD config island */
  #messageConfig = null;

  /** @type {Array<{id: number|string, name: string}>|null} - Cached EA occasion API data */
  #occasionsData = null;

  /** @type {Promise<Array<{id: number|string, name: string}>>|null} */
  #occasionsPromise = null;

  /** @type {(event: MessageEvent) => void} */
  #boundHandlePrintibleMessage = (event) => this.#handlePrintibleMessage(event);

  /** @type {WeakSet<Element>} - elements whose listeners are already wired (idempotent across morphs) */
  #wiredEls = new WeakSet();

  /** Close the gift-message and greeting-card occasion dropdowns on any outside click. */
  #boundCloseGmDropdown = () => {
    for (const list of this.querySelectorAll('[data-cd-gm-dropdown-list], [data-cd-gc-dropdown-list]')) {
      list.style.display = 'none';
    }
    for (const trigger of this.querySelectorAll('[data-cd-gm-dropdown-trigger], [data-cd-gc-dropdown-trigger]')) {
      trigger.classList.remove('cd-gm-field__select--open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  };

  /**
   * Toggle the global busy state. While busy, all cart-drawer actions
   * are blocked (via the #busy guard) and visually disabled (via CSS).
   * @param {boolean} busy
   */
  #setBusy(busy) {
    this.#busy = busy;
    this.classList.toggle('cd-drawer--busy', busy);
  }

  /**
   * Show a recoverable error banner inside the drawer. Auto-dismisses after a delay.
   * @param {string} message
   */
  #showError(message) {
    const banner = this.querySelector('.cd-error-toast');
    if (!banner) return;

    banner.textContent = message;
    banner.classList.add('cd-error-toast--visible');

    if (this.#errorTimer) clearTimeout(this.#errorTimer);
    this.#errorTimer = setTimeout(() => {
      banner.classList.remove('cd-error-toast--visible');
      this.#errorTimer = null;
    }, 5000);
  }

  /**
   * Read Cart Drawer translations emitted by Liquid.
   */
  #loadI18n() {
    const i18nEl = this.querySelector('[data-cd-i18n]');
    if (!i18nEl) return;

    try {
      this.#i18n = JSON.parse(i18nEl.textContent || '{}');
    } catch (error) {
      console.warn('Cart drawer: failed to parse translations', error);
      this.#i18n = {};
    }
  }

  /**
   * Get a translated UI label.
   * @param {string} key
   * @returns {string}
   */
  #t(key) {
    return this.#i18n[key] || '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.#loadI18n();
    document.addEventListener(ThemeEvents.cartUpdate, this.#handleCartEvent);
    document.addEventListener('click', this.#handleTriggerClick);
    // Reset edit mode on ANY close (X button, backdrop/outside click, Escape).
    this.addEventListener('dialog:close', this.#handleDialogClose);
    window.addEventListener('message', this.#boundHandlePrintibleMessage);
    document.addEventListener('click', this.#boundCloseGmDropdown);
    this.#initMessageFlow();
    this.#openFromViewCartParam();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(ThemeEvents.cartUpdate, this.#handleCartEvent);
    document.removeEventListener('click', this.#handleTriggerClick);
    this.removeEventListener('dialog:close', this.#handleDialogClose);
    window.removeEventListener('message', this.#boundHandlePrintibleMessage);
    document.removeEventListener('click', this.#boundCloseGmDropdown);
    this.#fetchController?.abort();
    if (this.#errorTimer) clearTimeout(this.#errorTimer);
  }

  /**
   * Resets the drawer back to the main cart view whenever the dialog closes,
   * regardless of how it was closed. Ensures reopening always starts on the
   * main cart view, not the edit variant panel.
   */
  #handleDialogClose = () => {
    this.#resetEditMode();
  };

  /**
   * Clears edit/variant state and returns the drawer to the main cart view.
   */
  #resetEditMode() {
    this.#editRequestVersion += 1;
    this.#showVariantPanel(false);
    this.#showLearnMore(false);
    this.#showAddonsPanel(false);
    this.#showAddonVariantPanel(false);
    this.#showGiftMessagePanel(false);
    this.#showGreetingCardPanel(false);
    this.#currentLineKey = null;
    this.#pendingVariantId = null;
    this.#addonsStagedSelections.clear();
    this.#addonsCurrentCart.clear();
    this.#addonsParentLineKey = null;
    this.#addonsParentAddToCartId = null;
    this.#addonsGroups = [];
    this.#setUpdateEnabled(false);
    this.#clearEditContent();
  }

  /**
   * Opens on cart icon trigger click
   * @param {MouseEvent} event
   */
  #handleTriggerClick = (event) => {
    const trigger = event.target.closest('[data-cart-drawer-trigger]');
    if (!trigger) return;

    event.preventDefault();
    event.stopPropagation();
    this.#openAndRefresh();
  };

  /**
   * Opens after CartAddEvent (including from personalization drawer)
   * @param {Event} event
   */
  #handleCartEvent = (event) => {
    if (event.detail?.data?.didError) return;
    if (event.detail?.sourceId === 'ea-cart-drawer') return;

    if (!(event instanceof CartAddEvent)) {
      if (this.refs.dialog?.open) {
        this.#refreshDrawer();
      }
      return;
    }

    // Don't auto-open if already open
    if (this.refs.dialog?.open) {
      this.#refreshDrawer();
      return;
    }
    this.#openAndRefresh({ cleanup: true });
  };

  /**
   * Opens the drawer and starts refreshing content
   * @param {{ cleanup?: boolean }} [options]
   */
  #openAndRefresh({ cleanup = true } = {}) {
    // Always start on the main cart view, never the edit variant panel.
    this.#resetEditMode();
    this.#showLoading(true);
    this.showDialog();
    this.#refreshDrawer({ cleanup });
  }

  /**
   * Opens the drawer after redirecting visitors away from /cart.
   */
  #openFromViewCartParam() {
    const url = new URL(window.location.href);
    if (url.searchParams.get('viewcart') !== 'true') return;

    url.searchParams.delete('viewcart');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    window.requestAnimationFrame(() => this.#openAndRefresh({ cleanup: true }));
  }

  /**
   * Refreshes drawer content via Section Rendering API
   * @param {{ cleanup?: boolean }} [options]
   */
  async #refreshDrawer({ cleanup = false } = {}) {
    this.#fetchController?.abort();
    this.#fetchController = new AbortController();
    if (cleanup) this.#showLoading(true);

    try {
      if (cleanup) {
        const didCleanCartLines = await this.#cleanupInvalidCartLines().catch((error) => {
          console.warn('Cart drawer: failed to clean up invalid cart lines before render', error);
          return false;
        });
        if (didCleanCartLines) {
          document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
        }
      }
      const sectionId = this.#getSectionId();
      await sectionRenderer.renderSection(sectionId, { cache: false });
      this.#showLoading(false);
      this.#sortBundleLineItems();
      // Re-wire message flow listeners after DOM morph and sync state
      this.#initMessageFlow();
      this.#syncMessagesFromCart();
      // Async: hide CTA buttons for lines that have no resolvable addons/upgrades
      this.#hideEmptyUpgradeCtas();
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.#showLoading(false);
    }
  }

  /**
   * Sort bundle line items in the cart drawer DOM by their `_line_item_order`
   * property. Non-bundle items are left in their original positions.
   * Called after every Section Rendering refresh.
   */
  #sortBundleLineItems() {
    const container = this.querySelector('.cd-items');
    if (!container) return;

    const bundleEls = [...container.querySelectorAll(`[data-item-type="${CART_ITEM_TYPES.bundleLineItem}"]`)];
    if (bundleEls.length < 2) return;

    // Sort by the stamped _line_item_order; fall back to DOM order for missing values
    bundleEls.sort((a, b) => {
      const orderA = parseInt(a.dataset.lineItemOrder || '9999', 10);
      const orderB = parseInt(b.dataset.lineItemOrder || '9999', 10);
      return orderA - orderB;
    });

    // Find the first bundle item's position and re-insert sorted bundle items there
    const firstBundleParent = bundleEls[0].parentNode;
    const anchor = bundleEls[0].nextSibling;
    for (const el of bundleEls) {
      firstBundleParent.insertBefore(el, anchor);
    }
  }

  /**
   * Asynchronously hide "View Gift Upgrades" CTA buttons on lines whose
   * variant has no resolvable addons or upgrades.
   *
   * Runs fire-and-forget after every drawer refresh. Uses a monotonic
   * sequence guard so stale fetches from earlier refreshes never write
   * to the DOM. Per-addToCartId results are cached across refreshes
   * to avoid redundant Storefront API calls.
   */
  async #hideEmptyUpgradeCtas() {
    const seq = ++this.#hideCtasSeq;
    const token = this.dataset.storefrontToken;
    if (!token) return;

    const lines = this.querySelectorAll('.cd-line-item[data-variant-id]');
    if (lines.length === 0) return;

    for (const line of lines) {
      const btn = line.querySelector('.cd-upgrades-btn');
      if (!btn) continue;

      const sourceEl = line.querySelector('[data-cd-addons-source]');
      if (!sourceEl) {
        btn.hidden = true;
        continue;
      }

      const variantId = line.dataset.variantId;
      const cacheKey = `${line.dataset.addToCartId || ''}_${variantId}`;

      // Check cache first
      if (this.#hideCtasCache.has(cacheKey)) {
        const cached = this.#hideCtasCache.get(cacheKey);
        btn.hidden = cached.length === 0;
        continue;
      }

      // Parse source data
      let sourceMap;
      try {
        sourceMap = JSON.parse(sourceEl.textContent);
      } catch (_e) {
        btn.hidden = true;
        continue;
      }

      const source = sourceMap?.[variantId];
      if (!source) {
        btn.hidden = true;
        continue;
      }

      // Run availability filter → shared source layer pipeline
      try {
        const filtered = this.#filterAddonSourceByAvailability(source);
        const groups = buildAddonGroups(filtered.upgrades, filtered.addons);
        if (groups.length === 0) {
          if (seq !== this.#hideCtasSeq) return;
          this.#hideCtasCache.set(cacheKey, []);
          btn.hidden = true;
          continue;
        }

        const refs = collectRefs(groups);
        const products = await fetchAddonProducts(refs, { token });

        // Stale guard: a newer refresh has started, abandon this pass
        if (seq !== this.#hideCtasSeq) return;

        const resolved = resolveGroups(groups, products);
        this.#hideCtasCache.set(cacheKey, resolved);
        btn.hidden = resolved.length === 0;
      } catch (_e) {
        // On failure, leave the button visible (optimistic)
        if (seq !== this.#hideCtasSeq) return;
      }
    }
  }

  /**
   * Gets the Shopify section ID for Section Rendering API
   * @returns {string}
   */
  #getSectionId() {
    const wrapper = this.closest('.shopify-section');
    if (wrapper) {
      return normalizeSectionId(wrapper.id);
    }
    return this.dataset.sectionId || '';
  }

  /**
   * Toggle loading state visibility
   * @param {boolean} show
   */
  #showLoading(show) {
    const loading = this.querySelector('.cd-loading');
    const content = this.querySelector('.cd-body');

    if (loading) loading.style.display = show ? 'flex' : 'none';
    if (content) content.style.display = show ? 'none' : '';
  }

  /**
   * Handle close button click
   */
  handleClose() {
    this.closeDialog();
  }

  /**
   * Handle quantity minus click
   * @param {MouseEvent} event
   */
  async handleQuantityMinus(event) {
    if (this.#busy) return;
    const lineItem = event.target.closest('[data-line-key]');
    if (!lineItem) return;

    const key = lineItem.dataset.lineKey;
    const qtyEl = lineItem.querySelector('[data-qty-value]');
    const currentQty = parseInt(qtyEl?.textContent || '1', 10);
    const newQty = Math.max(0, currentQty - 1);

    await this.#updateQuantity(key, newQty, lineItem);
  }

  /**
   * Handle quantity plus click
   * @param {MouseEvent} event
   */
  async handleQuantityPlus(event) {
    if (this.#busy) return;
    const lineItem = event.target.closest('[data-line-key]');
    if (!lineItem) return;

    const key = lineItem.dataset.lineKey;
    const qtyEl = lineItem.querySelector('[data-qty-value]');
    const currentQty = parseInt(qtyEl?.textContent || '1', 10);

    await this.#updateQuantity(key, currentQty + 1, lineItem);
  }

  /**
   * Handle remove button click — cascades to grouped child items.
   * @param {MouseEvent} event
   */
  async handleRemove(event) {
    if (this.#busy) return;
    const lineItem = event.target.closest('[data-line-key]');
    if (!lineItem) return;

    const key = lineItem.dataset.lineKey;
    const addToCartId = lineItem.dataset.addToCartId;

    this.#setBusy(true);
    lineItem.classList.add('cd-line-item--loading');

    try {
      const updates = { [key]: 0 };

      // Collect all grouped children so we remove everything in one call.
      if (addToCartId) {
        const cartData = await this.#getCartJson();
        const childLines = cartData.items.filter((item) => {
          const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
          return (
            readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId) === addToCartId &&
            itemType !== CART_ITEM_TYPES.parent
          );
        });

        for (const child of childLines) {
          updates[child.key] = 0;
        }
      }

      // CYO group cascade: remove all items sharing the same _cyo_group_key.
      const cyoGroupKey = lineItem.dataset.cyoGroupKey;
      if (cyoGroupKey) {
        const cartData = await this.#getCartJson();
        for (const item of cartData.items) {
          if (readCartProperty(item.properties, CART_PROPERTY_KEYS.cyoGroupKey) === cyoGroupKey) {
            updates[item.key] = 0;
          }
        }
      }

      const response = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });

      if (!response.ok) throw new Error('Failed to remove item');

      // If a bundle line item was removed, cascade-remove orphaned addons
      const isBundleLine = lineItem.dataset.itemType === CART_ITEM_TYPES.bundleLineItem;
      if (isBundleLine) {
        await this.#cascadeRemoveBundleAddons();
      }

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer({ cleanup: true });
      this.#setBusy(false);
    } catch (error) {
      await this.#refreshDrawer().catch(() => {});
      this.#setBusy(false);
      console.error('Remove failed:', error);
      this.#showError(this.#t('removeItemError'));
    }
  }

  /**
   * After removing a bundle line item, check whether any non-addon bundle items
   * remain. If not, cascade-remove all remaining bundle items (addons + their
   * wraps) so the cart doesn't contain orphaned add-ons.
   * Must be called AFTER the removal request has completed.
   */
  async #cascadeRemoveBundleAddons() {
    try {
      const cartData = await this.#getCartJson();
      const bundleItems = cartData.items.filter(
        (item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === CART_ITEM_TYPES.bundleLineItem
      );
      if (bundleItems.length === 0) return;

      const hasBase = bundleItems.some(
        (item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.isBundleAddon) !== 'true'
      );
      if (hasBase) return;

      // No base products remain — remove all bundle addon lines
      const bundleKeys = cartData.items.filter((item) => {
        const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
        return itemType === CART_ITEM_TYPES.bundleLineItem;
      });
      if (bundleKeys.length === 0) return;

      const updates = {};
      for (const line of bundleKeys) {
        updates[line.key] = 0;
      }
      const response = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      // Only signal success if the removal actually applied — otherwise the
      // orphaned bundle add-ons/wraps are still in the cart.
      if (!response.ok) throw new Error('Bundle addon cascade removal failed');
      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
    } catch (error) {
      console.warn('[CartDrawer] Bundle addon cascade removal failed:', error);
    }
  }

  /**
   * Handle removing a gift-wrap child line item
   * @param {MouseEvent} event
   */
  async handleChildRemove(event) {
    if (this.#busy) return;
    const childItem = event.target.closest('[data-line-key]');
    if (!childItem) return;

    const childKey = childItem.dataset.lineKey;

    this.#setBusy(true);
    childItem.classList.add('cd-line-item--loading');

    try {
      const response = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: childKey, quantity: 0 }),
      });

      if (!response.ok) throw new Error('Failed to remove child item');

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
      this.#setBusy(false);
    } catch (error) {
      await this.#refreshDrawer().catch(() => {});
      this.#setBusy(false);
      console.error('Child remove failed:', error);
      this.#showError(this.#t('removeItemError'));
    }
  }

  /**
   * Decrease the quantity of an add-on child line. Operates only on that line.
   * @param {MouseEvent} event
   */
  async handleChildQuantityMinus(event) {
    if (this.#busy) return;
    const childItem = event.target.closest('[data-line-key]');
    if (!childItem) return;

    const qtyEl = childItem.querySelector('[data-qty-value]');
    const currentQty = parseInt(qtyEl?.textContent || '1', 10);
    await this.#updateChildQuantity(childItem.dataset.lineKey, Math.max(0, currentQty - 1), childItem);
  }

  /**
   * Increase the quantity of an add-on child line. Operates only on that line.
   * @param {MouseEvent} event
   */
  async handleChildQuantityPlus(event) {
    if (this.#busy) return;
    const childItem = event.target.closest('[data-line-key]');
    if (!childItem) return;

    const qtyEl = childItem.querySelector('[data-qty-value]');
    const currentQty = parseInt(qtyEl?.textContent || '1', 10);
    await this.#updateChildQuantity(childItem.dataset.lineKey, currentQty + 1, childItem);
  }

  /**
   * Change a single child line's quantity without cascading to its parent group.
   * @param {string} key - Child line item key
   * @param {number} quantity - New quantity (0 removes only this child)
   * @param {HTMLElement} childItem - Child line element
   */
  async #updateChildQuantity(key, quantity, childItem) {
    this.#setBusy(true);
    childItem.classList.add('cd-line-item--loading');
    const buttons = childItem.querySelectorAll('.cd-qty-btn');
    for (const btn of buttons) btn.disabled = true;

    try {
      const response = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: key, quantity }),
      });

      if (!response.ok) throw new Error('Failed to update add-on quantity');

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
      this.#setBusy(false);
    } catch (error) {
      await this.#refreshDrawer().catch(() => {});
      this.#setBusy(false);
      console.error('Add-on quantity update failed:', error);
      this.#showError(this.#t('updateAddonError'));
    }
  }

  /**
   * Handle edit button click - open variant subview, load gift wrap options
   * @param {MouseEvent} event
   */
  async handleEdit(event) {
    if (this.#busy) return;
    const lineItem = event.target.closest('[data-line-key]');
    if (!lineItem) return;

    const editRequestVersion = ++this.#editRequestVersion;
    const key = lineItem.dataset.lineKey;
    const handle = lineItem.dataset.productHandle;
    const currentVariantId = lineItem.dataset.variantId;
    const qtyEl = lineItem.querySelector('[data-qty-value]');
    const productTitle = lineItem.querySelector('.cd-line-item__name')?.textContent?.trim() || '';

    this.#clearEditContent();
    this.#currentLineKey = key;
    this.#currentQuantity = parseInt(qtyEl?.textContent || '1', 10) || 1;
    this.#pendingVariantId = null;
    this.#setUpdateEnabled(false);
    this.#showVariantPanel(true);
    this.#setVariantPanelLoading(true);
    const variantPanel = this.querySelector('.cd-variant-panel');
    const productMediaGradient = getComputedStyle(lineItem)
      .getPropertyValue('--cd-product-media-gradient')
      .trim();
    if (variantPanel) {
      variantPanel.style.setProperty('--cd-product-media-gradient', productMediaGradient);
    }
    const titleEl = this.querySelector('.cd-variant-product-title');
    if (titleEl) titleEl.textContent = productTitle;

    const variantDeliveryData = this.#readVariantDeliveryData(lineItem);

    try {
      const response = await fetch(`/products/${handle}.js`);

      if (!response.ok) {
        throw new Error(`Failed to load product: ${response.status}`);
      }

      const product = await response.json();
      if (editRequestVersion !== this.#editRequestVersion) return;
      const hasVariantChoices = product.variants.length > 1;
      if (hasVariantChoices) {
        this.#renderVariantOptions(product, currentVariantId, variantDeliveryData);
      }

      this.#setUpdateEnabled(false);
      this.#setVariantPanelLoading(false);
      if (!hasVariantChoices) {
        const variantList = this.querySelector('.cd-variant-list');
        if (variantList) variantList.style.display = 'none';
      }
    } catch (error) {
      if (editRequestVersion !== this.#editRequestVersion) return;
      this.#setVariantPanelLoading(false);
      this.#showVariantError();
    }
  }

  /**
   * Handle variant selection in the subview
   * @param {MouseEvent} event
   */
  handleVariantSelect(event) {
    if (this.#busy) return;

    const card = event.target.closest('[data-variant-id]');
    if (!card) return;

    // Update visual selection
    const allCards = this.querySelectorAll('.cd-variant-card');
    for (const c of allCards) {
      c.classList.remove('cd-variant-card--selected');
    }
    card.classList.add('cd-variant-card--selected');

    this.#pendingVariantId = card.dataset.variantId;
    this.#setUpdateEnabled(true);
  }

  /**
   * Apply the selected variant to the current line item.
   * Swaps the variant by removing the old line and adding the new one,
   * preserving properties.
   */
  async handleVariantUpdate() {
    if (this.#busy) return;
    if (!this.#currentLineKey) return;

    const hasVariantChange = this.#pendingVariantId !== null;
    if (!hasVariantChange) return;

    const updateBtn = this.querySelector('.cd-variant-panel__update');
    const body = this.querySelector('.cd-variant-panel__body');
    const quantity = this.#currentQuantity || 1;

    this.#setBusy(true);
    if (body) body.classList.add('cd-variant-panel__body--processing');
    if (updateBtn) {
      updateBtn.disabled = true;
      updateBtn.textContent = this.#t('updating');
    }

    try {
      // Fetch current cart to get existing properties
      const cartData = await this.#getCartJson();
      const currentLine = cartData.items.find(
        (item) => item.key === this.#currentLineKey
      );

      if (!currentLine) throw new Error('Line item not found in cart');

      // Preserve all existing line-item properties.
      const existingProperties = { ...(currentLine.properties || {}) };
      const addToCartId =
        existingProperties[CART_PROPERTY_KEYS.addToCartId] || this.#generateAddToCartId();

      // Determine the variant to use (new one or keep current)
      const newVariantId = this.#pendingVariantId
        ? parseInt(this.#pendingVariantId, 10)
        : currentLine.variant_id;

      // -- Step 1: Remove old parent, add-on children, and upgrade children --
      const updates = { [this.#currentLineKey]: 0 };

      // Remove addon and upgrade children — variant edit invalidates them
      for (const item of cartData.items) {
        const childType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
        if (
          readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId) === addToCartId &&
          (childType === CART_ITEM_TYPES.addOn || childType === CART_ITEM_TYPES.upgrade)
        ) {
          updates[item.key] = 0;
        }
      }

      const removeResponse = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });

      // Partial-failure guard: stop, reconcile from the server cart, surface a recoverable error.
      if (!removeResponse.ok) throw new Error('Failed to remove old items');

      // -- Step 2: Build items to add --
      const itemsToAdd = [];

      // Build parent properties. Preserve the line's original `_item_type` — a
      // `bundle_line_item` must stay a bundle line so it keeps its bundle-discount
      // and progress eligibility (the discount function keys off that type). Only an
      // untyped line is promoted to `parent` so its wrap/add-on children nest + cascade.
      const parentProperties = { ...existingProperties };
      parentProperties[CART_PROPERTY_KEYS.addToCartId] = addToCartId;
      if (!parentProperties[CART_PROPERTY_KEYS.itemType]) {
        parentProperties[CART_PROPERTY_KEYS.itemType] = CART_ITEM_TYPES.parent;
      }

      // Add the parent line
      itemsToAdd.unshift({
        id: newVariantId,
        quantity,
        properties: parentProperties,
      });

      // -- Step 3: Add all items --
      const addResponse = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsToAdd }),
      });

      if (!addResponse.ok) throw new Error('Failed to add updated items');

      this.#showVariantPanel(false);
      this.#currentLineKey = null;
      this.#pendingVariantId = null;

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
      this.#setBusy(false);
    } catch (error) {
      console.error('Variant change failed:', error);
      // Refresh to reflect actual cart state (removes may have succeeded)
      await this.#refreshDrawer().catch(() => {});
      this.#setBusy(false);
      this.#showError(this.#t('updateItemError'));
    }
  }

  /**
   * Enable/disable the variant Update button
   * @param {boolean} enabled
   */
  #setUpdateEnabled(enabled) {
    const updateBtn = this.querySelector('.cd-variant-panel__update');
    if (updateBtn) updateBtn.disabled = !enabled;
  }

  /**
   * Clear rendered Edit Item content so data from the previous line cannot flash.
   */
  #clearEditContent() {
    const title = this.querySelector('.cd-variant-product-title');
    const variantList = this.querySelector('.cd-variant-list');
    const loader = this.querySelector('.cd-variant-loading');
    const error = this.querySelector('.cd-variant-error');
    const body = this.querySelector('.cd-variant-panel__body');
    const updateBtn = this.querySelector('.cd-variant-panel__update');

    if (title) title.textContent = '';
    if (variantList) {
      variantList.innerHTML = '';
      variantList.style.display = '';
    }
    if (loader) loader.style.display = 'none';
    if (error) error.style.display = 'none';
    if (body) body.classList.remove('cd-variant-panel__body--processing');
    if (updateBtn) updateBtn.textContent = this.#t('updateItem');
  }

  /**
   * Handle back button in variant panel
   */
  handleVariantBack() {
    if (this.#busy) return;
    this.#resetEditMode();
  }

  /**
   * Handle variant panel close
   */
  handleVariantClose() {
    if (this.#busy) return;
    this.#resetEditMode();
    this.closeDialog();
  }

  /**
   * Show the Learn More subview panel
   */
  handleLearnMore() {
    if (this.#busy) return;
    this.#showLearnMore(true);
  }

  /**
   * Hide the Learn More subview panel (back to edit)
   */
  handleLearnMoreBack() {
    if (this.#busy) return;
    this.#showLearnMore(false);
  }

  /**
   * Update a parent quantity. Child quantities remain independent.
   * @param {string} key - Line item key
   * @param {number} quantity - New quantity
   * @param {HTMLElement} lineItem - Line item element
   */
  async #updateQuantity(key, quantity, lineItem) {
    // Block every drawer action and fade only the affected line item.
    this.#setBusy(true);
    lineItem.classList.add('cd-line-item--loading');
    const buttons = lineItem.querySelectorAll('.cd-qty-btn');
    for (const btn of buttons) btn.disabled = true;

    try {
      const addToCartId = lineItem.dataset.addToCartId;
      const removesParent = quantity === 0 && Boolean(addToCartId);

      if (removesParent) {
        // Remove parent and all grouped children in one batch call
        const cartData = await this.#getCartJson();
        const updates = { [key]: 0 };
        const childLines = cartData.items.filter((item) => {
          const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
          return (
            readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId) === addToCartId &&
            itemType !== CART_ITEM_TYPES.parent
          );
        });

        for (const child of childLines) {
          updates[child.key] = 0;
        }

        const response = await fetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });

        if (!response.ok) throw new Error('Failed to update cart');
      } else {
        // Simple quantity update
        const response = await fetch('/cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: key,
            quantity,
          }),
        });

        if (!response.ok) throw new Error('Failed to update cart');
      }

      // If a bundle line item was removed (quantity → 0), cascade-remove orphaned addons
      const isBundleLine = quantity === 0 && lineItem.dataset.itemType === CART_ITEM_TYPES.bundleLineItem;
      if (isBundleLine) {
        await this.#cascadeRemoveBundleAddons();
      }

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer({ cleanup: removesParent || isBundleLine });
      this.#setBusy(false);
    } catch (error) {
      await this.#refreshDrawer().catch(() => {});
      this.#setBusy(false);
      console.error('Cart update failed:', error);
      this.#showError(this.#t('updateCartError'));
    }
  }

  /**
   * Show/hide variant panel
   * @param {boolean} show
   */
  #showVariantPanel(show) {
    const panel = this.querySelector('.cd-variant-panel');
    const main = this.querySelector('.cd-main-view');

    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (main) main.setAttribute('aria-hidden', show ? 'true' : 'false');
  }

  /**
   * Show/hide Learn More subview panel
   * @param {boolean} show
   */
  #showLearnMore(show) {
    const panel = this.querySelector('.cd-gift-wrap-learn-more');
    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  /**
   * Set variant panel loading state
   * @param {boolean} loading
   */
  #setVariantPanelLoading(loading) {
    const loader = this.querySelector('.cd-variant-loading');
    const list = this.querySelector('.cd-variant-list');
    const error = this.querySelector('.cd-variant-error');

    if (loader) loader.style.display = loading ? 'flex' : 'none';
    if (list) list.style.display = loading ? 'none' : '';
    if (error) error.style.display = 'none';
  }

  /**
   * Show error in variant panel
   */
  #showVariantError() {
    const loader = this.querySelector('.cd-variant-loading');
    const list = this.querySelector('.cd-variant-list');
    const error = this.querySelector('.cd-variant-error');

    if (loader) loader.style.display = 'none';
    if (list) list.style.display = 'none';
    if (error) error.style.display = 'flex';
  }

  /**
   * Render variant options in the subview
   * @param {Object} product - Product JSON from /products/{handle}.js
   * @param {string} currentVariantId - Currently selected variant ID
   * @param {Map<string, Object|null>} variantDeliveryData - Delivery availability by variant ID
   */
  #renderVariantOptions(product, currentVariantId, variantDeliveryData = new Map()) {
    const list = this.querySelector('.cd-variant-list');
    if (!list) return;

    const titleEl = this.querySelector('.cd-variant-product-title');
    if (titleEl) titleEl.textContent = product.title;

    let html = '';
    for (const variant of product.variants) {
      if (!variant.available) continue;

      const isSelected = String(variant.id) === String(currentVariantId);
      const selectedClass = isSelected ? 'cd-variant-card--selected' : '';
      const priceHtml = this.#renderInlinePrice(variant.price, variant.compare_at_price, 'cd-variant-card');
      const deliveryHtml = this.#renderVariantDeliveryAvailability(
        variantDeliveryData.get(String(variant.id))
      );
      const variantTitle = this.#escapeHtml(variant.title);
      const imageUrl = variant.featured_image?.src
        ? this.#resizeImage(variant.featured_image.src, '128x128')
        : (product.featured_image ? this.#resizeImage(product.featured_image, '128x128') : '');
      const escapedImageUrl = this.#escapeHtml(imageUrl);

      html += `
        <button
          type="button"
          class="cd-variant-card ${selectedClass}"
          data-variant-id="${variant.id}"
          on:click="/handleVariantSelect"
        >
          <div class="cd-variant-card__image">
            <div class="cd-variant-card__image-bg"></div>
            ${escapedImageUrl ? `<img src="${escapedImageUrl}" alt="${variantTitle}" width="64" height="64" loading="lazy">` : ''}
          </div>
          <div class="cd-variant-card__info">
            <span class="cd-variant-card__title">${variantTitle}</span>
            ${priceHtml}
            ${deliveryHtml}
          </div>
        </button>
      `;
    }

    list.innerHTML = html;
  }

  /**
   * Read per-variant delivery availability data from the line item's Liquid JSON carrier.
   * @param {Element} lineItem
   * @returns {Map<string, Object|null>}
   */
  #readVariantDeliveryData(lineItem) {
    const dataEl = lineItem.querySelector('[data-cd-variant-delivery-data]');
    const deliveryData = new Map();
    if (!dataEl) return deliveryData;

    try {
      const variants = JSON.parse(dataEl.textContent || '[]');
      for (const variant of variants) {
        if (!variant?.id) continue;
        deliveryData.set(String(variant.id), variant.deliveryAvailability || null);
      }
    } catch (error) {
      console.warn('Cart drawer: failed to parse variant delivery data', error);
    }

    return deliveryData;
  }

  /**
   * Render the delivery availability badge used by edit-item variant cards.
   * @param {Object|null|undefined} deliveryAvailability
   * @returns {string}
   */
  #renderVariantDeliveryAvailability(deliveryAvailability) {
    const name = deliveryAvailability?.name ? this.#escapeHtml(deliveryAvailability.name) : '';
    if (!name) return '';

    const icon = deliveryAvailability?.icon ? this.#escapeHtml(deliveryAvailability.icon) : '';
    const iconHtml = icon
      ? `<span class="cd-variant-card__delivery-icon" style="--cd-variant-delivery-icon: url('${icon}');" aria-hidden="true"></span>`
      : '';

    return `
      <span class="cd-variant-card__delivery">
        ${iconHtml}
        <span class="cd-variant-card__delivery-name">${name}</span>
      </span>
    `;
  }

  /**
   * Generate a unique identifier for one parent and its grouped children.
   * @returns {string}
   */
  #generateAddToCartId() {
    return crypto.randomUUID();
  }

  /**
   * Fetch the current cart state from Shopify
   * @returns {Promise<Object>}
   */
  async #getCartJson() {
    const response = await fetch('/cart.js', {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) throw new Error('Failed to fetch cart');
    return response.json();
  }

  /**
   * Remove all child items that belong to a parent group.
   * @param {Object} cartData - Cart JSON from /cart.js
   * @param {string} addToCartId - Shared `_add_to_cart_id`
   */
  async #removeGroupedChildren(cartData, addToCartId) {
    const childLines = cartData.items.filter((item) => {
      const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
      return (
        readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId) === addToCartId &&
        itemType !== CART_ITEM_TYPES.parent
      );
    });

    if (childLines.length === 0) return;

    const updates = {};
    for (const child of childLines) {
      updates[child.key] = 0;
    }

    const response = await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });

    if (!response.ok) throw new Error('Failed to remove grouped children');
  }

  // ================================================================
  //  Add-ons subview
  // ================================================================

  /**
   * Open the add-ons panel for a parent line item.
   * Reads the embedded source JSON, feeds it through the shared source layer,
   * and renders grouped add-ons/upgrades.
   * @param {MouseEvent} event
   */
  async handleViewAddons(event) {
    if (this.#busy) return;
    const lineItem = event.target.closest('[data-line-key]');
    if (!lineItem) return;

    const key = lineItem.dataset.lineKey;
    let addToCartId = lineItem.dataset.addToCartId;

    // Verify the line has source data before proceeding
    const sourceEl = lineItem.querySelector('[data-cd-addons-source]');
    if (!sourceEl) return;

    let sourceMap;
    try {
      sourceMap = JSON.parse(sourceEl.textContent);
    } catch (_e) {
      return;
    }

    if (!sourceMap || Object.keys(sourceMap).length === 0) return;

    // Generate and persist _add_to_cart_id if the parent doesn't have one, then
    // continue seamlessly into the add-ons view after the refresh (no second click).
    if (!addToCartId) {
      addToCartId = this.#generateAddToCartId();
      this.#setBusy(true);

      try {
        const cartData = await this.#getCartJson();
        const parentLine = cartData.items.find((item) => item.key === key);

        if (!parentLine) {
          this.#setBusy(false);
          return;
        }

        const updatedProps = { ...(parentLine.properties || {}) };
        updatedProps[CART_PROPERTY_KEYS.addToCartId] = addToCartId;
        // Preserve an existing type (e.g. bundle_line_item keeps its discount
        // eligibility); only promote an untyped line to `parent`.
        if (!updatedProps[CART_PROPERTY_KEYS.itemType]) {
          updatedProps[CART_PROPERTY_KEYS.itemType] = CART_ITEM_TYPES.parent;
        }

        const response = await fetch('/cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: key,
            quantity: parentLine.quantity,
            properties: updatedProps,
          }),
        });

        if (!response.ok) throw new Error('Failed to assign group ID to parent');

        // Refresh to get the updated DOM (properties change the line key).
        document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
        await this.#refreshDrawer();
        this.#setBusy(false);

        // Re-find the parent in the morphed DOM by its persisted group id and
        // continue straight into the add-ons view.
        const refreshedLine = this.querySelector(
          `.cd-line-item[data-add-to-cart-id="${addToCartId}"]`
        );

        if (refreshedLine) {
          await this.#openAddonsForLine(refreshedLine, addToCartId);
        }
        return;
      } catch (error) {
        console.error('Failed to generate add_to_cart_id for parent:', error);
        await this.#refreshDrawer().catch(() => {});
        this.#setBusy(false);
        this.#showError(this.#t('genericRefreshError'));
        return;
      }
    }

    await this.#openAddonsForLine(lineItem, addToCartId);
  }

  /**
   * Pre-filter raw addon/upgrade source data by availability.
   * Strips entries with missing or malformed GIDs before the data enters
   * the shared source layer pipeline (buildAddonGroups → fetchAddonProducts → resolveGroups).
   * The Storefront API fetch inside fetchAddonProducts handles product-level
   * `availableForSale` filtering, but this step removes obviously invalid refs
   * up front so the pipeline receives clean input.
   * @param {{ upgrades?: Array, addons?: Array }} source - Raw variant source data
   * @returns {{ upgrades: Array, addons: Array }} Filtered source data
   */
  #filterAddonSourceByAvailability(source) {
    const filterValidRefs = (entries, gidKey) => {
      if (!Array.isArray(entries)) return [];
      return entries.filter((entry) => {
        const gid = entry?.[gidKey]?.id;
        return typeof gid === 'string' && gid.startsWith('gid://shopify/Product/');
      });
    };

    const upgrades = filterValidRefs(source.upgrades, 'shopify_upgrade');
    const addons = Array.isArray(source.addons)
      ? source.addons
          .map((group) => ({
            ...group,
            products: filterValidRefs(group?.products, 'shopify_addon'),
          }))
          .filter((group) => group.products.length > 0)
      : [];

    return { upgrades, addons };
  }

  /**
   * Open and populate the add-ons panel for a parent line element.
   * Reads the embedded source JSON, filters by availability via
   * #filterAddonSourceByAvailability, runs it through the shared source layer
   * (buildAddonGroups → fetchAddonProducts → resolveGroups), and renders
   * grouped tabs + cards.
   * @param {HTMLElement} lineItem - The parent `.cd-line-item` element
   * @param {string} addToCartId - The parent's persisted `_add_to_cart_id`
   */
  async #openAddonsForLine(lineItem, addToCartId) {
    const sourceEl = lineItem.querySelector('[data-cd-addons-source]');
    if (!sourceEl) return;

    let sourceMap;
    try {
      sourceMap = JSON.parse(sourceEl.textContent);
    } catch (_e) {
      return;
    }

    if (!sourceMap || Object.keys(sourceMap).length === 0) return;

    // Resolve the current variant's source data.
    // The sourceMap is keyed by variant ID; the line item's variant ID is on the element.
    const variantId = lineItem.dataset.variantId;
    const source = sourceMap[variantId];
    if (!source) return;

    // Pre-filter source data by availability before entering the pipeline
    const filtered = this.#filterAddonSourceByAvailability(source);
    const rawUpgrades = filtered.upgrades;
    const rawAddons = filtered.addons;

    this.#addonsParentLineKey = lineItem.dataset.lineKey;
    this.#addonsParentAddToCartId = addToCartId;
    this.#addonsStagedSelections.clear();
    this.#addonsCurrentCart.clear();

    this.#showAddonsPanel(true);
    this.#setAddonsLoading(true);

    try {
      const token = this.dataset.storefrontToken;

      // Shared source layer pipeline
      const groups = buildAddonGroups(rawUpgrades, rawAddons);
      const refs = collectRefs(groups);
      const products = await fetchAddonProducts(refs, { token });
      const resolved = resolveGroups(groups, products);

      this.#addonsGroups = resolved;

      if (resolved.length === 0) {
        this.#setAddonsLoading(false);
        this.#renderAddonEmptyState();
        return;
      }

      // Load cart state and pre-select existing addon/upgrade children
      const cartData = await this.#getCartJson();

      for (const item of cartData.items) {
        const itemAddToCartId = readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId);
        const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);

        if (itemAddToCartId !== addToCartId) continue;
        if (itemType !== CART_ITEM_TYPES.addOn && itemType !== CART_ITEM_TYPES.upgrade) continue;

        const vid = String(item.variant_id);
        this.#addonsCurrentCart.add(vid);
        this.#addonsStagedSelections.set(vid, {
          variantId: vid,
          productId: String(item.product_id),
          title: item.title,
          price: item.final_price,
          lineKey: item.key,
          groupType: itemType === CART_ITEM_TYPES.upgrade ? 'upgrade' : 'addon',
        });
      }

      this.#renderAddonTabs();
      this.#renderAddonProducts(0);
      this.#setAddonsLoading(false);
      this.#updateAddonsButtonState();
    } catch (error) {
      this.#setAddonsLoading(false);
      console.error('Failed to load add-ons:', error);
      this.#showError(this.#t('loadGiftUpgradesError'));
    }
  }

  /**
   * Render an empty state message when no addon/upgrade groups resolve.
   */
  #renderAddonEmptyState() {
    const list = this.querySelector('.cd-addons-list');
    if (!list) return;

    const msg = this.#t('noGiftUpgrades') || 'No gift upgrades available';
    list.innerHTML = `<p class="cd-addons-empty">${this.#escapeHtml(msg)}</p>`;
  }

  /**
   * Render tabs for addon groups. Hides tab bar when only one group.
   */
  #renderAddonTabs() {
    const tabBar = this.querySelector('.cd-addons-tabs');
    if (!tabBar) return;

    if (this.#addonsGroups.length <= 1) {
      tabBar.style.display = 'none';
      return;
    }

    tabBar.style.display = '';
    let html = '';

    for (let i = 0; i < this.#addonsGroups.length; i++) {
      const group = this.#addonsGroups[i];
      const label = group.type === 'upgrade'
        ? (this.#t('upgradesTab') || 'Upgrades')
        : (group.name || this.#t('addonsOther') || 'Add-ons');
      const isActive = i === 0;

      html += `
        <button type="button"
          class="cd-addons-tab${isActive ? ' cd-addons-tab--active' : ''}"
          data-addon-tab-index="${i}"
          on:click="/handleAddonTab"
        >${this.#escapeHtml(label)}</button>
      `;
    }

    tabBar.innerHTML = html;
  }

  /**
   * Handle tab selection in the addon panel. Toggles active tab and re-renders
   * the product list for the selected group. Updates the clicked button in place.
   * @param {MouseEvent} event
   */
  handleAddonTab(event) {
    event.stopPropagation();
    if (this.#busy) return;

    const tab = event.target.closest('[data-addon-tab-index]');
    if (!tab) return;

    const index = parseInt(tab.dataset.addonTabIndex, 10);
    if (isNaN(index) || index < 0 || index >= this.#addonsGroups.length) return;

    // Toggle active class on sibling tabs in place
    const allTabs = this.querySelectorAll('.cd-addons-tab');
    for (const t of allTabs) {
      t.classList.toggle('cd-addons-tab--active', t === tab);
    }

    this.#renderAddonProducts(index);
  }

  /**
   * Render the product list for a specific addon group index.
   * @param {number} groupIndex - Index into this.#addonsGroups
   */
  #renderAddonProducts(groupIndex = 0) {
    const list = this.querySelector('.cd-addons-list');
    if (!list) return;

    if (this.#addonsGroups.length === 0) {
      this.#renderAddonEmptyState();
      return;
    }

    const group = this.#addonsGroups[groupIndex];
    if (!group) return;

    const singleSelectHint = group.single
      ? `<p class="cd-addons-hint">${this.#escapeHtml(this.#t('addonsSelectOne') || 'Select one')}</p>`
      : '';

    let html = singleSelectHint;

    for (const product of group.products) {
      html += this.#renderAddonCard(product, group);
    }

    list.innerHTML = html;
    list.dataset.addonGroupIndex = groupIndex;
  }

  /**
   * Render a single addon card.
   * @param {Object} product - Hydrated product from resolveGroups
   * @param {Object} group - The group the product belongs to
   * @returns {string} HTML string
   */
  #renderAddonCard(product, group) {
    const variants = product.variants || [];
    const hasMultipleVariants = variants.length > 1;
    const firstVariant = variants[0];
    const firstVid = firstVariant ? String(firstVariant.id) : '';
    const isAdded = this.#addonsStagedSelections.has(firstVid);

    let anyVariantAdded = false;
    if (hasMultipleVariants) {
      for (const v of variants) {
        if (this.#addonsStagedSelections.has(String(v.id))) {
          anyVariantAdded = true;
          break;
        }
      }
    }

    const priceHtml = firstVariant
      ? this.#renderInlinePrice(firstVariant.price, null, 'cd-addon-card')
      : '';
    const imageUrl = product.featuredImage?.url || '';
    const titleEscaped = this.#escapeHtml(this.#truncateText(product.title || '', 50));
    const productId = product.id;

    // Description with inline read more/less
    let descriptionHtml = '';
    if (product.description) {
      const fullText = this.#stripHtml(product.description).trim();
      if (fullText.length > 55) {
        const truncated = this.#truncateText(fullText, 55);
        descriptionHtml = `
          <span class="cd-addon-card__desc" data-addon-desc-product-id="${this.#escapeHtml(productId)}">
            <span data-addon-desc-short>${this.#escapeHtml(truncated)}</span>
            <span data-addon-desc-full style="display:none;">${this.#escapeHtml(fullText)}</span>
            <button type="button" class="cd-addon-card__read-more" data-addon-read-more on:click="/handleAddonReadMore">${this.#t('readMore') || 'Read more'}</button>
          </span>`;
      } else {
        descriptionHtml = `<span class="cd-addon-card__desc">${this.#escapeHtml(fullText)}</span>`;
      }
    }

    const groupType = group.type;

    if (hasMultipleVariants) {
      const btnClass = anyVariantAdded
        ? 'cd-addon-card__btn cd-addon-card__btn--added'
        : 'cd-addon-card__btn';
      const btnText = anyVariantAdded ? this.#t('added') : this.#t('selectOptions');

      return `
        <div class="cd-addon-card" data-addon-product-id="${this.#escapeHtml(productId)}" data-addon-group-type="${groupType}">
          <div class="cd-addon-card__image">
            <div class="cd-addon-card__image-bg"></div>
            ${imageUrl ? `<img src="${this.#escapeHtml(imageUrl)}" alt="${titleEscaped}" width="64" height="64" loading="lazy">` : ''}
          </div>
          <div class="cd-addon-card__info">
            <span class="cd-addon-card__title">${titleEscaped}</span>
            ${descriptionHtml}
            <div class="cd-addon-card__meta">
              ${priceHtml}
              <button type="button" class="${btnClass}" data-addon-product-id="${this.#escapeHtml(productId)}" data-addon-multi="true" data-addon-group-type="${groupType}" on:click="/handleAddonAction">
                ${btnText}
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const btnClass = isAdded
      ? 'cd-addon-card__btn cd-addon-card__btn--added'
      : 'cd-addon-card__btn';
    const btnText = isAdded ? this.#t('added') : this.#t('add');

    return `
      <div class="cd-addon-card" data-addon-product-id="${this.#escapeHtml(productId)}" data-addon-variant-id="${firstVid}" data-addon-group-type="${groupType}">
        <div class="cd-addon-card__image">
          <div class="cd-addon-card__image-bg"></div>
          ${imageUrl ? `<img src="${this.#escapeHtml(imageUrl)}" alt="${titleEscaped}" width="64" height="64" loading="lazy">` : ''}
        </div>
        <div class="cd-addon-card__info">
          <span class="cd-addon-card__title">${titleEscaped}</span>
          ${descriptionHtml}
          <div class="cd-addon-card__meta">
            ${priceHtml}
            <button type="button" class="${btnClass}" data-addon-variant-id="${firstVid}" data-addon-product-id="${this.#escapeHtml(productId)}" data-addon-group-type="${groupType}" on:click="/handleAddonAction">
              ${btnText}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Toggle inline Read more / Read less on an addon card description.
   * @param {MouseEvent} event
   */
  handleAddonReadMore(event) {
    const btn = event.target.closest('[data-addon-read-more]');
    if (!btn) return;

    const wrapper = btn.closest('[data-addon-desc-product-id]');
    if (!wrapper) return;

    const shortEl = wrapper.querySelector('[data-addon-desc-short]');
    const fullEl = wrapper.querySelector('[data-addon-desc-full]');
    if (!shortEl || !fullEl) return;

    const isExpanded = fullEl.style.display !== 'none';

    if (isExpanded) {
      shortEl.style.display = '';
      fullEl.style.display = 'none';
      btn.textContent = this.#t('readMore') || 'Read more';
    } else {
      shortEl.style.display = 'none';
      fullEl.style.display = '';
      btn.textContent = this.#t('readLess') || 'Read less';
    }
  }

  /**
   * Handle add/remove/select-options for an add-on product.
   * @param {MouseEvent} event
   */
  handleAddonAction(event) {
    if (this.#busy) return;

    const btn = event.target.closest('[data-addon-product-id]');
    if (!btn) return;

    const productId = btn.dataset.addonProductId;
    const groupType = btn.dataset.addonGroupType || 'addon';
    const group = this.#addonsGroups.find((g) => g.products.some((p) => p.id === productId));
    const product = group?.products.find((p) => p.id === productId);
    if (!product || !product.variants) return;

    const isMulti = product.variants.length > 1;

    // The currently staged variant for this product (if any).
    let stagedVid = null;
    for (const v of product.variants) {
      if (this.#addonsStagedSelections.has(String(v.id))) {
        stagedVid = String(v.id);
        break;
      }
    }

    if (isMulti) {
      if (stagedVid) {
        // "Added" → remove the staged variant and revert to "Select Options".
        this.#addonsStagedSelections.delete(stagedVid);
        this.#applyAddonButtonState(btn, product);
        this.#refreshVisibleAddonButtons(product);
        this.#updateAddonsButtonState();
      } else {
        // "Select Options" → open the variant selector (button stays in the DOM).
        this.#openAddonVariantPanel(productId);
      }
      return;
    }

    // Single/default-variant toggle.
    const variant = product.variants[0];
    if (!variant) return;
    const variantId = String(variant.id);

    if (this.#addonsStagedSelections.has(variantId)) {
      this.#addonsStagedSelections.delete(variantId);
    } else {
      this.#stageAddon(variantId, {
        variantId,
        productId: product.id,
        title: product.title,
        price: variant.price,
        lineKey: null,
        groupType,
      }, group);
    }

    this.#applyAddonButtonState(btn, product);
    this.#refreshVisibleAddonButtons(product);
    this.#updateAddonsButtonState();
  }

  /**
   * Stage a single addon/upgrade selection. When the group is single-select,
   * removes any other staged variant in the same group before adding.
   * @param {string} variantId
   * @param {Object} details
   * @param {Object} group
   */
  #stageAddon(variantId, details, group) {
    if (group && group.single) {
      // Remove any other variant staged in this group
      const groupProductIds = new Set(group.products.map((p) => p.id));
      for (const [vid, staged] of this.#addonsStagedSelections) {
        if (vid !== variantId && groupProductIds.has(staged.productId)) {
          this.#addonsStagedSelections.delete(vid);
        }
      }
    }
    this.#addonsStagedSelections.set(variantId, details);
  }

  /**
   * Refresh all visible addon buttons for a given product without
   * re-rendering the full list. Mutates existing buttons in place.
   * @param {Object} product
   */
  #refreshVisibleAddonButtons(product) {
    const cards = this.querySelectorAll(`.cd-addon-card[data-addon-product-id="${CSS.escape(product.id)}"]`);
    for (const card of cards) {
      const btn = card.querySelector('.cd-addon-card__btn');
      if (btn) this.#applyAddonButtonState(btn, product);
    }
  }

  /**
   * Update an add-on card's action button text and styling in place to reflect
   * the current staged state. Avoids a full list re-render that would detach the
   * clicked element during click handling.
   * @param {HTMLButtonElement} btn - The card's action button
   * @param {Object} product - The add-on product data
   */
  #applyAddonButtonState(btn, product) {
    const isMulti = product.variants && product.variants.length > 1;
    let staged = false;

    if (product.variants) {
      for (const v of product.variants) {
        if (this.#addonsStagedSelections.has(String(v.id))) {
          staged = true;
          break;
        }
      }
    }

    btn.classList.toggle('cd-addon-card__btn--added', staged);
    if (staged) {
      btn.textContent = this.#t('added');
    } else {
      btn.textContent = isMulti ? this.#t('selectOptions') : this.#t('add');
    }
  }

  /**
   * Open the variant sub-panel for a multi-variant add-on product.
   * @param {string} productId
   */
  #openAddonVariantPanel(productId) {
    let product = null;
    let parentGroup = null;
    for (const group of this.#addonsGroups) {
      const found = group.products.find((p) => p.id === productId);
      if (found) {
        product = found;
        parentGroup = group;
        break;
      }
    }
    if (!product || !product.variants) return;

    const titleEl = this.querySelector('.cd-addon-variant-panel__product-title');
    if (titleEl) titleEl.textContent = product.title || '';

    const list = this.querySelector('.cd-addon-variant-list');
    if (!list) return;

    let currentSelectedVid = null;

    for (const v of product.variants) {
      if (this.#addonsStagedSelections.has(String(v.id))) {
        currentSelectedVid = String(v.id);
        break;
      }
    }

    let html = '';
    for (const variant of product.variants) {
      if (!variant.availableForSale) continue;
      const vid = String(variant.id);
      const isSelected = vid === currentSelectedVid;
      const selectedClass = isSelected ? 'cd-addon-variant-card--selected' : '';
      const priceHtml = this.#renderInlinePrice(variant.price, null, 'cd-addon-variant-card');
      const imageUrl = product.featuredImage?.url || '';
      const titleEscaped = this.#escapeHtml(variant.title || '');

      html += `
        <button type="button"
          class="cd-addon-variant-card ${selectedClass}"
          data-addon-variant-id="${vid}"
          data-addon-product-id="${this.#escapeHtml(productId)}"
          data-addon-group-type="${parentGroup?.type || 'addon'}"
          on:click="/handleAddonVariantSelect"
        >
          <div class="cd-addon-variant-card__image">
            <div class="cd-addon-variant-card__image-bg"></div>
            ${imageUrl ? `<img src="${this.#escapeHtml(imageUrl)}" alt="${titleEscaped}" width="64" height="64" loading="lazy">` : ''}
          </div>
          <div class="cd-addon-variant-card__info">
            <span class="cd-addon-variant-card__title">${titleEscaped}</span>
            ${priceHtml}
          </div>
        </button>
      `;
    }

    list.innerHTML = html;
    list.dataset.addonProductId = productId;

    const confirmBtn = this.querySelector('.cd-addon-variant-panel__confirm');
    if (confirmBtn) confirmBtn.disabled = !currentSelectedVid;

    this.#showAddonVariantPanel(true);
  }

  /**
   * Handle variant selection in the add-on variant sub-panel.
   * @param {MouseEvent} event
   */
  handleAddonVariantSelect(event) {
    if (this.#busy) return;

    const card = event.target.closest('[data-addon-variant-id]');
    if (!card) return;

    const allCards = this.querySelectorAll('.cd-addon-variant-card');
    for (const c of allCards) {
      c.classList.remove('cd-addon-variant-card--selected');
    }
    card.classList.add('cd-addon-variant-card--selected');

    const confirmBtn = this.querySelector('.cd-addon-variant-panel__confirm');
    if (confirmBtn) confirmBtn.disabled = false;
  }

  /**
   * Confirm variant selection and return to add-ons list.
   */
  handleAddonVariantConfirm() {
    if (this.#busy) return;

    const selected = this.querySelector('.cd-addon-variant-card--selected');
    if (!selected) return;

    const variantId = selected.dataset.addonVariantId;
    const productId = selected.dataset.addonProductId;
    const groupType = selected.dataset.addonGroupType || 'addon';

    let product = null;
    let parentGroup = null;
    for (const group of this.#addonsGroups) {
      const found = group.products.find((p) => p.id === productId);
      if (found) {
        product = found;
        parentGroup = group;
        break;
      }
    }
    if (!product) return;

    // Remove any previously selected variant for this same product
    for (const v of product.variants) {
      this.#addonsStagedSelections.delete(String(v.id));
    }

    const variant = product.variants.find((v) => String(v.id) === variantId);

    if (variant) {
      this.#stageAddon(variantId, {
        variantId,
        productId: product.id,
        title: `${product.title} - ${variant.title}`,
        price: variant.price,
        lineKey: null,
        groupType,
      }, parentGroup);
    }

    this.#showAddonVariantPanel(false);

    // Re-render the current active tab's products
    const list = this.querySelector('.cd-addons-list');
    const currentIndex = parseInt(list?.dataset.addonGroupIndex ?? '0', 10);
    this.#renderAddonProducts(currentIndex);
    this.#updateAddonsButtonState();
  }

  /**
   * Commit staged add-on/upgrade selections to the cart.
   * Computes a diff against current cart and applies changes in batched calls.
   */
  async handleAddonsUpdate() {
    if (this.#busy) return;

    this.#setBusy(true);
    const updateBtn = this.querySelector('.cd-addons-panel__update');
    const body = this.querySelector('.cd-addons-panel__body');

    if (body) body.classList.add('cd-addons-panel__body--processing');

    if (updateBtn) {
      updateBtn.disabled = true;
      updateBtn.textContent = this.#t('updating');
    }

    try {
      const cartData = await this.#getCartJson();

      // Compute removals: addon/upgrade items in cart but not in staged selections
      const toRemove = {};

      for (const item of cartData.items) {
        const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
        if (
          readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId) === this.#addonsParentAddToCartId &&
          (itemType === CART_ITEM_TYPES.addOn || itemType === CART_ITEM_TYPES.upgrade)
        ) {
          const vid = String(item.variant_id);

          if (!this.#addonsStagedSelections.has(vid)) {
            toRemove[item.key] = 0;
          }
        }
      }

      // Compute additions: items in staged but not in current cart
      const toAdd = [];

      for (const [vid, staged] of this.#addonsStagedSelections) {
        if (!this.#addonsCurrentCart.has(vid)) {
          const cartItemType = staged.groupType === 'upgrade'
            ? CART_ITEM_TYPES.upgrade
            : CART_ITEM_TYPES.addOn;
          toAdd.push({
            id: parseInt(vid, 10),
            quantity: 1,
            properties: {
              [CART_PROPERTY_KEYS.addToCartId]: this.#addonsParentAddToCartId,
              [CART_PROPERTY_KEYS.itemType]: cartItemType,
            },
          });
        }
      }

      if (Object.keys(toRemove).length > 0) {
        const removeResponse = await fetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: toRemove }),
        });

        if (!removeResponse.ok) throw new Error('Failed to remove add-ons');
      }

      if (toAdd.length > 0) {
        const addResponse = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: toAdd }),
        });

        if (!addResponse.ok) throw new Error('Failed to add add-ons');
      }

      this.#showAddonsPanel(false);
      this.#addonsStagedSelections.clear();
      this.#addonsCurrentCart.clear();
      this.#addonsParentLineKey = null;
      this.#addonsParentAddToCartId = null;
      this.#addonsGroups = [];

      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
      if (body) body.classList.remove('cd-addons-panel__body--processing');
      this.#setBusy(false);
    } catch (error) {
      await this.#refreshDrawer().catch(() => {});
      if (body) body.classList.remove('cd-addons-panel__body--processing');
      this.#setBusy(false);
      console.error('Add-ons update failed:', error);
      this.#showError(this.#t('updateGiftUpgradesError'));
    }
  }

  /**
   * Back button on the add-ons panel — return to main cart view.
   */
  handleAddonsBack() {
    if (this.#busy) return;
    this.#showAddonsPanel(false);
    this.#addonsStagedSelections.clear();
    this.#addonsCurrentCart.clear();
    this.#addonsParentLineKey = null;
    this.#addonsParentAddToCartId = null;
    this.#addonsGroups = [];
  }

  /**
   * Back button on the add-on variant sub-panel — return to add-ons list.
   */
  handleAddonVariantBack() {
    if (this.#busy) return;
    this.#showAddonVariantPanel(false);
  }

  /**
   * Show/hide the add-ons panel
   * @param {boolean} show
   */
  #showAddonsPanel(show) {
    const panel = this.querySelector('.cd-addons-panel');
    const main = this.querySelector('.cd-main-view');

    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');

    if (main && show) {
      main.setAttribute('aria-hidden', 'true');
    }

    if (main && !show) {
      const variantPanel = this.querySelector('.cd-variant-panel');
      const isVariantOpen = variantPanel?.getAttribute('aria-hidden') === 'false';

      if (!isVariantOpen) main.setAttribute('aria-hidden', 'false');
    }
  }

  /**
   * Show/hide the add-on variant sub-panel
   * @param {boolean} show
   */
  #showAddonVariantPanel(show) {
    const panel = this.querySelector('.cd-addon-variant-panel');
    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  /**
   * Toggle loading skeleton in the add-ons panel
   * @param {boolean} loading
   */
  #setAddonsLoading(loading) {
    const skeleton = this.querySelector('.cd-addons-loading');
    const list = this.querySelector('.cd-addons-list');

    if (skeleton) skeleton.style.display = loading ? 'flex' : 'none';
    if (list) list.style.display = loading ? 'none' : '';
  }

  /**
   * Update the add-ons panel "Update Cart" button state.
   * Enabled when staged selections differ from current cart.
   */
  #updateAddonsButtonState() {
    const updateBtn = this.querySelector('.cd-addons-panel__update');
    if (!updateBtn) return;

    const stagedIds = new Set(this.#addonsStagedSelections.keys());
    const hasChanges =
      stagedIds.size !== this.#addonsCurrentCart.size ||
      [...stagedIds].some((id) => !this.#addonsCurrentCart.has(id)) ||
      [...this.#addonsCurrentCart].some((id) => !stagedIds.has(id));

    updateBtn.disabled = !hasChanges;
    updateBtn.textContent = this.#t('updateCart');
  }

  /**
   * Strip HTML tags from a string.
   * @param {string} html
   * @returns {string}
   */
  #stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  /**
   * Truncate text to a maximum length with ellipsis.
   * @param {string} text
   * @param {number} maxLen
   * @returns {string}
   */
  #truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.substring(0, maxLen).trim() + '…';
  }

  /**
   * Escape a string for safe insertion into innerHTML.
   * @param {string} str
   * @returns {string}
   */
  #escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Format price in cents using the active Shopify market money format.
   * @param {number} cents
   * @returns {string}
   */
  #formatMoney(cents) {
    return formatShopifyMoney(cents, this.dataset.moneyFormat || '{{amount}}', this.dataset.currency || 'USD');
  }

  /**
   * Render a horizontal price row with an optional compare-at price.
   * @param {number} price
   * @param {number|null|undefined} compareAtPrice
   * @param {string} blockClass
   * @returns {string}
   */
  #renderInlinePrice(price, compareAtPrice, blockClass) {
    const priceFormatted = this.#formatMoney(price);
    const comparePriceHtml =
      compareAtPrice && compareAtPrice > price
        ? `<span class="${blockClass}__compare-price">${this.#formatMoney(compareAtPrice)}</span>`
        : '';

    return `
      <span class="${blockClass}__prices">
        <span class="${blockClass}__price">${priceFormatted}</span>
        ${comparePriceHtml}
      </span>
    `;
  }

  /**
   * Read the original URL from a serialized Shopify image.
   * @param {object|string|null|undefined} image
   * @returns {string}
   */
  #getImageUrl(image) {
    if (typeof image === 'string') return image;
    return image?.src || image?.url || '';
  }

  /**
   * Resize a Shopify image URL
   * @param {string} url
   * @param {string} size
   * @returns {string}
   */
  #resizeImage(url, size) {
    if (!url) return '';
    return url.replace(/\.(jpg|jpeg|png|gif|webp)/, `_${size}.$1`);
  }

  /* ==========================================================================
     Personal Message — initialization & sync
     ========================================================================== */

  /**
   * Read the shared message config island rendered by the Personalization
   * Drawer. Returns {} when the PD (or its message-option blocks) is absent.
   * @returns {Object}
   */
  #getMessageConfig() {
    const el = document.getElementById('cd-personalization-message-config');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent) || {};
    } catch {
      return {};
    }
  }

  /**
   * Apply the PD message config to the cart-drawer markup: paid variant/iframe,
   * max chars, occasion options, titles, button labels and tab labels. This is
   * what makes the Personalization Drawer message-option blocks the single
   * source of truth for the cart-drawer personal-message flow.
   * @param {Element} personalizeEl
   */
  #applyMessageConfig(personalizeEl) {
    const cfg = this.#getMessageConfig();
    this.#messageConfig = cfg;

    // Runtime config consumed by the flow
    this.#giftMessageVariantId =
      cfg.giftMessageVariantId != null ? String(cfg.giftMessageVariantId) : null;
    this.#greetingCardVariantId =
      cfg.greetingCardVariantId != null ? String(cfg.greetingCardVariantId) : null;
    this.#greetingCardBaseUrl = cfg.iframeUrl || '';
    this.#messageMaxChars = parseInt(cfg.maxChars, 10) || 300;

    // Paid greeting card: show whenever a Printible iframe URL is configured
    // (the variant only matters at commit time — mirrors the Personalization
    // Drawer, which renders the card even when the variant resolves to 0). Also
    // keep it visible when a greeting card is already in the cart so the
    // Change/Remove (update) actions are always reachable.
    const gcCard = personalizeEl.querySelector('[data-cd-message-card="greeting-card"]');
    if (gcCard) {
      const alreadyAdded = gcCard.classList.contains('cd-personalize__card--added');
      gcCard.hidden = !(this.#greetingCardBaseUrl || alreadyAdded);
    }

    const setText = (selector, value) => {
      if (!value) return;
      const node = this.querySelector(selector);
      if (node) node.textContent = value;
    };

    // Card titles come from the configured paid/free message blocks. Panel
    // titles come from Cart Drawer settings — do NOT override them here.
    setText('[data-cd-greeting-card-title]', cfg.paidTitle);
    setText('[data-cd-gift-message-title]', cfg.freeTitle);

    // Gift message description (sourced from PD free message block)
    setText('[data-cd-gm-description]', cfg.freeDescription);

    // Button labels (paid label includes the configured price)
    const gcBtn = personalizeEl.querySelector('[data-cd-greeting-card-trigger]');
    if (gcBtn && cfg.paidButtonLabel) {
      gcBtn.textContent = cfg.paidPriceFormatted
        ? `${cfg.paidButtonLabel} - ${cfg.paidPriceFormatted}`
        : cfg.paidButtonLabel;
    }
    const gmBtn = personalizeEl.querySelector('[data-cd-gift-message-trigger]');
    if (gmBtn && cfg.freeButtonLabel) gmBtn.textContent = cfg.freeButtonLabel;

    // Tab labels
    setText('[data-cd-gm-tab="write-own"]', cfg.tabWriteOwn);
    setText('[data-cd-gm-tab="generate"]', cfg.tabGenerate);

    // Textareas: max length + counter
    const maxAttr = String(this.#messageMaxChars);
    this.querySelectorAll('[data-cd-gm-textarea], [data-cd-gm-generated-textarea]').forEach((ta) => {
      ta.setAttribute('maxlength', maxAttr);
    });
    const counter = this.querySelector('[data-cd-gm-counter]');
    if (counter) {
      const ta = this.querySelector('[data-cd-gm-textarea]');
      counter.textContent = `${ta ? ta.value.length : 0}/${this.#messageMaxChars}`;
    }

    if (Array.isArray(cfg.occasions) && cfg.occasions.length) {
      // Gift-message occasion dropdown (custom list — matches PD; uses the label)
      const gmList = this.querySelector('[data-cd-gm-dropdown-list]');
      if (gmList) {
        gmList.innerHTML = '';
        for (const occ of cfg.occasions) {
          if (!occ || !occ.label) continue;
          const li = document.createElement('li');
          li.className = 'cd-gm-dropdown-item';
          li.setAttribute('role', 'option');
          li.setAttribute('tabindex', '0');
          li.setAttribute('data-cd-gm-occasion', occ.label);
          li.textContent = occ.label;
          gmList.appendChild(li);
        }
      }

      // Greeting-card occasion dropdown (custom list — matches PD; carries both
      // the label and the PD occasion ID used for the Printible iframe).
      const gcList = this.querySelector('[data-cd-gc-dropdown-list]');
      if (gcList) {
        gcList.innerHTML = '';
        for (const occ of cfg.occasions) {
          if (!occ || !occ.id) continue;
          const li = document.createElement('li');
          li.className = 'cd-gm-dropdown-item';
          li.setAttribute('role', 'option');
          li.setAttribute('tabindex', '0');
          li.setAttribute('data-cd-gc-occasion', occ.label);
          li.setAttribute('data-cd-gc-occasion-id', occ.id);
          li.textContent = occ.label;
          gcList.appendChild(li);
        }
      }
    }
  }

  /**
   * Fetch the same EA occasions source used by the Personalization Drawer.
   * @returns {Promise<Array<{id: number|string, name: string}>>}
   */
  async #fetchOccasions() {
    if (this.#occasionsData) return this.#occasionsData;
    if (this.#occasionsPromise) return this.#occasionsPromise;

    this.#occasionsPromise = (async () => {
      try {
        const response = await fetch(
          'https://www.ediblearrangements.com/api/arrangement-group/occasions?target=1',
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        this.#occasionsData = Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Cart drawer: failed to fetch occasions', error);
        this.#occasionsData = [];
      }
      return this.#occasionsData;
    })();

    return this.#occasionsPromise;
  }

  /**
   * Populate gift-message and greeting-card occasion dropdowns from the API.
   * The greeting-card items use the API id for Printible `occasionID`.
   */
  async #populateOccasionDropdowns() {
    const occasions = await this.#fetchOccasions();
    if (!occasions.length) return;

    const gmList = this.querySelector('[data-cd-gm-dropdown-list]');
    if (gmList) {
      gmList.innerHTML = '';
      for (const occasion of occasions) {
        if (!occasion || !occasion.name) continue;
        const li = document.createElement('li');
        li.className = 'cd-gm-dropdown-item';
        li.setAttribute('role', 'option');
        li.setAttribute('tabindex', '0');
        li.setAttribute('data-cd-gm-occasion', String(occasion.name));
        li.textContent = String(occasion.name);
        gmList.appendChild(li);
      }
    }

    const gcList = this.querySelector('[data-cd-gc-dropdown-list]');
    if (gcList) {
      gcList.innerHTML = '';
      for (const occasion of occasions) {
        if (!occasion || !occasion.name) continue;
        const li = document.createElement('li');
        li.className = 'cd-gm-dropdown-item';
        li.setAttribute('role', 'option');
        li.setAttribute('tabindex', '0');
        li.setAttribute('data-cd-gc-occasion', String(occasion.name));
        li.setAttribute('data-cd-gc-occasion-id', occasion.id != null ? String(occasion.id) : '');
        li.textContent = String(occasion.name);
        gcList.appendChild(li);
      }
    }
  }

  /**
   * Toggle the section-scoped processing state for the personal-message area.
   * Fades the "Add a personal message" section and summary line items while a
   * message mutation is in flight.
   * @param {boolean} processing
   */
  #setMessageProcessing(processing) {
    const el = this.querySelector('[data-cd-personalize]');
    if (el) el.classList.toggle('cd-personalize--processing', processing);
    this.querySelectorAll('[data-cd-message-summary]').forEach((summaryEl) => {
      summaryEl.classList.toggle('cd-personalize--processing', processing);
    });
  }

  /**
   * Bind listeners on an element exactly once, even though #initMessageFlow runs
   * after every Section Rendering morph. Persistent nodes (subview panels) keep
   * their listeners across morphs; re-rendered nodes are fresh and bind again.
   * Dynamic children (rebuilt dropdown options) are handled via delegation on
   * the persistent list, so they keep working without re-binding.
   * @param {Element|null} el
   * @param {() => void} fn
   */
  #wireOnce(el, fn) {
    if (!el || this.#wiredEls.has(el)) return;
    this.#wiredEls.add(el);
    fn();
  }

  /**
   * Wire up all message-flow event listeners. Called once from connectedCallback.
   */
  #initMessageFlow() {
    const personalizeEl = this.querySelector('[data-cd-personalize]');

    // Source message config (paid product/price, iframe URL, max chars, tab
    // labels, titles, button copy) from the Personalization Drawer. Occasions
    // are refreshed from the same API PD uses so greeting cards get real ids.
    if (personalizeEl) {
      this.#applyMessageConfig(personalizeEl);
      this.#populateOccasionDropdowns();
    }

    // Personalize cards: open triggers + added-state actions. One delegated
    // click handler covers all of them so re-rendered inner buttons keep working.
    this.#wireOnce(personalizeEl, () => {
      personalizeEl.addEventListener('click', (event) => {
        if (event.target.closest('[data-cd-gift-message-trigger]')) {
          this.#openGiftMessageView();
          return;
        }
        if (event.target.closest('[data-cd-greeting-card-trigger]')) {
          this.#openGreetingCardView();
          return;
        }

        const gmAction = event.target.closest('[data-cd-gift-message-action]');
        if (gmAction) {
          const action = gmAction.dataset.cdGiftMessageAction;
          if (action === 'remove') this.#handleRemoveGiftMessage();
          else if (action === 'edit') this.#handleEditGiftMessage();
          return;
        }

        const gcAction = event.target.closest('[data-cd-greeting-card-action]');
        if (gcAction) {
          const action = gcAction.dataset.cdGreetingCardAction;
          if (action === 'remove') this.#handleRemoveGreetingCard();
          else if (action === 'change') this.#handleChangeGreetingCard();
        }
      });
    });

    // Personal-message summary line items use the same actions as the
    // personalize cards, but live in the cart item list after each refresh.
    const itemsEl = this.querySelector('.cd-items');
    this.#wireOnce(itemsEl, () => {
      itemsEl.addEventListener('click', (event) => {
        const gmAction = event.target.closest('[data-cd-gift-message-action]');
        if (gmAction) {
          const action = gmAction.dataset.cdGiftMessageAction;
          if (action === 'remove') this.#handleRemoveGiftMessage();
          else if (action === 'edit') this.#handleEditGiftMessage();
          return;
        }

        const gcAction = event.target.closest('[data-cd-greeting-card-action]');
        if (gcAction) {
          const action = gcAction.dataset.cdGreetingCardAction;
          if (action === 'remove') this.#handleRemoveGreetingCard();
          else if (action === 'change') this.#handleChangeGreetingCard();
        }
      });
    });

    // Gift message subview — persistent node, wire once.
    const gmPanel = this.querySelector('[data-cd-gift-message-view]');
    this.#wireOnce(gmPanel, () => {
      const gmBack = gmPanel.querySelector('[data-cd-gift-message-back]');
      const gmClose = gmPanel.querySelector('[data-cd-gift-message-close]');
      if (gmBack) gmBack.addEventListener('click', () => this.#closeGiftMessageView());
      if (gmClose) gmClose.addEventListener('click', () => this.closeDialog());
      this.#setupGiftMessageView(gmPanel);
    });

    // Greeting card subview — persistent node, wire once.
    const gcPanel = this.querySelector('[data-cd-greeting-card-view]');
    this.#wireOnce(gcPanel, () => {
      const gcBack = gcPanel.querySelector('[data-cd-greeting-card-back]');
      const gcClose = gcPanel.querySelector('[data-cd-greeting-card-close]');
      if (gcBack) gcBack.addEventListener('click', () => this.#closeGreetingCardView());
      if (gcClose) gcClose.addEventListener('click', () => this.closeDialog());
      this.#setupGreetingCardView(gcPanel);
    });
  }

  /**
   * Read personalization line items for edit/subview state only.
   * Visible Add/Added state is rendered by Liquid via Section Rendering.
   */
  async #syncMessagesFromCart() {
    let cartData;
    try {
      cartData = await this.#getCartJson();
    } catch {
      return;
    }

    const items = cartData.items || [];
    const giftMessageLine = items.find(
      (item) =>
        readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === CART_ITEM_TYPES.giftMessage
    );
    const greetingCardLine = items.find(
      (item) =>
        readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === CART_ITEM_TYPES.greetingCard
    );

    // Gift message
    const savedGm = readCartProperty(giftMessageLine?.properties, CART_PROPERTY_KEYS.giftMessageData) || '';
    this.#giftMessageText = savedGm;

    // Greeting card
    const savedGc = greetingCardLine?.properties?.[CART_PROPERTY_KEYS.greetingCardData] || '';
    if (savedGc) {
      this.#greetingCardData = typeof savedGc === 'string' ? this.#parseJsonMaybe(savedGc) || savedGc : savedGc;
    } else {
      this.#greetingCardData = null;
    }

    // Pre-fill the write-own textarea with the saved message and refresh its
    // counter/filled/button state via the wired input handler.
    const textarea = this.querySelector('[data-cd-gm-textarea]');
    if (textarea) {
      textarea.value = savedGm;
      textarea.dispatchEvent(new Event('input'));
    }
  }

  /**
   * Parse JSON only when a cart property was serialized as a string.
   * @param {string} value
   * @returns {Object|null}
   */
  #parseJsonMaybe(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /* ==========================================================================
     Panel show/hide helpers
     ========================================================================== */

  /**
   * Show/hide gift message panel
   * @param {boolean} show
   */
  #showGiftMessagePanel(show) {
    const panel = this.querySelector('[data-cd-gift-message-view]');
    const main = this.querySelector('.cd-main-view');

    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (main) main.setAttribute('aria-hidden', show ? 'true' : 'false');
  }

  /**
   * Show/hide greeting card panel
   * @param {boolean} show
   */
  #showGreetingCardPanel(show) {
    const panel = this.querySelector('[data-cd-greeting-card-view]');
    const main = this.querySelector('.cd-main-view');

    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (main) main.setAttribute('aria-hidden', show ? 'true' : 'false');
  }

  /**
   * Open gift message subview
   */
  #openGiftMessageView() {
    const writeOwnTab = this.querySelector('[data-cd-gm-tab="write-own"]');
    if (writeOwnTab && !writeOwnTab.classList.contains('cd-gm-tab--active')) {
      writeOwnTab.click();
    }

    // Pre-fill textarea with saved text and refresh its state (counter/button)
    const textarea = this.querySelector('[data-cd-gm-textarea]');
    if (textarea) {
      textarea.value = this.#giftMessageText;
      textarea.dispatchEvent(new Event('input'));
    }
    this.#showGiftMessagePanel(true);
  }

  /**
   * Close gift message subview
   */
  #closeGiftMessageView() {
    this.#showGiftMessagePanel(false);
  }

  /**
   * Open greeting card subview. If the iframe is already loaded (e.g. reopened),
   * show it; otherwise show the occasion picker. Mirrors PD #openGreetingCardView.
   */
  #openGreetingCardView() {
    const panel = this.querySelector('[data-cd-greeting-card-view]');
    const iframe = panel?.querySelector('[data-cd-gc-iframe]');
    const wrap = panel?.querySelector('[data-cd-gc-occasion-wrap]');

    if (iframe && iframe.getAttribute('src')) {
      if (wrap) wrap.style.display = 'none';
      iframe.style.display = '';
    } else {
      if (wrap) wrap.style.display = '';
      if (iframe) iframe.style.display = 'none';
    }

    this.#showGreetingCardPanel(true);
  }

  /**
   * "Change" on the added paid card — restart from a fresh occasion picker,
   * identical to a first-time add. Does NOT clear the stored card data, so
   * backing out without completing keeps the previously added card intact.
   */
  #handleChangeGreetingCard() {
    this.#greetingCardOccasionId = null;
    this.#resetGreetingCardSubviewUi();
    this.#openGreetingCardView();
  }

  /**
   * Close greeting card subview
   */
  #closeGreetingCardView() {
    this.#showGreetingCardPanel(false);
  }

  /* ==========================================================================
     Gift Message — write own & generate
     ========================================================================== */

  /**
   * Wire up the gift message view (tabs, write-own, generate)
   * @param {Element} panel
   */
  #setupGiftMessageView(panel) {
    this.#setupGiftMessageTabs(panel);
    this.#setupWriteOwnMessage(panel);
    this.#setupGenerateMessage(panel);
  }

  /**
   * Wire tab switching
   * @param {Element} panel
   */
  #setupGiftMessageTabs(panel) {
    const tabs = panel.querySelectorAll('[data-cd-gm-tab]');
    const panels = panel.querySelectorAll('[data-cd-gm-panel]');

    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const tabId = tab.getAttribute('data-cd-gm-tab');

        for (const t of tabs) {
          t.classList.toggle('cd-gm-tab--active', t.getAttribute('data-cd-gm-tab') === tabId);
        }

        for (const p of panels) {
          p.style.display = p.getAttribute('data-cd-gm-panel') === tabId ? '' : 'none';
        }
      });
    }
  }

  /**
   * Wire write-own textarea and submit
   * @param {Element} panel
   */
  #setupWriteOwnMessage(panel) {
    const textarea = panel.querySelector('[data-cd-gm-textarea]');
    const counter = panel.querySelector('[data-cd-gm-counter]');
    const errorEl = panel.querySelector('[data-cd-gm-error]');
    const submitBtn = panel.querySelector('[data-cd-gm-submit]');

    if (!textarea || !counter || !submitBtn) return;

    const maxChars = this.#messageMaxChars;

    const updateState = () => {
      const length = textarea.value.length;
      counter.textContent = `${length}/${maxChars}`;

      const isAtMax = length >= maxChars;
      const hasContent = length > 0;

      // Error state (at max characters)
      textarea.classList.toggle('cd-gm-textarea--error', isAtMax);
      counter.classList.toggle('cd-gm-counter--error', isAtMax);
      if (errorEl) errorEl.style.display = isAtMax ? '' : 'none';

      // Filled state
      textarea.classList.toggle('cd-gm-textarea--filled', hasContent && !isAtMax);

      // Button enabled only when there is content
      submitBtn.disabled = !hasContent;
      submitBtn.classList.toggle('cd-gm-btn--disabled', !hasContent);
    };

    textarea.addEventListener('input', updateState);
    textarea.addEventListener('paste', () => {
      requestAnimationFrame(updateState);
    });

    submitBtn.addEventListener('click', () => {
      if (!textarea.value.trim()) return;
      this.#handleAddGiftMessage(textarea.value.trim());
    });
  }

  /**
   * Wire generate-message form
   * @param {Element} panel
   */
  #setupGenerateMessage(panel) {
    const dropdownTrigger = panel.querySelector('[data-cd-gm-dropdown-trigger]');
    const dropdownList = panel.querySelector('[data-cd-gm-dropdown-list]');
    const dropdownValue = panel.querySelector('[data-cd-gm-dropdown-value]');
    const nameInput = panel.querySelector('[data-cd-gm-name-input]');
    const nameLabel = panel.querySelector('[data-cd-gm-name-label]');
    const generateBtn = panel.querySelector('[data-cd-gm-generate-btn]');
    const generatedWrap = panel.querySelector('[data-cd-gm-generated-wrap]');
    const generatedTextarea = panel.querySelector('[data-cd-gm-generated-textarea]');
    const generatedCounter = panel.querySelector('[data-cd-gm-generated-counter]');
    const generatedError = panel.querySelector('[data-cd-gm-generated-error]');
    const postGenerate = panel.querySelector('[data-cd-gm-post-generate]');
    const submitGenerated = panel.querySelector('[data-cd-gm-submit-generated]');
    const regenerateBtn = panel.querySelector('[data-cd-gm-regenerate-btn]');

    const maxChars = this.#messageMaxChars;

    this.#selectedOccasion = null;

    // -- Custom dropdown logic --
    if (dropdownTrigger && dropdownList) {
      dropdownTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = dropdownList.style.display !== 'none';
        dropdownList.style.display = isOpen ? 'none' : '';
        dropdownTrigger.classList.toggle('cd-gm-field__select--open', !isOpen);
        dropdownTrigger.setAttribute('aria-expanded', String(!isOpen));
      });

      dropdownTrigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          dropdownTrigger.click();
        }
      });

      // Outside-click closing is handled once at the document level via
      // #boundCloseGmDropdown (wired in connectedCallback) to avoid stacking
      // listeners on every section refresh.

      // Delegated item selection — survives #applyMessageConfig rebuilding the
      // <li> options after each Section Rendering morph.
      dropdownList.addEventListener('click', (event) => {
        const item = event.target.closest('[data-cd-gm-occasion]');
        if (!item) return;
        event.stopPropagation();

        const value = item.getAttribute('data-cd-gm-occasion');
        this.#selectedOccasion = value;

        if (dropdownValue) {
          dropdownValue.textContent = value;
          dropdownValue.style.display = '';
        }

        for (const i of dropdownList.querySelectorAll('[data-cd-gm-occasion]')) {
          i.classList.toggle('cd-gm-dropdown-item--selected', i === item);
        }

        dropdownList.style.display = 'none';
        dropdownTrigger.classList.remove('cd-gm-field__select--open');
        dropdownTrigger.classList.add('cd-gm-field__select--filled');
        dropdownTrigger.setAttribute('aria-expanded', 'false');

        this.#updateGenerateButtonState(panel);
      });

      dropdownList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target.closest('[data-cd-gm-occasion]');
        if (!item) return;
        event.preventDefault();
        item.click();
      });
    }

    // -- Name input floating label logic --
    if (nameInput && nameLabel) {
      const inputWrap = nameInput.closest('.cd-gm-field__input-wrap');

      const updateNameState = () => {
        const hasValue = nameInput.value.length > 0;
        if (inputWrap) {
          inputWrap.classList.toggle('cd-gm-field__input-wrap--active', hasValue || document.activeElement === nameInput);
          inputWrap.classList.toggle('cd-gm-field__input-wrap--filled', hasValue);
        }
        this.#updateGenerateButtonState(panel);
      };

      nameInput.addEventListener('input', updateNameState);
      nameInput.addEventListener('focus', () => {
        if (inputWrap) {
          inputWrap.classList.add('cd-gm-field__input-wrap--active');
          inputWrap.classList.add('cd-gm-field__input-wrap--focused');
        }
      });
      nameInput.addEventListener('blur', () => {
        if (inputWrap) {
          if (!nameInput.value) inputWrap.classList.remove('cd-gm-field__input-wrap--active');
          inputWrap.classList.remove('cd-gm-field__input-wrap--focused');
        }
      });
    }

    // -- Generate button --
    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        if (!this.#selectedOccasion || !nameInput?.value.trim()) return;

        const originalText = generateBtn.textContent;
        generateBtn.textContent = this.#t('generating');
        generateBtn.disabled = true;
        generateBtn.classList.add('cd-gm-btn--disabled');

        try {
          const message = await this.#generateGiftMessage(this.#selectedOccasion, nameInput.value.trim(), maxChars);

          if (generatedTextarea && generatedWrap && postGenerate) {
            generatedTextarea.value = message;
            generatedWrap.style.display = '';
            generateBtn.style.display = 'none';
            postGenerate.style.display = '';
            if (generatedCounter) generatedCounter.textContent = `${message.length}/${maxChars}`;
          }
        } catch (error) {
          console.error('Gift message generation failed:', error);
        } finally {
          generateBtn.textContent = originalText;
          generateBtn.disabled = false;
          generateBtn.classList.remove('cd-gm-btn--disabled');
        }
      });
    }

    // -- Generated textarea editing --
    if (generatedTextarea && generatedCounter) {
      const updateGeneratedState = () => {
        const length = generatedTextarea.value.length;
        generatedCounter.textContent = `${length}/${maxChars}`;

        const isAtMax = length >= maxChars;
        generatedTextarea.classList.toggle('cd-gm-textarea--error', isAtMax);
        generatedCounter.classList.toggle('cd-gm-counter--error', isAtMax);
        if (generatedError) generatedError.style.display = isAtMax ? '' : 'none';
        generatedTextarea.classList.toggle('cd-gm-textarea--filled', length > 0 && !isAtMax);
      };

      generatedTextarea.addEventListener('input', updateGeneratedState);
      generatedTextarea.addEventListener('paste', () => {
        requestAnimationFrame(updateGeneratedState);
      });
    }

    // -- Submit generated message --
    if (submitGenerated) {
      submitGenerated.addEventListener('click', () => {
        const text = generatedTextarea?.value.trim();
        if (!text) return;
        this.#handleAddGiftMessage(text);
      });
    }

    // -- Regenerate --
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', async () => {
        if (!this.#selectedOccasion || !nameInput?.value.trim()) return;

        regenerateBtn.textContent = this.#t('generating');
        regenerateBtn.style.pointerEvents = 'none';

        try {
          const message = await this.#generateGiftMessage(this.#selectedOccasion, nameInput.value.trim(), maxChars);

          if (generatedTextarea) {
            generatedTextarea.value = message;
            if (generatedCounter) {
              generatedCounter.textContent = `${message.length}/${maxChars}`;
              generatedCounter.classList.remove('cd-gm-counter--error');
            }
            generatedTextarea.classList.remove('cd-gm-textarea--error');
            if (generatedError) generatedError.style.display = 'none';
          }
        } catch (error) {
          console.error('Gift message regeneration failed:', error);
        } finally {
          regenerateBtn.textContent = this.#t('regenerateMessage');
          regenerateBtn.style.pointerEvents = '';
        }
      });
    }
  }

  /**
   * Enable the Generate button only when an occasion and a name are present.
   * @param {Element} panel
   */
  #updateGenerateButtonState(panel) {
    const nameInput = panel.querySelector('[data-cd-gm-name-input]');
    const generateBtn = panel.querySelector('[data-cd-gm-generate-btn]');
    if (!generateBtn) return;

    const hasOccasion = !!this.#selectedOccasion;
    const hasName = !!(nameInput && nameInput.value.trim());

    generateBtn.disabled = !(hasOccasion && hasName);
    generateBtn.classList.toggle('cd-gm-btn--disabled', !(hasOccasion && hasName));
  }

  /**
   * Call the Edible Arrangements AI message API.
   * Mirrors PD: only one name is collected ("Your Name"), sent as `sender`.
   * @param {string} occasion
   * @param {string} name
   * @param {number} maxChars
   * @returns {Promise<string>}
   */
  async #generateGiftMessage(occasion, name, maxChars) {
    const params = new URLSearchParams({
      recipient: '',
      occasion: occasion,
      sender: name,
    });
    const url = `https://www.ediblearrangements.com/api/card/message?${params.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*' },
      });

      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let message = '';

        if (contentType.includes('application/json')) {
          const data = await response.json();
          message = data.message || data.text || data.body || data.data || '';
          if (typeof message !== 'string') {
            message = JSON.stringify(message);
          }
        } else {
          message = await response.text();
        }

        message = message.trim().replace(/^"|"$/g, '');
        if (message) return message.substring(0, maxChars);
      }
    } catch (error) {
      console.error('Edible card-message API failed:', error);
    }

    // Generic fallback
    const fallback = `Thinking of you on this ${occasion} and sending warm wishes your way. May this gift bring a smile to your face and brighten your day.\nWith love,\n${name || 'Me'}`;
    return fallback.substring(0, maxChars);
  }

  /**
   * Save gift message as its cart-wide utility line item.
   * @param {string} text
   */
  async #handleAddGiftMessage(text) {
    if (this.#busy) return;
    if (!this.#giftMessageVariantId) {
      this.#showError(this.#t('giftMessageNotConfigured'));
      return;
    }

    // Return to the cart and enter the processing state immediately. The final
    // Add/Added state is rendered by Liquid after the single refresh below — no
    // optimistic UI toggle here.
    this.#closeGiftMessageView();
    this.#setBusy(true);
    this.#setMessageProcessing(true);

    try {
      this.#giftMessageText = text;
      await this.#upsertPersonalizationLineItem({
        variantId: this.#giftMessageVariantId,
        itemType: CART_ITEM_TYPES.giftMessage,
        properties: this.#getGiftMessageLineProperties(text),
      });
      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
    } catch {
      this.#showError(this.#t('saveGiftMessageError'));
    } finally {
      this.#setMessageProcessing(false);
      this.#setBusy(false);
    }
  }

  /**
   * Remove gift message from cart
   */
  async #handleRemoveGiftMessage() {
    if (this.#busy) return;
    this.#setBusy(true);
    this.#setMessageProcessing(true);

    try {
      this.#giftMessageText = '';
      await this.#removePersonalizationLineItem(CART_ITEM_TYPES.giftMessage);
      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
    } catch {
      this.#showError(this.#t('removeGiftMessageError'));
    } finally {
      this.#setMessageProcessing(false);
      this.#setBusy(false);
    }
  }

  /**
   * Open gift message view in edit mode
   */
  #handleEditGiftMessage() {
    this.#openGiftMessageView();
  }

  /* ==========================================================================
     Greeting Card — occasion picker, iframe, Printible
     ========================================================================== */

  /**
   * Wire up greeting card view events (custom occasion dropdown). Mirrors PD.
   * @param {Element} panel
   */
  #setupGreetingCardView(panel) {
    this.#setupGreetingCardOccasionDropdown(panel);
  }

  /**
   * Wire the "Select the Occasion" custom dropdown in the greeting card subview.
   * Item selection uses delegation on the list so it survives option rebuilds.
   * @param {Element} panel
   */
  #setupGreetingCardOccasionDropdown(panel) {
    const trigger = panel.querySelector('[data-cd-gc-dropdown-trigger]');
    const list = panel.querySelector('[data-cd-gc-dropdown-list]');
    const value = panel.querySelector('[data-cd-gc-dropdown-value]');
    if (!trigger || !list) return;

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = list.style.display !== 'none';
      list.style.display = isOpen ? 'none' : '';
      trigger.classList.toggle('cd-gm-field__select--open', !isOpen);
      trigger.setAttribute('aria-expanded', String(!isOpen));
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        trigger.click();
      }
    });

    list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-cd-gc-occasion]');
      if (!item) return;
      event.stopPropagation();

      const label = item.getAttribute('data-cd-gc-occasion') || '';
      const occasionId = item.getAttribute('data-cd-gc-occasion-id') || '';
      this.#greetingCardOccasionId = occasionId;

      if (value) {
        value.textContent = label;
        value.style.display = '';
      }

      for (const i of list.querySelectorAll('[data-cd-gc-occasion]')) {
        i.classList.toggle('cd-gm-dropdown-item--selected', i === item);
      }

      list.style.display = 'none';
      trigger.classList.remove('cd-gm-field__select--open');
      trigger.classList.add('cd-gm-field__select--filled');
      trigger.setAttribute('aria-expanded', 'false');

      this.#loadGreetingCardIframe();
    });

    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('[data-cd-gc-occasion]');
      if (!item) return;
      event.preventDefault();
      item.click();
    });
  }

  /**
   * Append occasionID + hostUrl to the configured base URL, load it into the
   * iframe, then hide the occasion picker and reveal the iframe (like PD).
   */
  #loadGreetingCardIframe() {
    const panel = this.querySelector('[data-cd-greeting-card-view]');
    if (!panel) return;

    const iframe = panel.querySelector('[data-cd-gc-iframe]');
    const wrap = panel.querySelector('[data-cd-gc-occasion-wrap]');
    if (!iframe || !this.#greetingCardBaseUrl || !this.#greetingCardOccasionId) return;

    const separator = this.#greetingCardBaseUrl.includes('?') ? '&' : '?';
    const hostUrl = encodeURIComponent('https://myedible.myshopify.com');
    const url = `${this.#greetingCardBaseUrl}${separator}occasionID=${encodeURIComponent(this.#greetingCardOccasionId)}&hostUrl=${hostUrl}`;
    iframe.setAttribute('src', url);

    if (wrap) wrap.style.display = 'none';
    iframe.style.display = '';
  }

  /**
   * Handle Printible iframe postMessage events
   * @param {MessageEvent} event
   */
  #handlePrintibleMessage(event) {
    if (!this.#isAllowedPrintibleOrigin(event.origin)) return;
    if (!event.data || !event.data.action) return;

    const iframe = this.querySelector('[data-cd-gc-iframe]');
    if (!iframe || event.source !== iframe.contentWindow) return;

    if (event.data.action === 'printibleCreated' && event.data.printibleID) {
      this.#greetingCardData = event.data;
      this.#handleGreetingCardComplete();
    } else if (event.data.action === 'closePrintibleWindow') {
      this.#closeGreetingCardView();
      this.#resetGreetingCardSubviewUi();
    }
  }

  /**
   * Validate Printible postMessage origins
   * @param {string} origin
   * @returns {boolean}
   */
  #isAllowedPrintibleOrigin(origin) {
    try {
      const url = new URL(origin);
      return (
        url.protocol === 'https:' &&
        (url.hostname === 'printible.ediblearrangements.com' ||
          url.hostname.endsWith('.printible.ediblearrangements.com'))
      );
    } catch {
      return false;
    }
  }

  /**
   * Handle successful greeting card creation from Printible
   */
  async #handleGreetingCardComplete() {
    if (this.#busy) return;

    // Return the shopper to the main cart immediately and enter the processing
    // state. The final Added state is rendered by Liquid after the single
    // refresh below — no optimistic UI toggle here.
    this.#closeGreetingCardView();
    this.#setBusy(true);
    this.#setMessageProcessing(true);

    try {
      if (!this.#greetingCardVariantId) {
        throw new Error('Greeting card product is not configured');
      }
      await this.#upsertPersonalizationLineItem({
        variantId: this.#greetingCardVariantId,
        itemType: CART_ITEM_TYPES.greetingCard,
        properties: this.#getGreetingCardLineProperties(),
      });

      // One event (updates the header cart count) + one refresh (final UI).
      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
    } catch {
      this.#showError(this.#t('saveGreetingCardError'));
    } finally {
      this.#setMessageProcessing(false);
      this.#setBusy(false);
    }
  }

  /**
   * Build line-item properties for the paid greeting card product.
   * @returns {Record<string, string|Object>}
   */
  #getGreetingCardLineProperties() {
    return {
      [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.greetingCard,
      [CART_PROPERTY_KEYS.greetingCardData]: this.#greetingCardData || '',
      [CART_PROPERTY_KEYS.isOnGoody]: 'false',
    };
  }

  /**
   * Build line-item properties for the complimentary gift-message product.
   * @param {string} text
   * @returns {Record<string, string>}
   */
  #getGiftMessageLineProperties(text) {
    return {
      [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.giftMessage,
      [CART_PROPERTY_KEYS.giftMessageData]: text,
      [CART_PROPERTY_KEYS.isOnGoody]: 'false',
    };
  }

  /**
   * Add or update a cart-wide personalization utility line item.
   * @param {{ variantId: string, itemType: string, properties: Record<string, string|Object> }} options
   */
  async #upsertPersonalizationLineItem({ variantId, itemType, properties }) {
    const cartData = await this.#getCartJson();
    const matchingLines = (cartData.items || []).filter(
      (item) =>
        readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === itemType
    );

    if (matchingLines.length > 0) {
      const primaryLine = matchingLines[0];
      const response = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: primaryLine.key,
          quantity: 1,
          properties,
        }),
      });

      if (!response.ok) throw new Error(`Failed to update ${itemType} line`);

      if (matchingLines.length > 1) {
        /** @type {Record<string, number>} */
        const updates = {};
        for (const line of matchingLines.slice(1)) updates[line.key] = 0;
        const removeResponse = await fetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        if (!removeResponse.ok) throw new Error(`Failed to dedupe ${itemType} lines`);
      }
      return;
    }

    const response = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            id: parseInt(variantId, 10),
            quantity: 1,
            properties,
          },
        ],
      }),
    });

    if (!response.ok) throw new Error(`Failed to add ${itemType} line`);
  }

  /**
   * Remove orphan child/utility lines and keep cart-wide utilities as singletons.
   * @returns {Promise<boolean>} Whether the cart was changed
   */
  async #cleanupInvalidCartLines() {
    const cartData = await this.#getCartJson();
    const items = cartData.items || [];

    /** @type {Record<string, number>} */
    const updates = {};

    // If the Bundle Builder discount config metaobject is gone but the cart still
    // holds bundle line items (added while it existed), those can no longer be
    // discounted or rebuilt — strip the bundle line items AND their attached gift
    // wraps / add-ons (sharing _add_to_cart_id), while keeping any non-bundle
    // products and messages. Driven by `data-bundle-config-available` on the root.
    // Merge these removals into the shared `updates` map (instead of posting them
    // and returning early) so the singleton cleanup below still runs — otherwise a
    // cart left holding only bundle lines + a utility line (gift_message /
    // greeting_card / digital_card) would keep that utility line orphaned.
    if (this.dataset.bundleConfigAvailable === 'false') {
      const bundleAddToCartIds = new Set(
        items
          .filter(
            (item) =>
              readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === CART_ITEM_TYPES.bundleLineItem
          )
          .map((item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId))
          .filter(Boolean)
      );
      for (const item of items) {
        const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
        const addId = readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId);
        const isBundleLine = itemType === CART_ITEM_TYPES.bundleLineItem;
        const isBundleChild =
          (itemType === CART_ITEM_TYPES.addOn || itemType === CART_ITEM_TYPES.upgrade) &&
          addId &&
          bundleAddToCartIds.has(addId);
        if (isBundleLine || isBundleChild) {
          updates[item.key] = 0;
        }
      }
    }

    const singletonTypes = [
      CART_ITEM_TYPES.giftMessage,
      CART_ITEM_TYPES.greetingCard,
      CART_ITEM_TYPES.digitalCard,
    ];
    // Cart-wide message singletons (gift message / greeting card / digital card) are
    // kept whenever the cart holds ANY real product line to attach them to — a
    // `parent` (personalized), a `bundle_line_item` (Bundle Builder), or a plain
    // product (no item type). They are only pruned when the cart has no products at
    // all (i.e. just orphaned utility lines). Children/utilities don't count.
    const nonProductTypes = new Set([
      CART_ITEM_TYPES.addOn,
      CART_ITEM_TYPES.upgrade,
      ...singletonTypes,
    ]);
    // Lines already slated for removal above (e.g. stripped bundle lines when the
    // discount config is gone) must NOT count as a product to attach messages to,
    // otherwise the singleton cleanup would keep an orphaned utility line.
    const hasProductLine = items.some(
      (item) =>
        updates[item.key] !== 0 &&
        !nonProductTypes.has(readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType))
    );
    // A group "owner" is any line that is NOT itself a child (add_on).
    // This matches how the cart renders nesting — the owner may be a `parent`
    // (personalization) OR a `bundle_line_item` (Bundle Builder), so add-ons
    // attached to a bundle line are kept, not pruned as orphans.
    const childTypes = new Set([CART_ITEM_TYPES.addOn]);
    const parentAddToCartIds = new Set(
      items
        .filter((item) => !childTypes.has(readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType)))
        .map((item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId))
        .filter(Boolean)
    );

    for (const item of items) {
      const itemType = readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType);
      if (itemType !== CART_ITEM_TYPES.addOn) continue;

      const addToCartId = readCartProperty(item.properties, CART_PROPERTY_KEYS.addToCartId);
      if (!addToCartId || !parentAddToCartIds.has(addToCartId)) {
        updates[item.key] = 0;
      }
    }

    for (const itemType of singletonTypes) {
      const lines = items.filter(
        (item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === itemType
      );
      lines.forEach((line, index) => {
        if (!hasProductLine) {
          updates[line.key] = 0;
          return;
        }
        if (index === 0 && line.quantity !== 1) updates[line.key] = 1;
        if (index > 0) updates[line.key] = 0;
      });
    }

    if (Object.keys(updates).length === 0) return false;

    const response = await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });

    if (!response.ok) {
      let changed = false;
      for (const [id, quantity] of Object.entries(updates)) {
        const changeResponse = await fetch('/cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, quantity }),
        });
        changed = changeResponse.ok || changed;
      }
      return changed;
    }

    return true;
  }

  /**
   * Remove all cart-wide personalization line items of a given type.
   * @param {string} itemType
   */
  async #removePersonalizationLineItem(itemType) {
    const cartData = await this.#getCartJson();
    const lines = (cartData.items || []).filter(
      (item) => readCartProperty(item.properties, CART_PROPERTY_KEYS.itemType) === itemType
    );

    if (lines.length === 0) return;

    /** @type {Record<string, number>} */
    const updates = {};
    for (const line of lines) updates[line.key] = 0;

    const response = await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });

    if (!response.ok) throw new Error(`Failed to remove ${itemType} lines`);
  }

  /**
   * Remove greeting card from cart
   */
  async #handleRemoveGreetingCard() {
    if (this.#busy) return;
    this.#setBusy(true);
    this.#setMessageProcessing(true);

    try {
      this.#greetingCardData = null;
      await this.#removePersonalizationLineItem(CART_ITEM_TYPES.greetingCard);
      this.#resetGreetingCardSubviewUi();

      // One event (updates the header cart count) + one refresh (final UI).
      document.dispatchEvent(new CartUpdateEvent(null, 'ea-cart-drawer'));
      await this.#refreshDrawer();
    } catch {
      this.#showError(this.#t('removeGreetingCardError'));
    } finally {
      this.#setMessageProcessing(false);
      this.#setBusy(false);
    }
  }

  /**
   * Reset greeting card subview UI back to occasion picker
   */
  #resetGreetingCardSubviewUi() {
    const panel = this.querySelector('[data-cd-greeting-card-view]');
    if (!panel) return;

    const iframe = panel.querySelector('[data-cd-gc-iframe]');
    if (iframe) {
      iframe.removeAttribute('src');
      iframe.style.display = 'none';
    }

    const wrap = panel.querySelector('[data-cd-gc-occasion-wrap]');
    if (wrap) wrap.style.display = '';

    const trigger = panel.querySelector('[data-cd-gc-dropdown-trigger]');
    const value = panel.querySelector('[data-cd-gc-dropdown-value]');
    if (trigger) {
      trigger.classList.remove('cd-gm-field__select--filled', 'cd-gm-field__select--open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    if (value) {
      value.textContent = '';
      value.style.display = 'none';
    }
    for (const i of panel.querySelectorAll('[data-cd-gc-occasion]')) {
      i.classList.remove('cd-gm-dropdown-item--selected');
    }

    this.#greetingCardOccasionId = null;
  }

}

if (!customElements.get('ea-cart-drawer')) {
  customElements.define('ea-cart-drawer', EaCartDrawer);
}
