import { Component } from '@theme/component';
import { ThemeEvents, CartAddEvent, CartUpdateEvent } from '@theme/events';
import { fetchConfig, isClickedOutside } from '@theme/utilities';
import {
  CART_ITEM_TYPES,
  CART_PROPERTY_KEYS,
  DIGITAL_CARD_DELIVERY_METHODS,
} from '@theme/cart-contract';
import { formatMoney as formatShopifyMoney } from '@theme/money-formatting';
import {
  buildAddonGroups,
  collectRefs,
  fetchAddonProducts,
  resolveGroups,
} from '@theme/addons-source';

/**
 * @typedef {Object} VariantData
 * @property {number} id
 * @property {string} title
 * @property {number} price
 * @property {number} compareAtPrice
 * @property {boolean} available
 * @property {string|null} image
 * @property {{ name: string, icon: string|null }|null} deliveryAvailability
 */

/**
 * @typedef {Object} ProductData
 * @property {number} productId
 * @property {string} productTitle
 * @property {string} productUrl
 * @property {string} productHandle
 * @property {VariantData[]} variants
 */

/**
 * @typedef {Object} PersonalizationDrawerRefs
 * @property {HTMLDialogElement} drawer
 * @property {HTMLElement} closeButton
 * @property {HTMLElement} mainContent
 * @property {HTMLElement} variantContainer
 * @property {HTMLElement} variantStep
 * @property {HTMLElement} atcButton
 * @property {HTMLElement} atcButtonText
 * @property {HTMLInputElement} zipcodeInput
 */

/** @extends {Component<PersonalizationDrawerRefs>} */
class PersonalizationDrawer extends Component {
  /** @type {AbortController|null} */
  #abortController = null;

  /** @type {ProductData|null} */
  #productData = null;

  /** @type {Record<number, { name: string, icon: string|null }|null>} */
  #pendingDeliveryMap = {};

  /** @type {number|null} Variant selected on PDP when drawer was opened */
  #pendingVariantId = null;

  /** @type {number|null} */
  #selectedVariantId = null;

  /** @type {Set<number>} */
  #selectedAddons = new Set();

  /** @type {number|null} */
  #freeMessageVariantId = null;

  /** @type {number|null} */
  #paidGreetingCardVariantId = null;

  /** @type {string|null} */
  #selectedGiftWrapHandle = null;

  /** @type {number|null} */
  #selectedGiftWrapVariantId = null;

  /** @type {number|null} */
  #selectedGiftWrapProductId = null;

  /** @type {boolean} */
  #wrapAvailable = false;

  /** @type {Map<number, number>} */
  #addonProductIdByVariantId = new Map();

  /** @type {Map<number, string>} Maps variant ID to 'addon' | 'upgrade' */
  #addonTypeByVariantId = new Map();

  /** @type {Record<string, { upgrades: Array, addons: Array }>} Per-variant metafield map */
  #addonsSourceMap = {};

  /** @type {number} Monotonic counter for stale addon-fetch guard */
  #addonsLoadId = 0;

  /** @type {string} Storefront API access token */
  #storefrontToken = '';

  /** @type {string|null} */
  #giftMessageText = null;

  /** @type {boolean} */
  #digitalCardAdded = false;

  /** @type {'text'|'email'} */
  #digitalCardChannel = 'text';

  /** @type {string} */
  #digitalCardRecipient = '';

  /** @type {string} */
  #digitalCardFrom = '';

  /** @type {string} */
  #digitalCardMessage = '';

  /** @type {string|null} */
  #digitalCardSelectedId = null;

  /** @type {string|null} */
  #digitalCardSelectedImage = null;

  /** @type {string|null} */
  #digitalCardSelectedLabel = null;

  /** @type {string|null} */
  #digitalCardOccasion = null;

  /** @type {Array|null} */
  #digitalCardCardsData = null;

  /** @type {boolean} */
  #digitalCardSubviewOpen = false;

  /** @type {number|null} */
  #digitalCardVariantId = null;

  /** @type {boolean} */
  #isOnGoody = false;

  /** @type {string} */
  #marketplaceProductId = '';

  /** @type {Record<number, string>} */
  #marketplaceVariantIdMap = {};

  /** @type {Array<{id: number, name: string}>|null} */
  #occasionsData = null;

  /** @type {Promise<Array<{id: number, name: string}>>|null} */
  #occasionsPromise = null;

  /** @type {boolean} */
  #giftMessageSubviewOpen = false;

  /** @type {string|null} */
  #selectedOccasion = null;

  /** @type {boolean} */
  #greetingCardSubviewOpen = false;

  /** @type {*} */
  #greetingCardData = null;

  /** @type {string|null} */
  #greetingCardBaseUrl = null;

  /** @type {Record<string, string>} */
  #i18n = {};

  /** @type {boolean} */
  #isOpen = false;

  /** @type {boolean} */
  #isAddingToCart = false;

  /** @type {(event: MouseEvent) => void} */
  #boundHandleGlobalClick = (event) => this.#handleGlobalClick(event);

  /** @type {(event: MouseEvent) => void} */
  #boundHandleAddToCart = (event) => this.#handleAddToCart(event);

  /** @type {(event: MessageEvent) => void} */
  #boundHandlePrintibleMessage = (event) => this.#handlePrintibleMessage(event);

  /**
   * Read translations emitted by Liquid for JS-rendered UI.
   */
  #loadI18n() {
    const i18nEl = this.querySelector('[data-pd-i18n]');
    if (!i18nEl) return;
    try {
      this.#i18n = JSON.parse(i18nEl.textContent || '{}');
    } catch (error) {
      console.warn('Personalization drawer: failed to parse translations', error);
      this.#i18n = {};
    }
  }

  /**
   * Get a translated UI label, with optional price interpolation.
   * @param {string} key
   * @param {string} [price] formatted money string to substitute for %%PRICE%%
   * @returns {string}
   */
  #t(key, price) {
    const value = this.#i18n[key] || '';
    return price != null ? value.replace('%%PRICE%%', price) : value;
  }
  
  /** @type {(event: MouseEvent) => void} */
  #boundHandleDialogClick = (event) => this.#handleDialogClick(event);

  /** @type {(event: Event) => void} */
  #boundHandleDialogCancel = (event) => this.#handleDialogCancel(event);

  connectedCallback() {
    super.connectedCallback();

    // Load translations emitted by Liquid for JS-rendered UI
    this.#loadI18n();

    // Storefront API token for addon/upgrade product fetches
    this.#storefrontToken = this.dataset.storefrontToken || '';

    // Bubble-phase delegated listener on document. preventDefault() in the
    // handler suppresses the form-submission default action that would
    // otherwise trigger the cart add — no capture-phase interception needed.
    document.addEventListener('click', this.#boundHandleGlobalClick);

    // Close button — ignored while an ATC request is in flight
    if (this.refs.closeButton) {
      this.refs.closeButton.addEventListener('click', () => {
        if (this.#isAddingToCart) return;
        this.close();
      });
    }

    // ATC button in footer
    if (this.refs.atcButton) {
      this.refs.atcButton.addEventListener('click', this.#boundHandleAddToCart);
    }

    // Setup tab switching
    this.#setupTabs();

    // Setup message options
    this.#setupMessageOptions();

    // Setup gift wrap selection
    this.#setupGiftWrap();

    // Setup collapsible sections
    this.#setupCollapsibles();

    // Setup Learn More sub-view toggle
    this.#setupLearnMore();

    // Setup Gift Message sub-view
    this.#setupGiftMessageView();

    // Setup Digital Card step
    this.#setupDigitalCard();

    // Setup Digital Card selection & compose sub-view
    this.#setupDigitalCardSubview();

    // Setup Greeting Card iframe sub-view
    this.#setupGreetingCardView();

  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.#boundHandleGlobalClick);
    this.refs.atcButton?.removeEventListener('click', this.#boundHandleAddToCart);
    window.removeEventListener('message', this.#boundHandlePrintibleMessage);

    if (this.#abortController) {
      this.#abortController.abort();
    }
  }

  /**
   * Intercepts ATC clicks globally
   * @param {MouseEvent} event
   */
  #handleGlobalClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);

    // Match ATC button on PDP / quick-add modal / collection product cards.
    // Product cards on collection pages wrap their button/link in [data-add-to-cart].
    const atcButton = target.closest(
      '[ref="addToCartButton"], .quick-add__button, add-to-cart-component [ref="addToCartButton"], [data-add-to-cart] button, [data-add-to-cart] a'
    );

    if (!atcButton) return;

    // Allow opt-out
    if (atcButton.closest('[data-skip-personalization]')) return;

    // Don't intercept clicks from within the drawer itself
    if (atcButton.closest('personalization-drawer')) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    // The theme's add-to-cart-component capture-phase handler already toggled
    // `data-added="true"` on the button for its "Added!" animation. Undo it so
    // the user doesn't see the success animation when the drawer opens instead.
    const realButton = atcButton.tagName === 'BUTTON' ? atcButton : atcButton.querySelector('button');
    if (realButton && realButton.dataset.added === 'true') {
      delete realButton.dataset.added;
    }

    this.#extractProductAndOpen(atcButton);
  }

  /**
   * Read `data-wrap-available` from the nearest ancestor that carries it
   * (the [data-add-to-cart] wrapper on cards, or <add-to-cart-component> on PDP).
   * @param {Element} button
   * @returns {boolean}
   */
  #readWrapAvailable(button) {
    const carrier = button.closest('[data-wrap-available]');
    if (!carrier) return false;
    return carrier.getAttribute('data-wrap-available') === 'true';
  }

  /**
   * Read `data-on-goody` from the nearest ancestor that carries it.
   * @param {Element} button
   * @returns {boolean}
   */
  #readIsOnGoody(button) {
    const carrier = button.closest('[data-on-goody]');
    if (!carrier) return false;
    return carrier.getAttribute('data-on-goody') === 'true';
  }

  /**
   * Read the marketplace product ID (EA product ID metafield) from the
   * nearest ancestor that carries it. Returns empty string if absent.
   * @param {Element} button
   * @returns {string}
   */
  #readMarketplaceProductId(button) {
    const carrier = button.closest('[data-marketplace-product-id]');
    if (!carrier) return '';
    return carrier.getAttribute('data-marketplace-product-id') || '';
  }

  /**
   * Hide the message step for on-goody products (they use digital cards instead).
   * @param {boolean} isOnGoody
   */
  #applyMessageVisibility(isOnGoody) {
    const step = this.querySelector('[data-pd-step="message"]');
    if (!step) return;
    step.style.display = isOnGoody ? 'none' : '';
    this.#renumberSteps();
  }

  /**
   * Show or hide the digital card step based on whether the product is on-goody.
   * @param {boolean} isOnGoody
   */
  #applyDigitalCardVisibility(isOnGoody) {
    this.#isOnGoody = isOnGoody;
    // Keep the "Please add a Digital Card" info banner tied to the step: it
    // only belongs on products that show the Digital Card step.
    const banner = this.querySelector('[data-dc-info-banner]');
    if (banner && !isOnGoody) banner.classList.add('pd-info-banner--hidden');
    const step = this.querySelector('[data-pd-step="digital-card"]');
    if (!step) return;
    step.style.display = isOnGoody ? '' : 'none';
    this.#renumberSteps();
  }

  /**
   * Read the current product's available gift-wrap products.
   * @param {Element} button
   * @returns {Array<{productId:number,variantId:number,handle:string,title:string,price:number,image:object|string|null}>}
   */
  #readGiftWraps(button) {
    const carrier = button.closest('[data-gift-wraps-json]');
    if (!carrier) return [];
    const raw = carrier.getAttribute('data-gift-wraps-json');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn('Personalization drawer: failed to parse gift wraps JSON', error);
      return [];
    }
  }

  /**
   * Read the per-variant addon/upgrade metafield map from the carrier element's
   * `data-addons-source` attribute. Shape: { "<variantId>": { upgrades: [...], addons: [...] } }
   * @param {Element} button
   * @returns {Record<string, { upgrades: Array, addons: Array }>}
   */
  #readAddonsSource(button) {
    const carrier = button.closest('[data-addons-source]');
    if (!carrier) return {};
    const raw = carrier.getAttribute('data-addons-source');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (error) {
      console.warn('Personalization drawer: failed to parse addons-source JSON', error);
      return {};
    }
  }

  /**
   * Render skeleton shimmer cards in the addon panels while the Storefront
   * API fetch is in flight.
   * @param {HTMLElement} tabsContainer
   * @param {HTMLElement} panelsContainer
   */
  #renderAddonSkeleton(tabsContainer, panelsContainer) {
    tabsContainer.innerHTML = '';
    panelsContainer.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'pd-addon-panel';
    const carousel = document.createElement('div');
    carousel.className = 'pd-addon-carousel';

    for (let i = 0; i < 3; i++) {
      const card = document.createElement('div');
      card.className = 'pd-addon-card';
      card.setAttribute('aria-hidden', 'true');
      card.innerHTML = `
        <div class="pd-addon-card__image-wrap pd-skeleton-shimmer"></div>
        <div class="pd-addon-card__info">
          <div class="pd-addon-card__details">
            <span class="pd-skeleton-shimmer pd-skeleton-line pd-skeleton-line--title"></span>
          </div>
          <span class="pd-skeleton-shimmer pd-skeleton-line" style="width:80px;height:28px;border-radius:24px;"></span>
        </div>
      `;
      carousel.appendChild(card);
    }

    panel.appendChild(carousel);
    panelsContainer.appendChild(panel);
  }

  /**
   * Fetch and render addon/upgrade products for the given variant using the
   * shared addons-source layer. Called from #selectVariant on every variant
   * change (including the initial auto-select).
   * @param {number} variantId
   */
  async #loadAddonsForVariant(variantId) {
    const loadId = ++this.#addonsLoadId;

    const step = this.querySelector('[data-pd-step="addons"]');
    if (!step) return;

    const tabsContainer = step.querySelector('[data-addon-tabs]');
    const panelsContainer = step.querySelector('[data-addon-panels]');
    if (!tabsContainer || !panelsContainer) return;

    // Clear previous selections
    this.#selectedAddons.clear();
    this.#addonProductIdByVariantId.clear();
    this.#addonTypeByVariantId.clear();

    // Look up raw metafield data for this variant
    const variantData = this.#addonsSourceMap[String(variantId)];
    if (!variantData) {
      tabsContainer.innerHTML = '';
      panelsContainer.innerHTML = '';
      step.style.display = 'none';
      this.#renumberSteps();
      return;
    }

    // Build ordered groups from raw metafield JSON (upgrades first)
    const groups = buildAddonGroups(variantData.upgrades, variantData.addons);
    if (groups.length === 0) {
      tabsContainer.innerHTML = '';
      panelsContainer.innerHTML = '';
      step.style.display = 'none';
      this.#renumberSteps();
      return;
    }

    // Show the step and render skeleton while fetching
    step.style.display = '';
    this.#renumberSteps();
    this.#renderAddonSkeleton(tabsContainer, panelsContainer);

    // Collect unique product GIDs and fetch live data via Storefront API
    const refs = collectRefs(groups);
    const products = await fetchAddonProducts(refs, { token: this.#storefrontToken });

    // Stale-response guard: if the variant changed during the fetch, discard
    if (loadId !== this.#addonsLoadId) return;

    // Resolve groups with hydrated product data (drops unavailable products)
    const resolved = resolveGroups(groups, products);
    this.#populateAddonsFromGroups(resolved);
  }

  /**
   * Render addon/upgrade tabs and panels from resolved groups returned by
   * the shared addons-source layer. Upgrades group appears first, followed
   * by each addon group in source order. Single-select groups carry a
   * `data-addon-single="true"` attribute and show a hint label.
   * @param {Array<{ type: string, name: string, single: boolean, products: Array }>} groups
   */
  #populateAddonsFromGroups(groups) {
    const step = this.querySelector('[data-pd-step="addons"]');
    if (!step) return;

    const tabsContainer = step.querySelector('[data-addon-tabs]');
    const panelsContainer = step.querySelector('[data-addon-panels]');
    if (!tabsContainer || !panelsContainer) return;

    tabsContainer.innerHTML = '';
    panelsContainer.innerHTML = '';
    this.#selectedAddons.clear();
    this.#addonProductIdByVariantId.clear();
    this.#addonTypeByVariantId.clear();

    if (!groups || groups.length === 0) {
      step.style.display = 'none';
      this.#renumberSteps();
      return;
    }
    step.style.display = '';

    let isFirst = true;
    for (const group of groups) {
      const tabId = `tab-${group.type}-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

      // Tab label: use i18n key for upgrades, group name for addons
      const tabLabel = group.type === 'upgrade'
        ? (this.#t('addonsUpgrades') || 'Upgrades')
        : (group.name || this.#t('addonsOther') || 'Other');

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'pd-tab' + (isFirst ? ' pd-tab--active' : '');
      tabBtn.setAttribute('data-addon-tab', tabId);
      tabBtn.textContent = tabLabel;
      tabsContainer.appendChild(tabBtn);

      const panel = document.createElement('div');
      panel.className = 'pd-addon-panel';
      panel.setAttribute('data-addon-panel', tabId);
      if (!isFirst) panel.style.display = 'none';

      // Single-select hint
      if (group.single) {
        const hint = document.createElement('p');
        hint.className = 'pd-addon-hint';
        hint.textContent = this.#t('addonsSelectOne') || 'Select one';
        panel.appendChild(hint);
      }

      const carousel = document.createElement('div');
      carousel.className = 'pd-addon-carousel';

      for (const product of group.products) {
        // Resolve to first available variant
        const variant = product.variants.find((v) => v.availableForSale) || product.variants[0];
        if (!variant) continue;

        // Extract numeric IDs from Storefront GID strings
        const numericVariantId = Number(String(variant.id).split('/').pop());
        const numericProductId = Number(String(product.id).split('/').pop());
        const price = variant.price; // already in cents from addons-source

        // Track maps for ATC tagging
        this.#addonProductIdByVariantId.set(numericVariantId, numericProductId);
        this.#addonTypeByVariantId.set(numericVariantId, group.type);

        const card = document.createElement('div');
        card.className = 'pd-addon-card';
        if (group.single) card.setAttribute('data-addon-single', 'true');

        const priceLabel = this.#t('addPrice', this.#formatMoney(price)) || `Add - ${this.#formatMoney(price)}`;
        const imageUrl = product.featuredImage?.url || '';
        const imageHtml = imageUrl
          ? `<img src="${this.#escapeHtml(imageUrl)}" alt="${this.#escapeHtml(product.title)}" width="64" height="64" loading="lazy" class="pd-addon-card__image">`
          : '';

        card.innerHTML = `
          <div class="pd-addon-card__image-wrap">${imageHtml}</div>
          <div class="pd-addon-card__info">
            <div class="pd-addon-card__details">
              <span class="pd-addon-card__title">${this.#escapeHtml(product.title)}</span>
            </div>
            <button
              type="button"
              class="pd-addon-btn"
              data-addon-variant-id="${numericVariantId}"
              data-addon-price="${price}"
            >${this.#escapeHtml(priceLabel)}</button>
          </div>
        `;
        carousel.appendChild(card);
      }

      panel.appendChild(carousel);
      panelsContainer.appendChild(panel);
      isFirst = false;
    }

    // Hide tab bar when there is only one group
    tabsContainer.style.display = groups.length <= 1 ? 'none' : '';

    this.#renumberSteps();
  }

  /**
   * Read pre-rendered per-variant delivery availability from the nearest
   * ancestor with `data-variants-json`. The /products/{handle}.js endpoint
   * does NOT include variant metafields, so this carrier is the only
   * reliable source for delivery badges on collection / home / search
   * pages where the section's global pre-rendered script is absent (or
   * is for a different product).
   * @param {Element} button
   * @returns {Record<number, { name: string, icon: string|null }|null>}
   */
  #readVariantDeliveryMap(button) {
    const carrier = button.closest('[data-variants-json]');
    if (!carrier) return {};
    const raw = carrier.getAttribute('data-variants-json');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return {};
      /** @type {Record<number, { name: string, icon: string|null }|null>} */
      const map = {};
      /** @type {Record<number, string>} */
      const mpVariantMap = {};
      for (const v of parsed) {
        if (v && typeof v.id === 'number') {
          map[v.id] = v.deliveryAvailability || null;
          if (v.marketplaceVariantId != null) {
            mpVariantMap[v.id] = String(v.marketplaceVariantId);
          }
        }
      }
      this.#marketplaceVariantIdMap = mpVariantMap;
      return map;
    } catch (error) {
      console.warn('Personalization drawer: failed to parse variants JSON', error);
      return {};
    }
  }

  /**
   * Show or hide the gift wrap step based on the current product's metafield.
   * @param {boolean} wrapAvailable
   */
  #applyGiftWrapVisibility(wrapAvailable) {
    this.#wrapAvailable = wrapAvailable;
    if (!wrapAvailable) {
      // Clear any previously selected wrap when the current product cannot use wraps.
      this.#selectedGiftWrapHandle = null;
      this.#selectedGiftWrapVariantId = null;
      this.#selectedGiftWrapProductId = null;
    }
    const step = this.querySelector('[data-pd-step="giftwrap"]');
    if (!step) return;
    step.style.display = wrapAvailable ? '' : 'none';
    this.#renumberSteps();
  }

  /**
   * Walk all step containers in document order and rewrite their number badges
   * so that visible steps are numbered 1..N sequentially. Hidden steps are
   * skipped, keeping the sequence correct regardless of which step is gated.
   */
  #renumberSteps() {
    const steps = this.querySelectorAll('.pd-step');
    let visibleIndex = 0;
    for (const step of steps) {
      if (step.style.display === 'none') continue;
      visibleIndex += 1;
      const numberEl = step.querySelector('.pd-step__number');
      if (numberEl) numberEl.textContent = String(visibleIndex);
    }
  }

  /**
   * Extract product handle from button context and open drawer
   * @param {Element} button
   */
  async #extractProductAndOpen(button) {
    let handle = null;

    // Populate and gate product-specific gift wraps before the drawer opens.
    const giftWraps = this.#readGiftWraps(button);
    this.#populateGiftWraps(giftWraps);
    this.#applyGiftWrapVisibility(this.#readWrapAvailable(button) && giftWraps.length > 0);

    // Show or hide steps based on on-goody flag
    const isOnGoody = this.#readIsOnGoody(button);
    this.#applyDigitalCardVisibility(isOnGoody);
    this.#applyMessageVisibility(isOnGoody);

    // Capture marketplace product ID for the digital card line-item properties
    this.#marketplaceProductId = this.#readMarketplaceProductId(button);

    // Read per-variant addon/upgrade metafield map from the carrier element.
    // Actual population happens in #loadAddonsForVariant, called from #selectVariant.
    this.#addonsSourceMap = this.#readAddonsSource(button);
    const addonsStep = this.querySelector('[data-pd-step="addons"]');
    if (addonsStep) addonsStep.style.display = 'none';

    // Stash per-variant delivery availability for this product so the
    // subsequent /products/{handle}.js fetch (which omits metafields)
    // can be merged with it.
    this.#pendingDeliveryMap = this.#readVariantDeliveryMap(button);

    // Try product form component first
    const productForm = button.closest('product-form-component');
    if (productForm) {
      const form = productForm.querySelector('form');
      if (form) {
        const action = form.getAttribute('action');
        if (action) {
          const match = action.match(/\/products\/([^/]+)/);
          if (match) handle = match[1];
        }
        const variantInput = form.querySelector('input[name="id"]');
        if (variantInput && variantInput.value) {
          this.#pendingVariantId = Number(variantInput.value) || null;
        }
      }
    }

    // Fallback: read the selected variant from the page's main product form
    // (covers sticky ATC and other buttons outside the form component)
    if (!this.#pendingVariantId) {
      const pageForm = document.querySelector('product-form-component form');
      if (pageForm) {
        const vi = pageForm.querySelector('input[name="id"]');
        if (vi && vi.value) {
          this.#pendingVariantId = Number(vi.value) || null;
        }
      }
    }

    // Final fallback: URL ?variant= param (PDP deep link)
    if (!this.#pendingVariantId) {
      const urlVariant = new URL(window.location.href).searchParams.get('variant');
      if (urlVariant) {
        this.#pendingVariantId = Number(urlVariant) || null;
      }
    }

    // Try product card link
    if (!handle) {
      const productCard = button.closest('[data-product-handle]');
      if (productCard) {
        handle = productCard.dataset.productHandle;
      }
    }

    // Try finding a product link nearby
    if (!handle) {
      const card = button.closest('.product-card, [class*="product"]');
      if (card) {
        const link = card.querySelector('a[href*="/products/"]');
        if (link) {
          const match = link.getAttribute('href').match(/\/products\/([^/?#]+)/);
          if (match) handle = match[1];
        }
      }
    }

    // Try from the page URL if on a product page
    if (!handle) {
      const match = window.location.pathname.match(/\/products\/([^/?#]+)/);
      if (match) handle = match[1];
    }

    if (!handle) return;

    // Open the drawer immediately with skeleton state, then fetch in the background
    this.#showSkeleton();
    this.open();

    await this.#fetchProductAndOpen(handle);
  }

  /**
   * Render skeleton placeholders while product data is loading
   */
  #showSkeleton() {
    // Clear previous product state
    this.#productData = null;
    this.#selectedVariantId = null;
    this.#selectedAddons.clear();
    this.#freeMessageVariantId = null;
    this.#paidGreetingCardVariantId = null;
    this.#giftMessageText = null;

    // Reset message card UI: deselect all, clear "added" state on all cards
    const messageCards = this.querySelectorAll('.pd-message-card');
    for (const c of messageCards) {
      c.classList.remove('pd-message-card--selected');
      c.classList.remove('pd-message-card--added');
      this.#toggleMessageCardState(c, 'add');
    }

    // Reset greeting card state
    this.#greetingCardData = null;
    this.#resetGreetingCardSubviewUi();

    // Reset digital card state
    this.#digitalCardAdded = false;
    this.#digitalCardChannel = 'text';
    this.#digitalCardRecipient = '';
    this.#digitalCardFrom = '';
    this.#digitalCardMessage = '';
    this.#digitalCardSelectedId = null;
    this.#digitalCardSelectedImage = null;
    this.#digitalCardSelectedLabel = null;
    this.#digitalCardOccasion = null;
    // Close the digital card subview DOM if it was open (AC17)
    this.#closeDigitalCardSubview();
    const dcStep = this.querySelector('[data-pd-step="digital-card"]');
    if (dcStep) {
      const dcExpanded = dcStep.querySelector('[data-dc-expanded]');
      const dcCardLabel = dcStep.querySelector('[data-dc-card-label]');
      const dcStateGroups = dcStep.querySelectorAll('[data-dc-state]');
      const dcInputs = dcStep.querySelectorAll('[data-dc-input]');
      const dcTabs = dcStep.querySelectorAll('[data-dc-tab]');
      const dcPanels = dcStep.querySelectorAll('[data-dc-panel]');

      if (dcExpanded) {
        dcExpanded.style.display = 'none';
        if (dcCardLabel) {
          dcCardLabel.textContent = dcExpanded.getAttribute('data-dc-card-label-default') || 'Add your card';
        }
      }
      for (const group of dcStateGroups) {
        group.style.display = group.getAttribute('data-dc-state') === 'add' ? '' : 'none';
      }
      for (const input of dcInputs) {
        input.value = '';
        input.classList.remove('pd-dc-input--filled', 'pd-dc-input--error');
      }
      for (const err of dcStep.querySelectorAll('[data-dc-error]')) {
        err.hidden = true;
      }
      // Reset to Text tab
      for (const t of dcTabs) {
        const isActive = t.getAttribute('data-dc-tab') === 'text';
        t.classList.toggle('pd-dc-tab--active', isActive);
        t.setAttribute('aria-selected', String(isActive));
      }
      for (const panel of dcPanels) {
        panel.style.display = panel.getAttribute('data-dc-panel') === 'text' ? '' : 'none';
      }
    }

    // Banner is shown only when the Digital Card step is visible (on-goody
    // products) AND the card is not yet added. On a fresh open the card is
    // never added yet, so the banner's visibility tracks #isOnGoody — it must
    // stay hidden on products that don't show the Digital Card step.
    const banner = this.querySelector('[data-dc-info-banner]');
    if (banner) banner.classList.toggle('pd-info-banner--hidden', !this.#isOnGoody);

    const container = this.refs.variantContainer;
    const step = this.refs.variantStep;

    if (step) step.style.display = '';

    // Show shimmer on the variant step title while loading
    const titleEl = this.querySelector('[data-variant-step-title]');
    if (titleEl) {
      titleEl.innerHTML = '<span class="pd-skeleton-shimmer pd-skeleton-line" style="display:inline-block;width:100px;height:14px;vertical-align:middle;"></span>';
    }

    this.#renumberSteps();

    if (container) {
      let skeletonHtml = '';
      for (let i = 0; i < 3; i++) {
        skeletonHtml += `
          <div class="pd-variant-card pd-variant-card--skeleton" aria-hidden="true">
            <div class="pd-variant-card__image-wrap pd-skeleton-shimmer"></div>
            <div class="pd-variant-card__content">
              <span class="pd-skeleton-shimmer pd-skeleton-line pd-skeleton-line--title"></span>
              <span class="pd-skeleton-shimmer pd-skeleton-line pd-skeleton-line--price"></span>
              <span class="pd-skeleton-shimmer pd-skeleton-line pd-skeleton-line--badge"></span>
            </div>
          </div>
        `;
      }
      container.innerHTML = skeletonHtml;
    }

    // Disable ATC and indicate loading
    if (this.refs.atcButton) {
      this.refs.atcButton.setAttribute('disabled', '');
    }
    if (this.refs.atcButtonText) {
      this.refs.atcButtonText.textContent = 'Loading…';
    }
  }

  /**
   * Fetch product data and open the drawer
   * @param {string} handle
   */
  async #fetchProductAndOpen(handle) {
    if (this.#abortController) {
      this.#abortController.abort();
    }

    this.#abortController = new AbortController();

    try {
      // Check for pre-rendered variant data
      const preRenderedScript = document.querySelector(
        `script[data-personalization-variant-data][data-product-id]`
      );

      let productData = null;

      // First try fetching from product.js API
      const response = await fetch(`/products/${handle}.js`, {
        signal: this.#abortController.signal,
      });

      if (!response.ok) {
        if (this.refs.atcButtonText) {
          this.refs.atcButtonText.textContent = 'Unable to load product';
        }
        return;
      }

      const productJs = await response.json();

      // Build product data from API response + pre-rendered delivery data.
      // Priority order:
      //   1. The per-product `data-variants-json` carrier on the clicked
      //      ATC button (works on every page — collection, home, search)
      //   2. The section-level `<script data-personalization-variant-data>`
      //      (only emitted on PDP, only for the current product)
      let deliveryMap = { ...this.#pendingDeliveryMap };
      if (Object.keys(deliveryMap).length === 0 && preRenderedScript) {
        try {
          const preData = JSON.parse(preRenderedScript.textContent);
          if (preData.productHandle === handle) {
            for (const v of preData.variants) {
              deliveryMap[v.id] = v.deliveryAvailability;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      productData = {
        productId: productJs.id,
        productTitle: productJs.title,
        productUrl: productJs.url,
        productHandle: productJs.handle,
        variantOptionName: (productJs.options && productJs.options[0] && (typeof productJs.options[0] === 'string' ? productJs.options[0] : productJs.options[0].name)) || '',
        variants: productJs.variants.map((/** @type {any} */ v) => ({
          id: v.id,
          title: v.title,
          price: v.price,
          compareAtPrice: v.compare_at_price || 0,
          available: v.available,
          image: v.featured_image?.src
            ? v.featured_image.src.replace(/(\.[a-z]+)(\?|$)/, '_200x$1$2')
            : (productJs.featured_image
              ? productJs.featured_image.replace(/(\.[a-z]+)(\?|$)/, '_200x$1$2')
              : null),
          deliveryAvailability: deliveryMap[v.id] || null,
        })),
      };

      this.#productData = productData;

      this.#populateVariants();
      this.#updatePrice();

      // Restore digital card state from cart (persistence across PD opens).
      this.#showDigitalCardShimmer(true);
      const dcShimmerStart = Date.now();
      if (this.#isOnGoody) {
        await this.#restoreDigitalCardFromCart();
      }
      const dcElapsed = Date.now() - dcShimmerStart;
      const dcRemaining = Math.max(0, 400 - dcElapsed);
      setTimeout(() => this.#showDigitalCardShimmer(false), dcRemaining);

      // Re-enable ATC button now that we have data — but route through the
      // gate so a mandatory (on-goody) digital card keeps the button disabled
      // until a card + recipient are provided.
      this.#updateAtcButtonState();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Personalization drawer: failed to fetch product', error);
        if (this.refs.atcButtonText) {
          this.refs.atcButtonText.textContent = 'Unable to load product';
        }
      }
      this.#showDigitalCardShimmer(false);
    }
  }

  /**
   * Check the cart for an existing digital card line item and restore the
   * drawer's DC state so the "added" UI with Edit/Remove persists across
   * PD opens.
   */
  async #restoreDigitalCardFromCart() {
    try {
      const cartRes = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!cartRes.ok) return;
      const cart = await cartRes.json();

      const dcLine = (cart.items || []).find(
        (item) =>
          item.properties &&
          item.properties[CART_PROPERTY_KEYS.itemType] === CART_ITEM_TYPES.digitalCard
      );
      if (!dcLine) return;

      const dcData = dcLine.properties[CART_PROPERTY_KEYS.digitalCardData];
      if (!dcData) return;

      // Restore internal state from the stored line-item properties.
      this.#digitalCardSelectedId = dcData.MPCardMessageID || null;
      this.#digitalCardSelectedImage = dcData.MPCardMessageUrl || null;
      this.#digitalCardFrom = dcData.MPCardSenderName || '';
      this.#digitalCardMessage = dcData.MPCardMessage || '';

      if (dcData.MPCardDeliveryMethod === DIGITAL_CARD_DELIVERY_METHODS.email) {
        this.#digitalCardChannel = 'email';
        this.#digitalCardRecipient = dcData.MPCardMessageEmail || '';
      } else {
        this.#digitalCardChannel = 'text';
        this.#digitalCardRecipient = dcData.MPCardMessageRecipientPhone || '';
      }

      // Restore the UI to "added" state.
      const step = this.querySelector('[data-pd-step="digital-card"]');
      if (!step) return;

      const expanded = step.querySelector('[data-dc-expanded]');
      const defaultLabel = expanded?.getAttribute('data-dc-card-label-default') || 'Add your card';
      const activeLabel = expanded?.getAttribute('data-dc-card-label-active') || 'Edit your card';
      this.#setDigitalCardAdded(step, true, { defaultLabel, activeLabel });

      // Restore the delivery channel tab selection.
      for (const tab of step.querySelectorAll('[data-dc-tab]')) {
        const isActive = tab.getAttribute('data-dc-tab') === this.#digitalCardChannel;
        tab.classList.toggle('pd-dc-tab--active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
      }
      for (const panel of step.querySelectorAll('[data-dc-panel]')) {
        panel.style.display =
          panel.getAttribute('data-dc-panel') === this.#digitalCardChannel ? '' : 'none';
      }

      // Pre-fill the recipient input for the active channel.
      const activeInput = step.querySelector(
        `[data-dc-input="${this.#digitalCardChannel}"]`
      );
      if (activeInput) {
        activeInput.value = this.#digitalCardRecipient;
        if (this.#digitalCardRecipient) {
          activeInput.classList.add('pd-dc-input--filled');
        }
      }
    } catch (error) {
      console.warn('Personalization drawer: failed to restore digital card from cart', error);
    }
  }

  /**
   * Populate variant cards in the variant-selector step
   */
  #populateVariants() {
    if (!this.#productData) return;

    const container = this.refs.variantContainer;
    const step = this.refs.variantStep;
    if (!container) return;

    const { variants } = this.#productData;

    // Hide variant step if only one variant
    if (step && variants.length <= 1) {
      step.style.display = 'none';
    } else if (step) {
      step.style.display = '';
    }
    this.#renumberSteps();

    container.innerHTML = '';

    for (const variant of variants) {
      const card = document.createElement('div');
      card.className = 'pd-variant-card';
      card.dataset.variantId = String(variant.id);

      if (!variant.available) {
        card.classList.add('pd-variant-card--unavailable');
      }

      let badgeHtml = '';
      if (variant.deliveryAvailability && variant.deliveryAvailability.name) {
        const da = variant.deliveryAvailability;
        const iconHtml = da.icon
          ? `<img
              src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
              alt="${da.name}"
              width="16"
              height="16"
              style="--mask-image-url: url('${da.icon}')"
              class="pd-badge__icon"
            >`
          : '';
        badgeHtml = `
          <div class="pd-badge">
            ${iconHtml}
            <span class="pd-badge__text">${da.name}</span>
          </div>
        `;
      }

      const imageHtml = variant.image
        ? `<div class="pd-variant-card__image-wrap">
            <img src="${variant.image}" alt="${variant.title}" width="64" height="64" loading="lazy" class="pd-variant-card__image">
          </div>`
        : `<div class="pd-variant-card__image-wrap pd-variant-card__image-wrap--empty"></div>`;

      card.innerHTML = `
        ${imageHtml}
        <div class="pd-variant-card__content">
          <span class="pd-variant-card__title">${variant.title}</span>
          <span class="pd-variant-card__price">${this.#formatMoney(variant.price)}</span>
          ${badgeHtml}
        </div>
      `;

      card.addEventListener('click', () => {
        if (!variant.available) return;
        this.#selectVariant(variant.id);
      });

      container.appendChild(card);
    }

    // Replace <product-option> placeholder in step title with real option name
    const titleEl = this.querySelector('[data-variant-step-title]');
    if (titleEl) {
      const template = titleEl.getAttribute('data-variant-step-template') || '';
      const optName = this.#productData.variantOptionName || '';
      titleEl.textContent = template.replace('{product-option}', optName);
    }

    // Auto-select: prefer the variant chosen on the PDP, fall back to first available
    const pending = this.#pendingVariantId;
    this.#pendingVariantId = null;
    const preferred = pending
      ? variants.find((v) => v.id === pending && v.available)
      : null;
    const toSelect = preferred || variants.find((v) => v.available);
    if (toSelect) {
      this.#selectVariant(toSelect.id);
    }
  }

  /**
   * Select a variant by ID
   * @param {number} variantId
   */
  #selectVariant(variantId) {
    this.#selectedVariantId = variantId;

    let selectedCard = null;
    const cards = this.querySelectorAll('.pd-variant-card');
    for (const card of cards) {
      const isSelected = card.dataset.variantId === String(variantId);
      card.classList.toggle('pd-variant-card--selected', isSelected);
      if (isSelected) selectedCard = card;
    }

    if (selectedCard) {
      selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    this.#updatePrice();
    this.#loadAddonsForVariant(variantId);
  }

  /**
   * Setup tab switching for gift add-ons (delegated — handlers attach to
   * containers since tabs/cards are rendered dynamically per product).
   */
  #setupTabs() {
    const step = this.querySelector('[data-pd-step="addons"]');
    if (!step) return;

    const tabsContainer = step.querySelector('[data-addon-tabs]');
    const panelsContainer = step.querySelector('[data-addon-panels]');

    if (tabsContainer) {
      tabsContainer.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-addon-tab]');
        if (!tab) return;
        const tabId = tab.getAttribute('data-addon-tab');
        for (const t of tabsContainer.querySelectorAll('[data-addon-tab]')) {
          t.classList.toggle('pd-tab--active', t.getAttribute('data-addon-tab') === tabId);
        }
        if (panelsContainer) {
          for (const p of panelsContainer.querySelectorAll('[data-addon-panel]')) {
            p.style.display = p.getAttribute('data-addon-panel') === tabId ? '' : 'none';
          }
        }
      });
    }

    if (panelsContainer) {
      panelsContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-addon-variant-id]');
        if (!btn) return;

        const variantId = Number(btn.getAttribute('data-addon-variant-id'));
        const price = Number(btn.getAttribute('data-addon-price') || 0);
        const isSingle = btn.closest('[data-addon-single="true"]') !== null;

        if (this.#selectedAddons.has(variantId)) {
          this.#selectedAddons.delete(variantId);
          btn.classList.remove('pd-addon-btn--added');
          btn.textContent = this.#t('addPrice', this.#formatMoney(price)) || `Add - ${this.#formatMoney(price)}`;
        } else {
          // Single-select group: deselect any previously selected sibling
          // in the same panel before selecting the new one.
          if (isSingle) {
            const panel = btn.closest('[data-addon-panel]');
            if (panel) {
              for (const siblingBtn of panel.querySelectorAll('[data-addon-variant-id].pd-addon-btn--added')) {
                const sibId = Number(siblingBtn.getAttribute('data-addon-variant-id'));
                this.#selectedAddons.delete(sibId);
                siblingBtn.classList.remove('pd-addon-btn--added');
                const sibPrice = Number(siblingBtn.getAttribute('data-addon-price') || 0);
                siblingBtn.textContent = this.#t('addPrice', this.#formatMoney(sibPrice)) || `Add - ${this.#formatMoney(sibPrice)}`;
              }
            }
          }
          this.#selectedAddons.add(variantId);
          btn.classList.add('pd-addon-btn--added');
          btn.textContent = this.#t('addonsAdded') || 'Added ✓';
        }
        this.#updatePrice();
      });
    }
  }

  /**
   * Render add-on tabs and panels from a pre-rendered list of add-on products.
   * Groups by each product's `categories` (`ediblearrangement.category`
   * metafield), preserving the order categories are first encountered.
   * Hides the entire step if the list is empty.
   * @param {Array<{id:number,handle:string,title:string,price:number,available:boolean,image:string|null,categories:string[]|string}>} addOns
   */
  #populateAddons(addOns) {
    const step = this.querySelector('[data-pd-step="addons"]');
    if (!step) return;

    const tabsContainer = step.querySelector('[data-addon-tabs]');
    const panelsContainer = step.querySelector('[data-addon-panels]');
    if (!tabsContainer || !panelsContainer) return;

    tabsContainer.innerHTML = '';
    panelsContainer.innerHTML = '';
    this.#selectedAddons.clear();
    this.#addonProductIdByVariantId.clear();

    if (!addOns || addOns.length === 0) {
      step.style.display = 'none';
      this.#renumberSteps();
      return;
    }
    step.style.display = '';

    // Build variant→product ID map so we can populate `addon_ids` on the
    // parent line item at cart-add time (variant ID is what the cart API
    // accepts, but the link to the parent is expressed in product IDs).
    for (const addon of addOns) {
      if (addon && typeof addon.id === 'number' && typeof addon.productId === 'number') {
        this.#addonProductIdByVariantId.set(addon.id, addon.productId);
      }
    }

    // Group by category, preserving first-encounter order. Products with no
    // category fall into "Other". Products with multiple categories appear
    // under each.
    const groups = new Map();
    for (const addon of addOns) {
      let cats = addon.categories;
      if (!Array.isArray(cats)) cats = cats ? [cats] : [];
      if (cats.length === 0) cats = [this.#t('addonsOther') || 'Other'];
      for (const cat of cats) {
        const key = String(cat).trim();
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(addon);
      }
    }

    if (groups.size === 0) {
      step.style.display = 'none';
      this.#renumberSteps();
      return;
    }

    let isFirst = true;
    for (const [category, items] of groups) {
      const tabId = `tab-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'pd-tab' + (isFirst ? ' pd-tab--active' : '');
      tabBtn.setAttribute('data-addon-tab', tabId);
      tabBtn.textContent = category;
      tabsContainer.appendChild(tabBtn);

      const panel = document.createElement('div');
      panel.className = 'pd-addon-panel';
      panel.setAttribute('data-addon-panel', tabId);
      if (!isFirst) panel.style.display = 'none';

      const carousel = document.createElement('div');
      carousel.className = 'pd-addon-carousel';

      for (const addon of items) {
        const card = document.createElement('div');
        card.className = 'pd-addon-card';

        const priceLabel = this.#t('addPrice', this.#formatMoney(addon.price)) || `Add - ${this.#formatMoney(addon.price)}`;
        const imageHtml = addon.image
          ? `<img src="${addon.image}" alt="${this.#escapeHtml(addon.title)}" width="64" height="64" loading="lazy" class="pd-addon-card__image">`
          : '';

        card.innerHTML = `
          <div class="pd-addon-card__image-wrap">${imageHtml}</div>
          <div class="pd-addon-card__info">
            <div class="pd-addon-card__details">
              <span class="pd-addon-card__title">${this.#escapeHtml(addon.title)}</span>
            </div>
            <button
              type="button"
              class="pd-addon-btn"
              data-addon-variant-id="${addon.id}"
              data-addon-price="${addon.price}"
            >${this.#escapeHtml(priceLabel)}</button>
          </div>
        `;
        carousel.appendChild(card);
      }

      panel.appendChild(carousel);
      panelsContainer.appendChild(panel);
      isFirst = false;
    }

    this.#renumberSteps();
  }

  /**
   * Minimal HTML-escape for text written into innerHTML.
   * @param {string} str
   * @returns {string}
   */
  #escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Setup message option selection
   */
  #setupMessageOptions() {
    const messageButtons = this.querySelectorAll('[data-message-variant-id]');

    for (const btn of messageButtons) {
      const isFreeBtn = btn.classList.contains('pd-message-btn--free');

      btn.addEventListener('click', () => {
        // If this is the free message button, open the gift message sub-view
        if (isFreeBtn) {
          this.#openGiftMessageView();
          return;
        }

        // Paid button — open greeting card iframe sub-view
        this.#openGreetingCardView(btn);
      });
    }

    // Wire up Remove / Edit actions on the free card's "added" state
    const removeButtons = this.querySelectorAll('[data-gift-message-action="remove"]');
    for (const btn of removeButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#handleRemoveGiftMessage();
      });
    }

    const editButtons = this.querySelectorAll('[data-gift-message-action="edit"]');
    for (const btn of editButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#handleEditGiftMessage();
      });
    }
  }

  /**
   * Setup gift wrap selection
   */
  #setupGiftWrap() {
    const carousel = this.querySelector('.pd-wrap-carousel');
    if (!carousel) return;

    carousel.addEventListener('click', (event) => {
      const card = event.target.closest('[data-gift-wrap-handle]');
      if (card) this.#selectGiftWrap(card);
    });
  }

  /**
   * Render product-specific gift wraps from the clicked product's metafield.
   * @param {Array<{productId:number,variantId:number,handle:string,title:string,price:number,image:object|string|null}>} giftWraps
   */
  #populateGiftWraps(giftWraps) {
    const carousel = this.querySelector('.pd-wrap-carousel');
    if (!carousel) return;

    this.#selectedGiftWrapHandle = null;
    this.#selectedGiftWrapVariantId = null;
    this.#selectedGiftWrapProductId = null;

    carousel.innerHTML = giftWraps
      .map((giftWrap, index) => {
        const handle = this.#escapeHtml(giftWrap.handle);
        const title = this.#escapeHtml(giftWrap.title);
        const imageUrl =
          typeof giftWrap.image === 'string'
            ? giftWrap.image
            : giftWrap.image?.src || giftWrap.image?.url || '';
        const image = imageUrl
          ? `<img src="${this.#escapeHtml(imageUrl)}" alt="${title}" width="75" height="75" loading="lazy" class="pd-wrap-card__image">`
          : '<div class="pd-wrap-card__image pd-wrap-card__image--placeholder"></div>';

        return `
          <div
            class="pd-wrap-card${index === 0 ? ' pd-wrap-card--selected' : ''}"
            data-gift-wrap-handle="${handle}"
            data-gift-wrap-product-id="${giftWrap.productId}"
            data-gift-wrap-variant-id="${giftWrap.variantId}"
          >
            ${image}
            <span class="pd-wrap-card__label">${title}</span>
          </div>
        `;
      })
      .join('');

    const firstWrapCard = carousel.querySelector('[data-gift-wrap-handle]');
    if (firstWrapCard) this.#selectGiftWrap(firstWrapCard);
  }

  /**
   * Select a gift wrap card
   * @param {Element} card
   */
  #selectGiftWrap(card) {
    const handle = card.getAttribute('data-gift-wrap-handle');
    this.#selectedGiftWrapHandle = handle;

    const variantIdAttr = card.getAttribute('data-gift-wrap-variant-id');
    const productIdAttr = card.getAttribute('data-gift-wrap-product-id');
    this.#selectedGiftWrapVariantId = variantIdAttr ? Number(variantIdAttr) : null;
    this.#selectedGiftWrapProductId = productIdAttr ? Number(productIdAttr) : null;

    const allCards = this.querySelectorAll('[data-gift-wrap-handle]');
    for (const c of allCards) {
      const isSelected = c.getAttribute('data-gift-wrap-handle') === handle;
      c.classList.toggle('pd-wrap-card--selected', isSelected);
    }
  }

  /**
   * Setup digital card step (Add/Remove/Edit + tab switching + input validation)
   */
  #setupDigitalCard() {
    const step = this.querySelector('[data-pd-step="digital-card"]');
    if (!step) return;

    this.#digitalCardVariantId = Number(step.getAttribute('data-dc-variant-id')) || null;

    const addBtn = step.querySelector('[data-dc-add]');
    const removeBtn = step.querySelector('[data-dc-remove]');
    const editBtn = step.querySelector('[data-dc-edit]');
    const expanded = step.querySelector('[data-dc-expanded]');
    const cardLabel = step.querySelector('[data-dc-card-label]');
    const tabs = step.querySelectorAll('[data-dc-tab]');
    const panels = step.querySelectorAll('[data-dc-panel]');
    const inputs = step.querySelectorAll('[data-dc-input]');

    const defaultLabel = expanded?.getAttribute('data-dc-card-label-default') || 'Add your card';
    const activeLabel = expanded?.getAttribute('data-dc-card-label-active') || 'Edit your card';

    // Add button → open the card selection sub-view
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.#openDigitalCardSubview();
      });
    }

    // Remove button → reset all digital card state (AC18)
    if (removeBtn) {
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#digitalCardRecipient = '';
        this.#digitalCardFrom = '';
        this.#digitalCardMessage = '';
        this.#digitalCardSelectedId = null;
        this.#digitalCardSelectedImage = null;
        this.#digitalCardSelectedLabel = null;
        this.#digitalCardOccasion = null;
        for (const input of inputs) {
          input.value = '';
          input.classList.remove('pd-dc-input--filled', 'pd-dc-input--error');
        }
        this.#clearDigitalCardErrors(step);
        // Reset compose form inputs in the subview
        const subview = this.querySelector('[data-digital-card-view]');
        if (subview) {
          const fromInput = subview.querySelector('[data-dcv-from-input]');
          const messageInput = subview.querySelector('[data-dcv-message-input]');
          const counterEl = subview.querySelector('[data-dcv-counter]');
          const submitBtnEl = subview.querySelector('[data-dcv-submit]');
          if (fromInput) {
            fromInput.value = '';
            fromInput.classList.remove('pd-dc-input--filled');
          }
          if (messageInput) {
            messageInput.value = '';
            messageInput.classList.remove('pd-gm-textarea--filled');
          }
          if (counterEl) counterEl.textContent = '0/1000';
          if (submitBtnEl) {
            submitBtnEl.setAttribute('disabled', '');
            submitBtnEl.classList.add('pd-gm-btn--disabled');
          }
          // Reset the occasion dropdown in the subview
          const occasionLabel = subview.querySelector('[data-dc-occasion-label]');
          const occasionValue = subview.querySelector('[data-dc-occasion-value]');
          const occasionTrigger = subview.querySelector('[data-dc-occasion-trigger]');
          if (occasionLabel) occasionLabel.style.fontSize = '';
          if (occasionValue) { occasionValue.style.display = 'none'; occasionValue.textContent = ''; }
          if (occasionTrigger) occasionTrigger.classList.remove('pd-gm-field__select--filled');
        }
        this.#setDigitalCardAdded(step, false, { defaultLabel, activeLabel });
        this.#updateAtcButtonState();
        this.#removePersonalizationFromCart({ itemType: CART_ITEM_TYPES.digitalCard });
      });
    }

    // Edit button → re-open compose form with existing selection
    if (editBtn) {
      editBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.#digitalCardSelectedId) {
          this.#showDigitalCardCompose();
        } else {
          this.#openDigitalCardSubview();
        }
      });
    }

    // Tab switching
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const channel = tab.getAttribute('data-dc-tab');
        if (!channel) return;
        this.#digitalCardChannel = /** @type {'text'|'email'} */ (channel);

        for (const t of tabs) {
          const isActive = t.getAttribute('data-dc-tab') === channel;
          t.classList.toggle('pd-dc-tab--active', isActive);
          t.setAttribute('aria-selected', String(isActive));
        }
        for (const panel of panels) {
          const isActive = panel.getAttribute('data-dc-panel') === channel;
          panel.style.display = isActive ? '' : 'none';
        }
        // Carry the active input's value forward to keep state in sync
        const activeInput = step.querySelector(`[data-dc-input="${channel}"]`);
        if (activeInput) {
          this.#digitalCardRecipient = activeInput.value.trim();
        }
        // Clear any stale error from the previously-active tab.
        this.#clearDigitalCardErrors(step);
        this.#updateAtcButtonState();
      });
    }

    // Input handling — store value, validation styling, ATC gating.
    for (const input of inputs) {
      input.addEventListener('input', () => {
        const channel = input.getAttribute('data-dc-input');
        if (channel === 'text') {
          input.value = input.value.replace(/[^0-9+\-() ]/g, '');
        }
        const value = input.value.trim();
        if (channel === this.#digitalCardChannel) {
          this.#digitalCardRecipient = value;
        }
        input.classList.toggle('pd-dc-input--filled', value.length > 0);
        // Clear the error while actively typing; it is re-checked on blur.
        input.classList.remove('pd-dc-input--error');
        this.#setDigitalCardError(step, channel, false);
        this.#updateAtcButtonState();
      });

      // Validate format on blur — flag a non-empty but malformed value.
      input.addEventListener('blur', () => {
        const value = input.value.trim();
        const channel = input.getAttribute('data-dc-input');
        const invalid = value.length > 0 && !this.#isDigitalCardRecipientValid(channel, value);
        input.classList.toggle('pd-dc-input--error', invalid);
        this.#setDigitalCardError(step, channel, invalid);
      });
    }
  }

  /**
   * Basic format validation for the digital card recipient.
   * @param {string|null} channel 'text' (phone) or 'email'
   * @param {string} value
   * @returns {boolean}
   */
  #isDigitalCardRecipientValid(channel, value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    if (channel === 'email') {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    }
    // Phone — require 10–15 digits, ignoring formatting characters.
    const digits = trimmed.replace(/\D/g, '').length;
    return digits >= 10 && digits <= 15;
  }

  /**
   * Show or hide the inline error message for a digital card channel input.
   * @param {Element} step
   * @param {string|null} channel
   * @param {boolean} show
   */
  #setDigitalCardError(step, channel, show) {
    if (!channel) return;
    const errorEl = step.querySelector(`[data-dc-error="${channel}"]`);
    if (errorEl) errorEl.hidden = !show;
  }

  /**
   * Clear all digital card input error states (border + inline message).
   * @param {Element} step
   */
  #clearDigitalCardErrors(step) {
    for (const input of step.querySelectorAll('[data-dc-input]')) {
      input.classList.remove('pd-dc-input--error');
    }
    for (const err of step.querySelectorAll('[data-dc-error]')) {
      err.hidden = true;
    }
  }

  /**
   * Toggle digital card "added" state
   * @param {Element} step
   * @param {boolean} added
   * @param {{ defaultLabel: string, activeLabel: string }} labels
   */
  #setDigitalCardAdded(step, added, labels) {
    this.#digitalCardAdded = added;

    const expanded = step.querySelector('[data-dc-expanded]');
    const cardLabel = step.querySelector('[data-dc-card-label]');
    const stateGroups = step.querySelectorAll('[data-dc-state]');

    for (const group of stateGroups) {
      const matches = group.getAttribute('data-dc-state') === (added ? 'added' : 'add');
      group.style.display = matches ? '' : 'none';
    }

    if (expanded) {
      expanded.style.display = added ? 'flex' : 'none';
    }

    if (cardLabel) {
      cardLabel.textContent = added ? labels.activeLabel : labels.defaultLabel;
    }

    // Toggle the info banner — visible only when the card is NOT yet added
    const banner = this.querySelector('[data-dc-info-banner]');
    if (banner) {
      banner.classList.toggle('pd-info-banner--hidden', added);
    }

    // Re-evaluate the main ATC button state (AC11)
    this.#updateAtcButtonState();
  }

  /**
   * Gate the main ATC footer button. When the digital card step is visible
   * (on-goody product) a digital card is MANDATORY: the customer must both
   * add a card AND provide a recipient (text/email from Step 5) before they
   * can add the product to the cart. The "Please add a Digital Card to
   * continue to checkout" info banner communicates this requirement.
   */
  #updateAtcButtonState() {
    const button = this.refs.atcButton;
    if (!button) return;

    // When the digital card step is visible, require a fully-completed card:
    // a card added AND a validly-formatted recipient (phone or email).
    if (this.#isOnGoody) {
      const recipientValid = this.#isDigitalCardRecipientValid(
        this.#digitalCardChannel,
        this.#digitalCardRecipient
      );
      if (!this.#digitalCardAdded || !recipientValid) {
        button.setAttribute('disabled', '');
        return;
      }
    }

    // Otherwise, re-enable (unless we're still loading product data)
    if (this.#productData) {
      button.removeAttribute('disabled');
    }
  }

  /**
   * Fetch digital card categories from the external API.
   * Caches the result so subsequent opens skip the network call.
   * @returns {Promise<Array>}
   */
  async #fetchDigitalCards() {
    if (this.#digitalCardCardsData) return this.#digitalCardCardsData;

    const loadingEl = this.querySelector('[data-dcv-grid-loading]');
    const tilesEl = this.querySelector('[data-dcv-grid-tiles]');
    if (loadingEl) loadingEl.style.display = '';
    if (tilesEl) tilesEl.innerHTML = '';

    try {
      const res = await fetch(
        'https://www.ediblearrangements.com/api/marketplace/catalog/integrations/goody/cards/category',
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.#digitalCardCardsData = Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('Personalization drawer: failed to fetch digital cards', error);
      this.#digitalCardCardsData = [];
    } finally {
      if (loadingEl) loadingEl.style.display = 'none';
    }

    return this.#digitalCardCardsData;
  }

  /**
   * Fetch occasions from the EA arrangement-group endpoint. Single in-flight
   * request shared across callers; cached for the life of the component.
   * Used by BOTH the complimentary gift-message subview AND the paid greeting
   * card subview.
   * @returns {Promise<Array<{id: number, name: string}>>}
   */
  async #fetchOccasions() {
    if (this.#occasionsData) return this.#occasionsData;
    if (this.#occasionsPromise) return this.#occasionsPromise;

    this.#occasionsPromise = (async () => {
      try {
        const res = await fetch(
          'https://www.ediblearrangements.com/api/arrangement-group/occasions?target=1',
          { headers: { Accept: 'application/json' } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.#occasionsData = Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('Personalization drawer: failed to fetch occasions', error);
        this.#occasionsData = [];
      }
      return this.#occasionsData;
    })();

    return this.#occasionsPromise;
  }

  /**
   * Fill the gift-message occasion dropdown from the API.
   * Idempotent: re-running clears and re-renders the list.
   * - gm items carry `data-gm-occasion="<name>"` (name is the AI generator query param)
   */
  async #populateOccasionDropdowns() {
    const occasions = await this.#fetchOccasions();

    const gmList = this.querySelector('[data-gm-dropdown-list]');
    if (gmList) {
      gmList.innerHTML = '';
      for (const o of occasions) {
        if (!o || !o.name) continue;
        const li = document.createElement('li');
        li.className = 'pd-gm-dropdown-item';
        li.setAttribute('data-gm-occasion', String(o.name));
        li.setAttribute('role', 'option');
        li.textContent = String(o.name);
        gmList.appendChild(li);
      }
    }
  }

  /**
   * Collect every unique card across all categories, deduped by id.
   * API shape: [{ categoryName, items: [{ id, imageUrl, imageThumbUrl, ocassion, ocassions[] }] }].
   * A single card can appear in multiple categories — dedupe by id.
   * @returns {Array}
   */
  #collectAllDigitalCards() {
    if (!Array.isArray(this.#digitalCardCardsData)) return [];
    const out = [];
    const seen = new Set();
    for (const category of this.#digitalCardCardsData) {
      const items = Array.isArray(category.items) ? category.items : [];
      for (const item of items) {
        const key = item.id != null ? String(item.id) : (item.imageUrl || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Populate the occasion dropdown from items[].ocassion (singular), deduped & sorted.
   */
  #populateOccasionDropdown() {
    const list = this.querySelector('[data-dc-occasion-list]');
    if (!list || !Array.isArray(this.#digitalCardCardsData)) return;

    list.innerHTML = '';
    const seen = new Set();
    for (const category of this.#digitalCardCardsData) {
      const items = Array.isArray(category.items) ? category.items : [];
      for (const item of items) {
        const name = item.ocassion || item.occasion || '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
      }
    }

    const names = Array.from(seen).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const li = document.createElement('li');
      li.className = 'pd-gm-dropdown-item';
      li.setAttribute('data-dc-occasion-item', name);
      li.setAttribute('role', 'option');
      li.textContent = name;
      list.appendChild(li);
    }
  }

  /**
   * Render the card tile grid. When `occasion` is falsy, renders every card
   * across all categories (deduped by id). Otherwise filters to cards whose
   * primary `ocassion` matches OR whose `ocassions` array includes it.
   * @param {string} [occasion]
   */
  #renderDigitalCardGrid(occasion) {
    const tilesEl = this.querySelector('[data-dcv-grid-tiles]');
    const template = this.querySelector('[data-dcv-card-tile-template]');
    if (!tilesEl || !template || !Array.isArray(this.#digitalCardCardsData)) return;

    tilesEl.innerHTML = '';

    const all = this.#collectAllDigitalCards();
    const cards = occasion
      ? all.filter((item) => {
          if (item.ocassion === occasion || item.occasion === occasion) return true;
          if (Array.isArray(item.ocassions) && item.ocassions.includes(occasion)) return true;
          if (Array.isArray(item.occasions) && item.occasions.includes(occasion)) return true;
          return false;
        })
      : all;

    for (const card of cards) {
      const fragment = template.content.cloneNode(true);
      const tile = fragment.querySelector('.pd-dc-card-tile');
      const img = fragment.querySelector('.pd-dc-card-tile__image');
      const label = fragment.querySelector('.pd-dc-card-tile__label');
      if (!tile || !img || !label) continue;

      const fullImage = card.imageUrl || card.image || '';
      const thumbImage = card.imageThumbUrl || fullImage;
      const labelText = card.ocassion || card.occasion || '';
      const ariaLabel = card.name || card.label || labelText || 'Digital card';

      if (card.id != null && String(card.id) === this.#digitalCardSelectedId) {
        tile.classList.add('pd-dc-card-tile--selected');
      }
      tile.setAttribute('data-dcv-card-id', String(card.id ?? ''));
      tile.setAttribute('data-dcv-card-image', fullImage);
      tile.setAttribute('data-dcv-card-label', ariaLabel);
      tile.setAttribute('aria-label', ariaLabel);

      img.src = thumbImage;
      img.alt = ariaLabel;

      label.textContent = labelText;

      tilesEl.appendChild(fragment);
    }
  }

  /**
   * Open the digital card selection sub-view (Step 2).
   */
  async #openDigitalCardSubview() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-digital-card-view]');
    if (!drawer || !subview) return;

    // Close other sub-views to prevent stacking
    const learnMoreView = this.querySelector('[data-learn-more-view]');
    if (learnMoreView) learnMoreView.setAttribute('aria-hidden', 'true');
    const giftMessageView = this.querySelector('[data-gift-message-view]');
    if (giftMessageView) giftMessageView.setAttribute('aria-hidden', 'true');
    this.#giftMessageSubviewOpen = false;
    const greetingCardView = this.querySelector('[data-greeting-card-view]');
    if (greetingCardView) greetingCardView.setAttribute('aria-hidden', 'true');
    this.#greetingCardSubviewOpen = false;

    this.#digitalCardSubviewOpen = true;
    subview.setAttribute('aria-hidden', 'false');
    drawer.classList.add('pd-drawer--subview-open');

    // Show card selection view, hide compose
    const selectView = subview.querySelector('[data-dcv-select]');
    const composeView = subview.querySelector('[data-dcv-compose]');
    if (selectView) selectView.style.display = '';
    if (composeView) composeView.style.display = 'none';

    // Fetch cards and populate dropdown
    await this.#fetchDigitalCards();
    this.#populateOccasionDropdown();

    // Render the grid: filtered by previously-selected occasion, otherwise all cards
    this.#renderDigitalCardGrid(this.#digitalCardOccasion);
  }

  /**
   * Close the digital card sub-view.
   */
  #closeDigitalCardSubview() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-digital-card-view]');
    if (!drawer || !subview) return;

    this.#digitalCardSubviewOpen = false;
    subview.setAttribute('aria-hidden', 'true');
    drawer.classList.remove('pd-drawer--subview-open');
  }

  /**
   * Show the compose form (Steps 3 & 4) with the selected card preview.
   */
  #showDigitalCardCompose() {
    const subview = this.querySelector('[data-digital-card-view]');
    if (!subview) return;

    // If subview isn't open yet, open it
    if (!this.#digitalCardSubviewOpen) {
      const drawer = this.refs.drawer;
      if (drawer) {
        // Close other sub-views
        const learnMoreView = this.querySelector('[data-learn-more-view]');
        if (learnMoreView) learnMoreView.setAttribute('aria-hidden', 'true');
        const giftMessageView = this.querySelector('[data-gift-message-view]');
        if (giftMessageView) giftMessageView.setAttribute('aria-hidden', 'true');
        this.#giftMessageSubviewOpen = false;
        const greetingCardView = this.querySelector('[data-greeting-card-view]');
        if (greetingCardView) greetingCardView.setAttribute('aria-hidden', 'true');
        this.#greetingCardSubviewOpen = false;

        this.#digitalCardSubviewOpen = true;
        subview.setAttribute('aria-hidden', 'false');
        drawer.classList.add('pd-drawer--subview-open');
      }
    }

    // Switch internal views
    const selectView = subview.querySelector('[data-dcv-select]');
    const composeView = subview.querySelector('[data-dcv-compose]');
    if (selectView) selectView.style.display = 'none';
    if (composeView) composeView.style.display = '';

    // Populate preview image
    const previewImg = subview.querySelector('[data-dcv-preview-image]');
    if (previewImg && this.#digitalCardSelectedImage) {
      previewImg.src = this.#digitalCardSelectedImage;
    }

    // Populate form fields with existing values (for edit)
    const fromInput = subview.querySelector('[data-dcv-from-input]');
    const messageInput = subview.querySelector('[data-dcv-message-input]');
    const counter = subview.querySelector('[data-dcv-counter]');
    const submitBtn = subview.querySelector('[data-dcv-submit]');

    if (fromInput) {
      fromInput.value = this.#digitalCardFrom;
      fromInput.classList.toggle('pd-dc-input--filled', this.#digitalCardFrom.length > 0);
    }
    if (messageInput) {
      messageInput.value = this.#digitalCardMessage;
      messageInput.classList.toggle('pd-gm-textarea--filled', this.#digitalCardMessage.length > 0);
    }
    if (counter) {
      counter.textContent = `${this.#digitalCardMessage.length}/1000`;
    }

    // Update submit button state
    this.#updateDigitalCardSubmitState(submitBtn, fromInput, messageInput);
  }

  /**
   * Update the compose form's submit button enabled/disabled state.
   * Requires BOTH From* and message textarea to be non-empty (AC9).
   * @param {Element|null} btn
   * @param {Element|null} fromInput
   * @param {Element|null} [messageInput]
   */
  #updateDigitalCardSubmitState(btn, fromInput, messageInput) {
    if (!btn) return;
    const fromVal = fromInput ? fromInput.value.trim() : this.#digitalCardFrom;
    const msgVal = messageInput ? messageInput.value.trim() : this.#digitalCardMessage;
    const isValid = fromVal.length > 0 && msgVal.length > 0;
    btn.classList.toggle('pd-gm-btn--disabled', !isValid);
    if (isValid) {
      btn.removeAttribute('disabled');
    } else {
      btn.setAttribute('disabled', '');
    }
  }

  /**
   * Handle compose form submission — saves data and closes the subview.
   */
  #handleDigitalCardComposeSubmit() {
    const subview = this.querySelector('[data-digital-card-view]');
    if (!subview) return;

    const fromInput = subview.querySelector('[data-dcv-from-input]');
    const messageInput = subview.querySelector('[data-dcv-message-input]');

    this.#digitalCardFrom = fromInput ? fromInput.value.trim() : '';
    this.#digitalCardMessage = messageInput ? messageInput.value.trim() : '';

    // Close subview
    this.#closeDigitalCardSubview();

    // Set the step to "added" state
    const step = this.querySelector('[data-pd-step="digital-card"]');
    if (step) {
      const expanded = step.querySelector('[data-dc-expanded]');
      const defaultLabel = expanded?.getAttribute('data-dc-card-label-default') || 'Add your card';
      const activeLabel = expanded?.getAttribute('data-dc-card-label-active') || 'Edit your card';
      this.#setDigitalCardAdded(step, true, { defaultLabel, activeLabel });
    }
  }

  /**
   * Setup the digital card selection & compose sub-view interactions.
   */
  #setupDigitalCardSubview() {
    const subview = this.querySelector('[data-digital-card-view]');
    if (!subview) return;

    // ── Back button: card selection → close subview ──
    const selectBackBtn = subview.querySelector('[data-dcv-back="select"]');
    if (selectBackBtn) {
      selectBackBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this.#closeDigitalCardSubview();
      });
    }

    // ── Back button: compose → return to card selection ──
    const composeBackBtn = subview.querySelector('[data-dcv-back="compose"]');
    if (composeBackBtn) {
      composeBackBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const selectView = subview.querySelector('[data-dcv-select]');
        const composeView = subview.querySelector('[data-dcv-compose]');
        if (selectView) selectView.style.display = '';
        if (composeView) composeView.style.display = 'none';
      });
    }

    // ── "Select a New Card" button in compose → return to card selection ──
    const changeCardBtn = subview.querySelector('[data-dcv-change-card]');
    if (changeCardBtn) {
      changeCardBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const selectView = subview.querySelector('[data-dcv-select]');
        const composeView = subview.querySelector('[data-dcv-compose]');
        if (selectView) selectView.style.display = '';
        if (composeView) composeView.style.display = 'none';
      });
    }

    // ── Occasion dropdown ──
    const trigger = subview.querySelector('[data-dc-occasion-trigger]');
    const list = subview.querySelector('[data-dc-occasion-list]');
    const labelEl = subview.querySelector('[data-dc-occasion-label]');
    const valueEl = subview.querySelector('[data-dc-occasion-value]');

    if (trigger && list) {
      trigger.addEventListener('click', () => {
        const isOpen = list.style.display !== 'none';
        list.style.display = isOpen ? 'none' : '';
        trigger.setAttribute('aria-expanded', String(!isOpen));
        trigger.classList.toggle('pd-gm-field__select--open', !isOpen);
      });

      list.addEventListener('click', (event) => {
        const item = event.target.closest('[data-dc-occasion-item]');
        if (!item) return;
        const occasion = item.getAttribute('data-dc-occasion-item');
        if (!occasion) return;

        this.#digitalCardOccasion = occasion;

        // Update dropdown UI
        if (labelEl) {
          labelEl.style.fontSize = '10px';
          labelEl.textContent = 'Occasion';
        }
        if (valueEl) {
          valueEl.style.display = '';
          valueEl.textContent = occasion;
        }
        trigger.classList.add('pd-gm-field__select--filled');
        list.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('pd-gm-field__select--open');

        // Render the grid for the selected occasion
        this.#renderDigitalCardGrid(occasion);
      });
    }

    // ── Card tile clicks (delegated) ──
    const tilesContainer = subview.querySelector('[data-dcv-grid-tiles]');
    if (tilesContainer) {
      tilesContainer.addEventListener('click', (event) => {
        const tile = event.target.closest('[data-dcv-card-id]');
        if (!tile) return;

        const cardId = tile.getAttribute('data-dcv-card-id');
        const cardImage = tile.getAttribute('data-dcv-card-image');
        const cardLabel = tile.getAttribute('data-dcv-card-label');

        this.#digitalCardSelectedId = cardId;
        this.#digitalCardSelectedImage = cardImage;
        this.#digitalCardSelectedLabel = cardLabel;

        // Update selection UI
        const allTiles = tilesContainer.querySelectorAll('.pd-dc-card-tile');
        for (const t of allTiles) {
          t.classList.toggle('pd-dc-card-tile--selected', t === tile);
        }

        // Proceed to compose form
        this.#showDigitalCardCompose();
      });
    }

    // ── Compose form — From input ──
    const fromInput = subview.querySelector('[data-dcv-from-input]');
    const submitBtn = subview.querySelector('[data-dcv-submit]');
    const messageInput = subview.querySelector('[data-dcv-message-input]');
    const counter = subview.querySelector('[data-dcv-counter]');

    if (fromInput) {
      fromInput.addEventListener('input', () => {
        const value = fromInput.value.trim();
        this.#digitalCardFrom = value;
        fromInput.classList.toggle('pd-dc-input--filled', value.length > 0);
        this.#updateDigitalCardSubmitState(submitBtn, fromInput, messageInput);
      });
    }

    // ── Compose form — Message textarea ──
    if (messageInput) {
      messageInput.addEventListener('input', () => {
        const value = messageInput.value;
        this.#digitalCardMessage = value;
        messageInput.classList.toggle('pd-gm-textarea--filled', value.length > 0);
        if (counter) counter.textContent = `${value.length}/1000`;
        this.#updateDigitalCardSubmitState(submitBtn, fromInput, messageInput);
      });
    }

    // ── Submit button ──
    if (submitBtn) {
      submitBtn.addEventListener('click', (event) => {
        event.preventDefault();
        if (submitBtn.hasAttribute('disabled')) return;
        this.#handleDigitalCardComposeSubmit();
      });
    }
  }

  /**
   * Open the gift message sub-view
   */
  #openGiftMessageView() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-gift-message-view]');
    if (!drawer || !subview) return;

    // Close other sub-views to prevent stacking
    const learnMoreView = this.querySelector('[data-learn-more-view]');
    if (learnMoreView) learnMoreView.setAttribute('aria-hidden', 'true');
    const greetingCardView = this.querySelector('[data-greeting-card-view]');
    if (greetingCardView) greetingCardView.setAttribute('aria-hidden', 'true');
    this.#greetingCardSubviewOpen = false;
    const digitalCardView = this.querySelector('[data-digital-card-view]');
    if (digitalCardView) digitalCardView.setAttribute('aria-hidden', 'true');
    this.#digitalCardSubviewOpen = false;

    this.#giftMessageSubviewOpen = true;
    subview.setAttribute('aria-hidden', 'false');
    drawer.classList.add('pd-drawer--subview-open');
  }

  /**
   * Close the gift message sub-view
   */
  #closeGiftMessageView() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-gift-message-view]');
    if (!drawer || !subview) return;

    this.#giftMessageSubviewOpen = false;
    drawer.classList.remove('pd-drawer--subview-open');
    subview.setAttribute('aria-hidden', 'true');
  }

  /**
   * Open the greeting card iframe sub-view
   * @param {Element} [triggerBtn]
   */
  #openGreetingCardView(triggerBtn) {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-greeting-card-view]');
    if (!drawer || !subview) return;

    // Close other sub-views to prevent stacking
    const learnMoreView = this.querySelector('[data-learn-more-view]');
    if (learnMoreView) learnMoreView.setAttribute('aria-hidden', 'true');
    const giftMessageView = this.querySelector('[data-gift-message-view]');
    if (giftMessageView) giftMessageView.setAttribute('aria-hidden', 'true');
    this.#giftMessageSubviewOpen = false;
    const digitalCardView = this.querySelector('[data-digital-card-view]');
    if (digitalCardView) digitalCardView.setAttribute('aria-hidden', 'true');
    this.#digitalCardSubviewOpen = false;

    this.#greetingCardSubviewOpen = true;
    subview.setAttribute('aria-hidden', 'false');
    drawer.classList.add('pd-drawer--subview-open');

    // Capture the base iframe URL from the triggering paid card (used when
    // the user picks an occasion in the dropdown below).
    const card = triggerBtn
      ? triggerBtn.closest('.pd-message-card')
      : this.querySelector('.pd-message-card[data-greeting-card-url]');
    const baseUrl = card ? card.getAttribute('data-greeting-card-url') : '';
    if (baseUrl) {
      this.#greetingCardBaseUrl = baseUrl;
    }

    const iframe = subview.querySelector('[data-gc-iframe]');

    if (iframe && iframe.getAttribute('src')) {
      // Iframe already loaded (e.g., user hit "Change") — just show it
      const loading = subview.querySelector('[data-gc-loading]');
      if (loading) loading.style.display = 'none';
      iframe.style.display = '';
    } else {
      // Fresh open — load the Printible iframe immediately (no occasion picker)
      this.#loadGreetingCardIframe();
    }
  }

  /**
   * Close the greeting card iframe sub-view
   */
  #closeGreetingCardView() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-greeting-card-view]');
    if (!drawer || !subview) return;

    this.#greetingCardSubviewOpen = false;
    subview.setAttribute('aria-hidden', 'true');
    drawer.classList.remove('pd-drawer--subview-open');
  }

  /**
   * Setup greeting card sub-view interactions and iframe message listener
   */
  #setupGreetingCardView() {
    const subview = this.querySelector('[data-greeting-card-view]');
    if (!subview) return;

    // Close button
    const closeBtn = subview.querySelector('[data-greeting-card-toggle="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#closeGreetingCardView();
      });
    }

    // Remove buttons on the paid message card
    const removeButtons = this.querySelectorAll('[data-greeting-card-action="remove"]');
    for (const btn of removeButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#handleRemoveGreetingCard();
      });
    }

    // Change buttons on the paid message card — restart the flow with a fresh
    // iframe so the merchant journey is identical to the first-time add. JS
    // data fields are NOT cleared here — if the user backs out without
    // completing, the previously added greeting card stays intact; only
    // `#handleGreetingCardComplete` overwrites it.
    const changeButtons = this.querySelectorAll('[data-greeting-card-action="change"]');
    for (const btn of changeButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#resetGreetingCardSubviewUi();
        this.#openGreetingCardView();
      });
    }

    // Listen for iframe postMessage events from Printible. The iframe emits
    // two actions: `printibleCreated` (success, carries printibleID + card
    // data) and `closePrintibleWindow` (user closed the iframe without
    // completing). Both must be handled — ignoring `closePrintibleWindow`
    // would leave the subview stuck open after the iframe self-closes.
    window.removeEventListener('message', this.#boundHandlePrintibleMessage);
    window.addEventListener('message', this.#boundHandlePrintibleMessage);
  }

  /**
   * Handle Printible iframe postMessage events.
   * @param {MessageEvent} event
   */
  #handlePrintibleMessage(event) {
    if (!this.#isAllowedPrintibleOrigin(event.origin)) return;
    if (!event.data || !event.data.action) return;

    const iframe = this.querySelector('[data-gc-iframe]');
    if (!iframe || event.source !== iframe.contentWindow) return;

    if (event.data.action === 'printibleCreated' && event.data.printibleID) {
      this.#greetingCardData = event.data;
      this.#handleGreetingCardComplete();
    } else if (event.data.action === 'closePrintibleWindow') {
      // Close the subview and reset the iframe state so the next entry
      // (whether via the paid card button or the Change button) starts
      // from the occasion picker rather than the stale iframe.
      this.#closeGreetingCardView();
      this.#resetGreetingCardSubviewUi();
    }
  }

  /**
   * Validate Printible postMessage origins without allowing substring matches.
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
    } catch (error) {
      return false;
    }
  }

  /**
   * Load the captured Printible base URL into the iframe and show it.
   */
  #loadGreetingCardIframe() {
    const subview = this.querySelector('[data-greeting-card-view]');
    if (!subview) return;

    const iframe = subview.querySelector('[data-gc-iframe]');
    if (!iframe || !this.#greetingCardBaseUrl) return;

    const loading = subview.querySelector('[data-gc-loading]');

    // Show the shimmer while the Printible embed loads; reveal the iframe once
    // its `load` event fires.
    if (loading) loading.style.display = '';
    iframe.style.display = 'none';

    iframe.addEventListener(
      'load',
      () => {
        if (loading) loading.style.display = 'none';
        iframe.style.display = '';
      },
      { once: true }
    );

    const separator = this.#greetingCardBaseUrl.includes('?') ? '&' : '?';
    const hostUrl = encodeURIComponent('https://myedible.myshopify.com');
    const url = `${this.#greetingCardBaseUrl}${separator}hostUrl=${hostUrl}`;
    iframe.setAttribute('src', url);
  }

  /**
   * Handle greeting card completion from iframe message
   */
  #handleGreetingCardComplete() {
    // Find the paid message card
    const paidCard = this.querySelector('.pd-message-card[data-greeting-card-url]');
    if (!paidCard) return;

    // Clear transient "selected" hover state on all cards. Preserve any
    // existing "added" state on the free card so the free gift message and
    // paid greeting card can coexist as separate line items.
    const allCards = this.querySelectorAll('.pd-message-card');
    for (const c of allCards) {
      c.classList.remove('pd-message-card--selected');
    }

    // Set paid card to added state
    paidCard.classList.add('pd-message-card--added');
    this.#toggleMessageCardState(paidCard, 'added');

    // Store the variant ID from the paid button
    const paidBtn = paidCard.querySelector('[data-message-variant-id]');
    if (paidBtn) {
      this.#paidGreetingCardVariantId = Number(paidBtn.getAttribute('data-message-variant-id')) || null;
    }

    // Close the sub-view
    this.#closeGreetingCardView();

    // Update total price
    this.#updatePrice();
  }

  /**
   * Remove greeting card selection and reset state. Also removes any
   * greeting_card line items from the cart so `#syncMessagesFromCart` does not
   * restore the "added" UI state on the next drawer open.
   */
  async #handleRemoveGreetingCard() {
    this.#greetingCardData = null;
    this.#paidGreetingCardVariantId = null;

    // Find the paid card and reset to "add" state
    const paidCard = this.querySelector('.pd-message-card[data-greeting-card-url]');
    if (paidCard) {
      paidCard.classList.remove('pd-message-card--added');
      this.#toggleMessageCardState(paidCard, 'add');
    }

    this.#resetGreetingCardSubviewUi();
    this.#updatePrice();

    await this.#removePersonalizationFromCart({
      itemType: CART_ITEM_TYPES.greetingCard,
    });
  }

  /**
   * Reset the greeting card subview back to its fresh state: clear the iframe
   * src and hide it so the next open reloads a fresh Printible session.
   */
  #resetGreetingCardSubviewUi() {
    const subview = this.querySelector('[data-greeting-card-view]');
    if (!subview) return;

    const iframe = subview.querySelector('[data-gc-iframe]');
    if (iframe) {
      iframe.removeAttribute('src');
      iframe.style.display = 'none';
    }

    const loading = subview.querySelector('[data-gc-loading]');
    if (loading) loading.style.display = 'none';
  }

  /**
   * Setup the gift message sub-view (tabs, textarea, dropdown, generation)
   */
  #setupGiftMessageView() {
    const subview = this.querySelector('[data-gift-message-view]');
    if (!subview) return;

    // Close button
    const closeBtn = subview.querySelector('[data-gift-message-toggle="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#closeGiftMessageView();
      });
    }

    // Tab switching
    this.#setupGiftMessageTabs(subview);

    // Write my own panel
    this.#setupWriteOwnMessage(subview);

    // Generate panel
    this.#setupGenerateMessage(subview);
  }

  /**
   * Setup gift message tab switching
   * @param {Element} subview
   */
  #setupGiftMessageTabs(subview) {
    const tabs = subview.querySelectorAll('[data-gm-tab]');
    const panels = subview.querySelectorAll('[data-gm-panel]');

    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const tabId = tab.getAttribute('data-gm-tab');

        for (const t of tabs) {
          const isActive = t.getAttribute('data-gm-tab') === tabId;
          t.classList.toggle('pd-gm-tab--active', isActive);
        }

        for (const panel of panels) {
          const isActive = panel.getAttribute('data-gm-panel') === tabId;
          panel.style.display = isActive ? '' : 'none';
        }
      });
    }
  }

  /**
   * Setup "Write my own" panel textarea + counter + validation
   * @param {Element} subview
   */
  #setupWriteOwnMessage(subview) {
    const textarea = subview.querySelector('[data-gm-textarea]');
    const counter = subview.querySelector('[data-gm-counter]');
    const errorEl = subview.querySelector('[data-gm-error]');
    const submitBtn = subview.querySelector('[data-gm-submit]');
    const contentEl = subview.querySelector('[data-gm-max-chars]');

    if (!textarea || !counter || !submitBtn) return;

    const maxChars = contentEl ? Number(contentEl.getAttribute('data-gm-max-chars')) || 300 : 300;

    const updateState = () => {
      const length = textarea.value.length;
      counter.textContent = `${length}/${maxChars}`;

      const isAtMax = length >= maxChars;
      const hasContent = length > 0;

      // Error state
      textarea.classList.toggle('pd-gm-textarea--error', isAtMax);
      counter.classList.toggle('pd-gm-counter--error', isAtMax);
      if (errorEl) errorEl.style.display = isAtMax ? '' : 'none';

      // Filled state
      textarea.classList.toggle('pd-gm-textarea--filled', hasContent && !isAtMax);

      // Button state
      if (hasContent) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('pd-gm-btn--disabled');
      } else {
        submitBtn.disabled = true;
        submitBtn.classList.add('pd-gm-btn--disabled');
      }
    };

    textarea.addEventListener('input', updateState);
    textarea.addEventListener('paste', () => {
      requestAnimationFrame(updateState);
    });

    // Submit handler
    submitBtn.addEventListener('click', () => {
      if (!textarea.value.trim()) return;
      this.#handleAddGiftMessage(textarea.value.trim());
    });
  }

  /**
   * Setup "Write one for me" panel (dropdown, name input, generate)
   * @param {Element} subview
   */
  #setupGenerateMessage(subview) {
    const dropdownTrigger = subview.querySelector('[data-gm-dropdown-trigger]');
    const dropdownList = subview.querySelector('[data-gm-dropdown-list]');
    const dropdownLabel = subview.querySelector('[data-gm-dropdown-label]');
    const dropdownValue = subview.querySelector('[data-gm-dropdown-value]');
    const nameInput = subview.querySelector('[data-gm-name-input]');
    const nameLabel = subview.querySelector('[data-gm-name-label]');
    const generateBtn = subview.querySelector('[data-gm-generate-btn]');
    const generatedWrap = subview.querySelector('[data-gm-generated-wrap]');
    const generatedTextarea = subview.querySelector('[data-gm-generated-textarea]');
    const generatedCounter = subview.querySelector('[data-gm-generated-counter]');
    const generatedError = subview.querySelector('[data-gm-generated-error]');
    const postGenerate = subview.querySelector('[data-gm-post-generate]');
    const submitGenerated = subview.querySelector('[data-gm-submit-generated]');
    const regenerateBtn = subview.querySelector('[data-gm-regenerate-btn]');
    const contentEl = subview.querySelector('[data-gm-max-chars]');

    const maxChars = contentEl ? Number(contentEl.getAttribute('data-gm-max-chars')) || 300 : 300;

    // -- Dropdown logic --
    if (dropdownTrigger && dropdownList) {
      dropdownTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = dropdownList.style.display !== 'none';
        dropdownList.style.display = isOpen ? 'none' : '';
        dropdownTrigger.classList.toggle('pd-gm-field__select--open', !isOpen);
        dropdownTrigger.setAttribute('aria-expanded', String(!isOpen));
      });

      // Handle keyboard on trigger
      dropdownTrigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          dropdownTrigger.click();
        }
      });

      // Close dropdown on outside click
      document.addEventListener('click', () => {
        dropdownList.style.display = 'none';
        dropdownTrigger.classList.remove('pd-gm-field__select--open');
        dropdownTrigger.setAttribute('aria-expanded', 'false');
      });

      // Delegated — items are injected from the API after render.
      dropdownList.addEventListener('click', (event) => {
        const item = event.target.closest('[data-gm-occasion]');
        if (!item || !dropdownList.contains(item)) return;
        event.stopPropagation();

        const value = item.getAttribute('data-gm-occasion');
        this.#selectedOccasion = value;

        // Update UI
        if (dropdownValue) {
          dropdownValue.textContent = value;
          dropdownValue.style.display = '';
        }

        // Mark selected
        const allItems = dropdownList.querySelectorAll('[data-gm-occasion]');
        for (const i of allItems) {
          i.classList.toggle('pd-gm-dropdown-item--selected', i === item);
        }

        // Close dropdown
        dropdownList.style.display = 'none';
        dropdownTrigger.classList.remove('pd-gm-field__select--open');
        dropdownTrigger.classList.add('pd-gm-field__select--filled');
        dropdownTrigger.setAttribute('aria-expanded', 'false');

        this.#updateGenerateButtonState(subview);
      });
    }

    // -- Name input floating label logic --
    if (nameInput && nameLabel) {
      const inputWrap = nameInput.closest('.pd-gm-field__input-wrap');

      const updateNameState = () => {
        const hasValue = nameInput.value.length > 0;
        if (inputWrap) {
          inputWrap.classList.toggle('pd-gm-field__input-wrap--active', hasValue || document.activeElement === nameInput);
          inputWrap.classList.toggle('pd-gm-field__input-wrap--filled', hasValue);
        }
        this.#updateGenerateButtonState(subview);
      };

      nameInput.addEventListener('input', updateNameState);
      nameInput.addEventListener('focus', () => {
        if (inputWrap) {
          inputWrap.classList.add('pd-gm-field__input-wrap--active');
          inputWrap.classList.add('pd-gm-field__input-wrap--focused');
        }
      });
      nameInput.addEventListener('blur', () => {
        if (inputWrap) {
          if (!nameInput.value) {
            inputWrap.classList.remove('pd-gm-field__input-wrap--active');
          }
          inputWrap.classList.remove('pd-gm-field__input-wrap--focused');
        }
      });
    }

    // -- Generate button logic --
    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        if (!this.#selectedOccasion || !nameInput?.value.trim()) return;

        const originalText = generateBtn.textContent;
        generateBtn.textContent = 'Generating...';
        generateBtn.disabled = true;
        generateBtn.classList.add('pd-gm-btn--disabled');

        try {
          const message = await this.#generateGiftMessage(this.#selectedOccasion, nameInput.value.trim(), maxChars);

          // Show generated message
          if (generatedTextarea && generatedWrap && postGenerate) {
            generatedTextarea.value = message;
            generatedWrap.style.display = '';
            generateBtn.style.display = 'none';
            postGenerate.style.display = '';

            // Update counter
            if (generatedCounter) {
              generatedCounter.textContent = `${message.length}/${maxChars}`;
            }
          }
        } catch (error) {
          console.error('Gift message generation failed:', error);
        } finally {
          // Always restore the button label/state — on success the button is hidden,
          // but if it's later re-shown (e.g. after Remove), it must not still read
          // "Generating..." or be stuck disabled.
          generateBtn.textContent = originalText;
          generateBtn.disabled = false;
          generateBtn.classList.remove('pd-gm-btn--disabled');
        }
      });
    }

    // -- Generated textarea editing --
    if (generatedTextarea && generatedCounter) {
      const updateGeneratedState = () => {
        const length = generatedTextarea.value.length;
        generatedCounter.textContent = `${length}/${maxChars}`;

        const isAtMax = length >= maxChars;
        generatedTextarea.classList.toggle('pd-gm-textarea--error', isAtMax);
        generatedCounter.classList.toggle('pd-gm-counter--error', isAtMax);
        if (generatedError) generatedError.style.display = isAtMax ? '' : 'none';
        generatedTextarea.classList.toggle('pd-gm-textarea--filled', length > 0 && !isAtMax);
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

        regenerateBtn.textContent = 'Generating...';
        regenerateBtn.style.pointerEvents = 'none';

        try {
          const message = await this.#generateGiftMessage(this.#selectedOccasion, nameInput.value.trim(), maxChars);

          if (generatedTextarea) {
            generatedTextarea.value = message;
            if (generatedCounter) {
              generatedCounter.textContent = `${message.length}/${maxChars}`;
              generatedCounter.classList.remove('pd-gm-counter--error');
            }
            generatedTextarea.classList.remove('pd-gm-textarea--error');
            if (generatedError) generatedError.style.display = 'none';
          }
        } catch (error) {
          console.error('Gift message regeneration failed:', error);
        } finally {
          regenerateBtn.textContent = 'Regenerate Message';
          regenerateBtn.style.pointerEvents = '';
        }
      });
    }
  }

  /**
   * Update generate button enable/disable state based on occasion + name
   * @param {Element} subview
   */
  #updateGenerateButtonState(subview) {
    const nameInput = subview.querySelector('[data-gm-name-input]');
    const generateBtn = subview.querySelector('[data-gm-generate-btn]');

    if (!generateBtn) return;

    const hasOccasion = !!this.#selectedOccasion;
    const hasName = !!(nameInput && /** @type {HTMLInputElement} */ (nameInput).value.trim());

    if (hasOccasion && hasName) {
      generateBtn.disabled = false;
      generateBtn.classList.remove('pd-gm-btn--disabled');
    } else {
      generateBtn.disabled = true;
      generateBtn.classList.add('pd-gm-btn--disabled');
    }
  }

  /**
   * Generate a gift message via the Edible Arrangements card-message API.
   * Endpoint: https://www.ediblearrangements.com/api/card/message?recipient=&occasion=&sender=
   * The current UI collects only one name ("Your name") — used as `sender`.
   * @param {string} occasion
   * @param {string} name - the sender's name from the input
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

    // Generic fallback if the API is unavailable / blocked by CORS
    const fallback = `Thinking of you on this ${occasion} and sending warm wishes your way. May this gift bring a smile to your face and brighten your day.\nWith love,\n${name}`;
    return fallback.substring(0, maxChars);
  }

  /**
   * Handle adding the gift message — store text, select the free card, close sub-view
   * @param {string} messageText
   */
  #handleAddGiftMessage(messageText) {
    this.#giftMessageText = messageText;

    // Find the free message card and switch to "added" state
    const freeBtn = this.querySelector('.pd-message-btn--free');
    if (freeBtn) {
      const card = freeBtn.closest('.pd-message-card');
      const variantId = freeBtn.getAttribute('data-message-variant-id');

      // Clear transient "selected" hover state on all cards. Preserve any
      // existing "added" state on the paid greeting card so both can coexist.
      const allCards = this.querySelectorAll('.pd-message-card');
      for (const c of allCards) {
        c.classList.remove('pd-message-card--selected');
      }

      // Mark the free card as "added" (orange highlight + Remove/Edit buttons)
      if (card) {
        card.classList.add('pd-message-card--added');
        this.#toggleMessageCardState(card, 'added');
      }
      this.#freeMessageVariantId = Number(variantId) || null;
    }

    // Close the sub-view
    this.#closeGiftMessageView();

    // Update price
    this.#updatePrice();
  }

  /**
   * Remove the gift message — clear state, reset the card UI and remove the
   * gift_message utility line item from the cart.
   */
  async #handleRemoveGiftMessage() {
    this.#giftMessageText = null;
    this.#freeMessageVariantId = null;

    const freeBtn = this.querySelector('.pd-message-btn--free');
    if (freeBtn) {
      const card = freeBtn.closest('.pd-message-card');
      if (card) {
        card.classList.remove('pd-message-card--added');
        this.#toggleMessageCardState(card, 'add');
      }
    }

    // Reset the textarea state in the sub-view so next "Add" starts fresh
    const subview = this.querySelector('[data-gift-message-view]');
    if (subview) {
      const textarea = subview.querySelector('[data-gm-textarea]');
      if (textarea) {
        textarea.value = '';
        textarea.dispatchEvent(new Event('input'));
      }
      const generatedTextarea = subview.querySelector('[data-gm-generated-textarea]');
      if (generatedTextarea) generatedTextarea.value = '';
      const generatedWrap = subview.querySelector('[data-gm-generated-wrap]');
      if (generatedWrap) generatedWrap.style.display = 'none';
      const generateBtn = subview.querySelector('[data-gm-generate-btn]');
      if (generateBtn) generateBtn.style.display = '';
      const postGenerate = subview.querySelector('[data-gm-post-generate]');
      if (postGenerate) postGenerate.style.display = 'none';
    }

    this.#updatePrice();

    await this.#removePersonalizationFromCart({ itemType: CART_ITEM_TYPES.giftMessage });
  }

  /**
   * Remove every line item whose `_item_type` property matches `itemType`
   * from the cart. Dispatches `CartUpdateEvent` so cart UI refreshes.
   *
   * @param {{ itemType: string }} options
   */
  async #removePersonalizationFromCart({ itemType }) {
    try {
      /** @type {Record<string, number>} */
      const updates = {};

      const cartRes = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (cartRes.ok) {
        const cart = await cartRes.json();
        for (const item of cart.items || []) {
          if (
            item.properties &&
            item.properties[CART_PROPERTY_KEYS.itemType] === itemType
          ) {
            updates[item.key] = 0;
          }
        }
      }

      if (Object.keys(updates).length === 0) return;

      const response = await fetch(Theme.routes.cart_update_url, {
        ...fetchConfig('json', { body: JSON.stringify({ updates }) }),
      });

      if (!response.ok) return;

      const updatedCart = await response.json();
      document.dispatchEvent(
        new CartUpdateEvent(updatedCart, this.id || 'personalization-drawer', {
          source: 'personalization-drawer',
          itemCount: updatedCart.item_count,
        })
      );
    } catch (error) {
      console.error('Personalization drawer: failed to remove from cart', error);
    }
  }

  /**
   * Open the gift message sub-view in edit mode, pre-filling the current message
   */
  #handleEditGiftMessage() {
    const subview = this.querySelector('[data-gift-message-view]');
    if (subview && this.#giftMessageText) {
      // Switch to the "Write my own" tab and pre-fill
      const writeOwnTab = subview.querySelector('[data-gm-tab="write-own"]');
      if (writeOwnTab) writeOwnTab.click();

      const textarea = subview.querySelector('[data-gm-textarea]');
      if (textarea) {
        textarea.value = this.#giftMessageText;
        textarea.dispatchEvent(new Event('input'));
      }
    }
    this.#openGiftMessageView();
  }

  /**
   * Toggle the "add" / "added" button state on a message card
   * @param {Element} card
   * @param {'add'|'added'} state
   */
  #toggleMessageCardState(card, state) {
    const groups = card.querySelectorAll('[data-message-state]');
    for (const group of groups) {
      const matches = group.getAttribute('data-message-state') === state;
      group.style.display = matches ? '' : 'none';
    }
  }

  /**
   * Setup collapsible section toggles
   */
  #setupCollapsibles() {
    const toggles = this.querySelectorAll('[data-step-toggle]');

    for (const toggle of toggles) {
      toggle.addEventListener('click', () => {
        const stepId = toggle.getAttribute('data-step-toggle');
        const content = this.querySelector(`[data-step-content="${stepId}"]`);

        if (!content) return;

        const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
        content.style.display = isExpanded ? 'none' : '';
        toggle.setAttribute('aria-expanded', String(!isExpanded));
      });
    }
  }

  /**
   * Setup Learn More sub-view toggle (opens/closes the in-drawer informational panel)
   */
  #setupLearnMore() {
    const drawer = this.refs.drawer;
    const subview = this.querySelector('[data-learn-more-view]');
    if (!drawer || !subview) return;

    const openButtons = this.querySelectorAll('[data-learn-more-toggle="open"]');
    for (const btn of openButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Close other sub-views to prevent stacking
        const giftMessageView = this.querySelector('[data-gift-message-view]');
        if (giftMessageView) giftMessageView.setAttribute('aria-hidden', 'true');
        this.#giftMessageSubviewOpen = false;
        const greetingCardView = this.querySelector('[data-greeting-card-view]');
        if (greetingCardView) greetingCardView.setAttribute('aria-hidden', 'true');
        this.#greetingCardSubviewOpen = false;
        const digitalCardView = this.querySelector('[data-digital-card-view]');
        if (digitalCardView) digitalCardView.setAttribute('aria-hidden', 'true');
        this.#digitalCardSubviewOpen = false;

        drawer.classList.add('pd-drawer--subview-open');
        subview.setAttribute('aria-hidden', 'false');
      });
    }

    const closeButtons = this.querySelectorAll('[data-learn-more-toggle="close"]');
    for (const btn of closeButtons) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        drawer.classList.remove('pd-drawer--subview-open');
        subview.setAttribute('aria-hidden', 'true');
      });
    }
  }

  /**
   * Calculate total price and update ATC button
   */
  #updatePrice() {
    let total = 0;

    // Selected variant price
    if (this.#productData && this.#selectedVariantId) {
      const variant = this.#productData.variants.find((v) => v.id === this.#selectedVariantId);
      if (variant) total += variant.price;
    }

    // Selected add-ons
    for (const addonId of this.#selectedAddons) {
      const btn = this.querySelector(`[data-addon-variant-id="${addonId}"]`);
      if (btn) {
        total += Number(btn.getAttribute('data-addon-price') || 0);
      }
    }

    // Selected message line items — free gift message and paid greeting card
    // can coexist; sum prices for whichever are added.
    for (const variantId of [this.#freeMessageVariantId, this.#paidGreetingCardVariantId]) {
      if (!variantId) continue;
      const btn = this.querySelector(`[data-message-variant-id="${variantId}"]`);
      if (btn) {
        total += Number(btn.getAttribute('data-message-price') || 0);
      }
    }

    if (this.refs.atcButtonText) {
      this.refs.atcButtonText.textContent = this.#t('addToCartPrice', this.#formatMoney(total)) || `Add to Cart - ${this.#formatMoney(total)}`;
    }
  }

  /**
   * Handle the drawer ATC button click
   * @param {MouseEvent} event
   */
  async #handleAddToCart(event) {
    event.preventDefault();

    if (!this.#selectedVariantId) return;

    const button = this.refs.atcButton;
    if (button) {
      button.setAttribute('disabled', '');
      button.classList.add('pd-footer__atc-btn--loading');
    }

    // Lock the drawer while the cart requests run — close button and
    // overlay clicks are ignored until the flag clears in `finally`.
    this.#isAddingToCart = true;
    this.refs.drawer?.classList.add('pd-drawer--busy');

    // Unique group ID for this ATC event — stamped onto the parent and its
    // child add-ons/gift wrap so the relationship remains stable when
    // several personalised products coexist in the same cart.
    // Underscore prefix hides the property from the line-item display.
    const atcGroupId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `atc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    /** @type {{ id: number, quantity: number, properties?: Record<string, string> }[]} */
    const items = [];

    // Main product variant
    /** @type {{ id: number, quantity: number, properties?: Record<string, string> }} */
    const mainItem = { id: this.#selectedVariantId, quantity: 1 };
    /** @type {Record<string, string>} */
    const props = {
      [CART_PROPERTY_KEYS.addToCartId]: atcGroupId,
      [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.parent,
    };

    mainItem.properties = props;
    items.push(mainItem);

    // Add-ons & upgrades — tagged by type so server-side / cart UI can identify.
    for (const addonVariantId of this.#selectedAddons) {
      const addonType = this.#addonTypeByVariantId.get(addonVariantId);
      const itemType = addonType === 'upgrade' ? CART_ITEM_TYPES.upgrade : CART_ITEM_TYPES.addOn;
      items.push({
        id: addonVariantId,
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: itemType,
          [CART_PROPERTY_KEYS.addToCartId]: atcGroupId,
        },
      });
    }

    // Gift wrap — only added when the current product opts in via the
    // `ediblearrangement.wrap_available` metafield (carried into the drawer
    // as `data-wrap-available` on the ATC element). The variant ID stays
    // pre-selected from the first card across drawer opens, so without this
    // gate non-wrap products would silently get a wrap line item.
    if (this.#wrapAvailable && this.#selectedGiftWrapVariantId) {
      items.push({
        id: this.#selectedGiftWrapVariantId,
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.giftWrap,
          [CART_PROPERTY_KEYS.addToCartId]: atcGroupId,
        },
      });
    }

    // One-per-cart personalization items: fetch cart once and check which
    // types already exist so we never add duplicates.
    /** @type {Set<string>} */
    const existingTypes = new Set();
    try {
      const cartRes = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!cartRes.ok) throw new Error('Failed to fetch cart for personalization dedupe');

      const cart = await cartRes.json();
      for (const item of cart.items || []) {
        if (item.properties && item.properties[CART_PROPERTY_KEYS.itemType]) {
          existingTypes.add(item.properties[CART_PROPERTY_KEYS.itemType]);
        }
      }
    } catch (err) {
      console.error('Personalization drawer: cart dedupe lookup failed', err);
      this.#isAddingToCart = false;
      this.refs.drawer?.classList.remove('pd-drawer--busy');
      if (button) {
        button.removeAttribute('disabled');
        button.classList.remove('pd-footer__atc-btn--loading');
      }
      return;
    }

    // Complementary gift message — one per cart.
    if (
      this.#freeMessageVariantId &&
      this.#giftMessageText &&
      !existingTypes.has(CART_ITEM_TYPES.giftMessage)
    ) {
      items.push({
        id: this.#freeMessageVariantId,
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.giftMessage,
          [CART_PROPERTY_KEYS.giftMessageData]: this.#giftMessageText,
          [CART_PROPERTY_KEYS.isOnGoody]: 'false',
        },
      });
    }

    // Custom greeting card — one per cart.
    if (
      this.#paidGreetingCardVariantId &&
      !existingTypes.has(CART_ITEM_TYPES.greetingCard)
    ) {
      items.push({
        id: this.#paidGreetingCardVariantId,
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.greetingCard,
          [CART_PROPERTY_KEYS.greetingCardData]: this.#greetingCardData || '',
          [CART_PROPERTY_KEYS.isOnGoody]: 'false',
        },
      });
    }

    // Digital card — one per cart.
    if (
      this.#digitalCardAdded &&
      this.#digitalCardSelectedId &&
      this.#digitalCardVariantId &&
      !existingTypes.has(CART_ITEM_TYPES.digitalCard)
    ) {
      const deliveryMethod =
        this.#digitalCardChannel === 'email'
          ? DIGITAL_CARD_DELIVERY_METHODS.email
          : DIGITAL_CARD_DELIVERY_METHODS.text;
      const mpVariantId =
        (this.#selectedVariantId &&
          this.#marketplaceVariantIdMap[this.#selectedVariantId]) ||
        '';

      const dcData = {
        IncludeDigitalCard: 'true',
        MPCardMessageID: this.#digitalCardSelectedId,
        MPCardMessageUrl: this.#digitalCardSelectedImage || '',
        MPCardSenderName: this.#digitalCardFrom,
        MPCardMessage: this.#digitalCardMessage,
        MPCardDeliveryMethod: deliveryMethod,
        MarketPlaceProductID: this.#marketplaceProductId || '',
        MarketPlaceVariantID: mpVariantId,
      };

      if (this.#digitalCardChannel === 'email') {
        dcData.MPCardMessageEmail = this.#digitalCardRecipient;
      } else {
        dcData.MPCardMessageRecipientPhone = this.#digitalCardRecipient;
      }

      items.push({
        id: this.#digitalCardVariantId,
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.digitalCard,
          [CART_PROPERTY_KEYS.digitalCardData]: dcData,
          [CART_PROPERTY_KEYS.isOnGoody]: 'true',
        },
      });
    }

    try {
      const body = JSON.stringify({ items });

      const response = await fetch(Theme.routes.cart_add_url, {
        ...fetchConfig('json', { body }),
      });

      const responseData = await response.json();

      if (responseData.status && responseData.status !== 200) {
        console.error('Cart add error:', responseData.message);
        if (button) {
          button.removeAttribute('disabled');
          button.classList.remove('pd-footer__atc-btn--loading');
        }
        return;
      }

      // Dispatch cart add event
      document.dispatchEvent(
        new CartAddEvent(responseData, this.id || 'personalization-drawer', {
          source: 'personalization-drawer',
          itemCount: items.length,
          variantId: String(this.#selectedVariantId),
        })
      );

      this.close();
    } catch (error) {
      console.error('Personalization drawer: cart add failed', error);
    } finally {
      this.#isAddingToCart = false;
      this.refs.drawer?.classList.remove('pd-drawer--busy');
      if (button) {
        button.removeAttribute('disabled');
        button.classList.remove('pd-footer__atc-btn--loading');
      }
    }
  }

  /**
   * Format price in cents to money string
   * @param {number} cents
   * @returns {string}
   */
  #formatMoney(cents) {
    return formatShopifyMoney(cents, this.dataset.moneyFormat || '{{amount}}', this.dataset.currency || 'USD');
  }

  /**
   * Open the drawer
   */
  open() {
    if (this.#isOpen) return;
    this.#isOpen = true;

    const drawer = this.refs.drawer;

    if (drawer) {
      if (typeof drawer.showModal === 'function' && !drawer.open) {
        drawer.showModal();
      }
      requestAnimationFrame(() => {
        drawer.classList.add('pd-drawer--open');
      });
      // Backdrop click + Escape close the drawer (both gated while ATC runs).
      this.addEventListener('click', this.#boundHandleDialogClick);
      drawer.addEventListener('cancel', this.#boundHandleDialogCancel);
    }

    document.body.style.overflow = 'hidden';

    // Show message-step shimmer (reset from previous open).
    this.#showMessageShimmer(true);
    const msgShimmerStart = Date.now();

    this.#syncMessagesFromCart().finally(() => {
      const elapsed = Date.now() - msgShimmerStart;
      const remaining = Math.max(0, 400 - elapsed);
      setTimeout(() => this.#showMessageShimmer(false), remaining);
    });
    this.#populateOccasionDropdowns();
  }

  /**
   * Toggle the message-step shimmer / real content.
   * @param {boolean} loading
   */
  #showMessageShimmer(loading) {
    const shimmer = this.querySelector('[data-pd-msg-shimmer]');
    const content = this.querySelector('[data-pd-msg-content]');
    if (shimmer) shimmer.style.display = loading ? '' : 'none';
    if (content) content.style.display = loading ? 'none' : '';
  }

  /**
   * Toggle the digital-card-step shimmer / real content.
   * @param {boolean} loading
   */
  #showDigitalCardShimmer(loading) {
    const shimmer = this.querySelector('[data-pd-dc-shimmer]');
    const content = this.querySelector('[data-pd-dc-content]');
    if (shimmer) shimmer.style.display = loading ? '' : 'none';
    if (content) content.style.display = loading ? 'none' : '';
  }

  /**
   * Restore the message-option cards to the "added" state for any gift_message
   * or greeting_card utility line item already present on the cart, so a
   * returning visitor sees Remove / Edit buttons instead of an Add CTA.
   */
  async #syncMessagesFromCart() {
    try {
      const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const cart = await res.json();
      const cartItems = (cart && cart.items) || [];

      let synced = false;

      for (const item of cartItems) {
        const props = item.properties;
        if (!props) continue;
        const itemType = props[CART_PROPERTY_KEYS.itemType];

        if (itemType === CART_ITEM_TYPES.giftMessage) {
          const messageText = props[CART_PROPERTY_KEYS.giftMessageData];
          if (messageText) {
            const freeBtn = this.querySelector('.pd-message-btn--free');
            const card = freeBtn ? freeBtn.closest('.pd-message-card') : null;
            if (card) {
              card.classList.add('pd-message-card--added');
              this.#toggleMessageCardState(card, 'added');
            }
            if (freeBtn) {
              this.#freeMessageVariantId = Number(freeBtn.getAttribute('data-message-variant-id')) || null;
            }
            this.#giftMessageText = messageText;
            synced = true;
          }
        }

        if (itemType === CART_ITEM_TYPES.greetingCard) {
          const paidCard = this.querySelector('.pd-message-card[data-greeting-card-url]');
          if (paidCard) {
            paidCard.classList.add('pd-message-card--added');
            this.#toggleMessageCardState(paidCard, 'added');
            const paidBtn = paidCard.querySelector('[data-message-variant-id]');
            if (paidBtn) {
              this.#paidGreetingCardVariantId = Number(paidBtn.getAttribute('data-message-variant-id')) || null;
            }
          }
          const greetingCardRaw = props[CART_PROPERTY_KEYS.greetingCardData];
          if (greetingCardRaw) {
            this.#greetingCardData = greetingCardRaw;
          }
          synced = true;
        }
      }

      if (synced) {
        this.#updatePrice();
      }
    } catch (error) {
      console.error('Personalization drawer: failed to sync from cart', error);
    }
  }

  /**
   * Close the drawer
   */
  close() {
    if (!this.#isOpen) return;
    this.#isOpen = false;

    const drawer = this.refs.drawer;

    if (drawer) {
      this.removeEventListener('click', this.#boundHandleDialogClick);
      drawer.removeEventListener('cancel', this.#boundHandleDialogCancel);

      drawer.classList.remove('pd-drawer--open');
      drawer.classList.remove('pd-drawer--subview-open');
      const subview = this.querySelector('[data-learn-more-view]');
      if (subview) subview.setAttribute('aria-hidden', 'true');
      const giftMessageView = this.querySelector('[data-gift-message-view]');
      if (giftMessageView) giftMessageView.setAttribute('aria-hidden', 'true');
      this.#giftMessageSubviewOpen = false;
      const greetingCardView = this.querySelector('[data-greeting-card-view]');
      if (greetingCardView) greetingCardView.setAttribute('aria-hidden', 'true');
      this.#greetingCardSubviewOpen = false;
      const digitalCardView = this.querySelector('[data-digital-card-view]');
      if (digitalCardView) digitalCardView.setAttribute('aria-hidden', 'true');
      this.#digitalCardSubviewOpen = false;
    }

    // Wait for the slide-out transition to finish before closing the dialog.
    setTimeout(() => {
      if (!this.#isOpen && drawer && drawer.open) {
        drawer.close();
      }
    }, 300);

    document.body.style.overflow = '';
  }

  /**
   * Close the drawer when the modal backdrop (area outside the dialog box) is
   * clicked. Ignored while an ATC request is in flight.
   * @param {MouseEvent} event
   */
  #handleDialogClick(event) {
    if (this.#isAddingToCart) return;
    const drawer = this.refs.drawer;
    if (!drawer) return;
    if (isClickedOutside(event, drawer)) {
      this.close();
    }
  }

  /**
   * Intercept the dialog's native Escape-key `cancel` so we can run the
   * slide-out animation (and ignore it while an ATC request is in flight).
   * @param {Event} event
   */
  #handleDialogCancel(event) {
    event.preventDefault();
    if (this.#isAddingToCart) return;
    this.close();
  }
}

customElements.define('personalization-drawer', PersonalizationDrawer);
