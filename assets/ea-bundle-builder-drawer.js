import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';
import { CART_ITEM_TYPES, CART_PROPERTY_KEYS } from '@theme/cart-contract';
import { PersonalizationMessages } from '@theme/personalization-messages';
import { trapFocus, removeTrapFocus } from '@theme/focus';
import { hideZendeskLauncher, restoreZendeskLauncher } from '@theme/zendesk-launcher';

const ZENDESK_HIDE_SOURCE = 'bundle-builder';

/**
 * @typedef {Object} BundleItem
 * @property {number} variantId
 * @property {number} productId
 * @property {string} title
 * @property {string} image
 * @property {number} price
 * @property {number} compareAtPrice
 * @property {string} handle
 * @property {string} badge
 * @property {string} variantTitle
 * @property {number} quantity
 * @property {boolean} [isAddon] - true if item was added from Step 2 (add-on)
 */

/**
 * Bundle Builder Drawer component.
 * Renders a right-aligned slide-in panel for building product bundles.
 * Adding an item opens a secondary drawer (variant picker);
 * after confirming, the product card shows a quantity stepper.
 * @extends {Component}
 */
class EaBundleBuilderDrawer extends Component {
  /** @type {BundleItem[]} */
  #selectedItems = [];

  /** @type {boolean} */
  #isOpen = false;

  /** @type {string} */
  #badgeIconUrl = '';

  /** @type {number} Max quantity per bundle item (theme setting) */
  #maxQuantity = 9;

  /** @type {number} Minimum distinct core products required to enable Add to Cart. */
  #minBundleItems = 2;

  /** @type {object|null} Context for the open secondary drawer */
  #secondaryCtx = null;

  /** @type {WeakMap<HTMLElement, string>} Original card pricing HTML per pricing element */
  #originalPricing = new WeakMap();

  /** @type {{ freeDelivery: number, tiers: {threshold:number, percentage:number}[] }} */
  #discountConfig = { freeDelivery: 0, tiers: [] };

  /** @type {{ threshold: number, label: string }[]} Progress markers, ascending */
  #markers = [];

  /** @type {number} Largest threshold among markers (bar scale) */
  #maxThreshold = 0;

  /** @type {PersonalizationMessages|null} Step 3 personal-message flow (hold mode) */
  #messages = null;

  /** @type {HTMLElement|null} Element that triggered the drawer open (restored on close) */
  #triggerElement = null;

  connectedCallback() {
    super.connectedCallback();
    this.#badgeIconUrl = this.dataset.badgeIconUrl || '';
    this.#maxQuantity = Math.max(1, Number(this.dataset.maxQuantity) || 9);
    this.#parseDiscountConfig();
    this.#bindTriggers();
    this.#initAccordions();
    this.#initTabs();
    this.#bindCardButtons();
    this.#initMessages();
    this.#renderProgressMarkers();
    this.#updateProgress();
    this.#updateFooter();

    // Close on Escape key
    document.addEventListener('keydown', this.#handleKeyDown);

    // Expose global open/close functions for external triggers
    window.openBundleBuilderDrawer = () => this.open();
    window.closeBundleBuilderDrawer = () => this.close();
    // Page product cards (bundle-builder page) call this to start the Add flow.
    window.bundleBuilderAddProduct = (productId) => this.addProductById(productId);
  }

  /** Parse the market discount config supplied by Liquid */
  #parseDiscountConfig() {
    try {
      const parsed = JSON.parse(this.dataset.discountConfig || '{}');
      this.#discountConfig = {
        freeDelivery: Number(parsed.freeDelivery) || 0,
        tiers: Array.isArray(parsed.tiers)
          ? parsed.tiers.map((t) => ({ threshold: Number(t.threshold), percentage: Number(t.percentage) }))
          : [],
      };
    } catch {
      this.#discountConfig = { freeDelivery: 0, tiers: [] };
    }
  }

  /** Render progress dots + labels from the discount config (tiers + free delivery) */
  #renderProgressMarkers() {
    const markers = this.#discountConfig.tiers
      .filter((t) => t.threshold > 0)
      .map((t) => ({ threshold: t.threshold, label: `${t.percentage}% off` }));
    if (this.#discountConfig.freeDelivery > 0) {
      markers.push({ threshold: this.#discountConfig.freeDelivery, label: 'Free delivery' });
    }
    markers.sort((a, b) => a.threshold - b.threshold);
    this.#markers = markers;
    this.#maxThreshold = markers.length ? markers[markers.length - 1].threshold : 0;

    const bar = this.querySelector('.bundle-progress__bar');
    const labelsWrap = this.querySelector('.bundle-progress__labels');
    if (!bar || !labelsWrap) return;

    for (const dot of bar.querySelectorAll('.bundle-progress__dot')) dot.remove();
    labelsWrap.innerHTML = '';
    const icon = bar.querySelector('.bundle-progress__icon');

    if (markers.length === 0) {
      if (icon) icon.hidden = true;
      return;
    }

    // Solid start dot at the origin.
    const startDot = document.createElement('span');
    startDot.className = 'bundle-progress__dot bundle-progress__dot--start';
    startDot.style.left = '0%';
    bar.insertBefore(startDot, icon || null);

    const lastIndex = markers.length - 1;
    markers.forEach((m, i) => {
      // Evenly space markers across the bar (equal gap from the start dot at 0%
      // through to the last marker at 100%), independent of threshold magnitude.
      const pct = ((i + 1) / markers.length) * 100;
      const isLast = i === lastIndex;

      // The final (highest) marker is the strawberry; earlier markers are dots.
      if (isLast && icon) {
        icon.style.insetInlineStart = `${pct}%`;
        icon.hidden = false;
      } else {
        const dot = document.createElement('span');
        dot.className = 'bundle-progress__dot';
        dot.style.left = `${pct}%`;
        dot.dataset.threshold = String(m.threshold);
        bar.insertBefore(dot, icon || null);
      }

      const label = document.createElement('span');
      label.className = 'bundle-progress__label';
      label.style.left = `${pct}%`;
      label.textContent = m.label;
      // Anchor the edge labels inward so they never bleed past the drawer.
      if (isLast) {
        label.style.transform = 'translateX(-100%)';
      } else if (i === 0 && pct < 10) {
        label.style.transform = 'translateX(0)';
      }
      labelsWrap.appendChild(label);
    });
  }

  /**
   * Initialise the Step 3 personal-message flow in hold mode. The module owns
   * the cards + subviews; we read its captured state at ATC time. It self-hides
   * Step 3 when neither the free message nor the paid greeting card is available.
   */
  #initMessages() {
    const ds = this.dataset;
    // Self-contained config resolved server-side by the BB section Liquid, so
    // Step 3 never depends on the Personalization Drawer island being present.
    const gcVariantId = ds.gcVariantId && ds.gcVariantId !== '0' ? ds.gcVariantId : null;
    const config = {
      greetingCardVariantId: gcVariantId,
      giftMessageVariantId: ds.gmVariantId && ds.gmVariantId !== '0' ? ds.gmVariantId : null,
      iframeUrl: ds.gcIframeUrl || '',
      // Only show a price suffix when a paid variant actually resolved.
      paidPriceFormatted: gcVariantId ? ds.gcPriceFormatted || '' : '',
      paidButtonLabel: ds.gcButtonLabel || 'Add',
      maxChars: Number(ds.gmMaxChars) || 300,
    };
    this.#messages = new PersonalizationMessages(this, {
      onRequestClose: () => this.close(),
      config,
    });
    this.#messages.init();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.#handleDocumentClick);
    document.removeEventListener('keydown', this.#handleKeyDown);
    removeTrapFocus();
    this.#messages?.destroy();
    delete window.openBundleBuilderDrawer;
    delete window.closeBundleBuilderDrawer;
    delete window.bundleBuilderAddProduct;
  }

  /** @param {MouseEvent} event */
  #handleDocumentClick = (event) => {
    const trigger = event.target.closest('[data-bundle-builder-trigger]');
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      this.open();
    }
  };

  /** @param {KeyboardEvent} event */
  #handleKeyDown = (event) => {
    if (event.key === 'Escape' && this.#isOpen) {
      event.preventDefault();
      this.close();
    }
  };

  /** Bind document-level click listener for trigger buttons */
  #bindTriggers() {
    document.addEventListener('click', this.#handleDocumentClick);
  }

  /** Open the drawer */
  open() {
    if (this.#isOpen) return;
    this.#isOpen = true;

    // Save the trigger element so focus can be restored on close
    this.#triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = this.refs.overlay;
    const drawer = this.refs.drawer;

    overlay.style.display = '';
    drawer.style.display = '';
    drawer.setAttribute('aria-hidden', 'false');

    // Force reflow before adding class
    void drawer.offsetHeight;

    requestAnimationFrame(() => {
      overlay.classList.add('bb-overlay--open');
      drawer.classList.add('bb-drawer--open');
      trapFocus(drawer);
    });

    hideZendeskLauncher(ZENDESK_HIDE_SOURCE);

    // Lock body scroll
    document.body.style.overflow = 'hidden';

    // Reflect any existing cart-wide greeting card / gift message as "added".
    this.#messages?.syncFromCart();

    this.#updateAddonStates();
    this.#updateProgress();
    this.#updateFooter();
  }

  /** Close the drawer */
  close() {
    if (!this.#isOpen) return;
    this.#isOpen = false;

    removeTrapFocus();
    this.#closeSecondary(true);
    this.#messages?.closeSubviews();

    const overlay = this.refs.overlay;
    const drawer = this.refs.drawer;

    overlay.classList.remove('bb-overlay--open');
    drawer.classList.remove('bb-drawer--open');
    drawer.setAttribute('aria-hidden', 'true');

    const onEnd = () => {
      overlay.style.display = 'none';
      drawer.style.display = 'none';
      drawer.removeEventListener('transitionend', onEnd);
    };
    drawer.addEventListener('transitionend', onEnd, { once: true });

    // Fallback if transition doesn't fire
    setTimeout(() => {
      overlay.style.display = 'none';
      drawer.style.display = 'none';
    }, 400);

    // Unlock body scroll
    document.body.style.overflow = '';

    restoreZendeskLauncher(ZENDESK_HIDE_SOURCE);

    // Restore focus to the element that triggered the drawer
    if (this.#triggerElement) {
      this.#triggerElement.focus();
      this.#triggerElement = null;
    }
  }

  /** Handle close button click */
  handleClose(event) {
    event.preventDefault();
    this.close();
  }

  /** Handle overlay (backdrop) click. The on:click binding is delegated on
   *  document, so event.currentTarget is document — compare against the overlay
   *  ref instead (the proxied event.target is the overlay node). */
  handleOverlayClick(event) {
    if (event.target === this.refs.overlay) {
      this.close();
    }
  }

  /** Initialize accordion step headers */
  #initAccordions() {
    const stepHeaders = this.querySelectorAll('.bb-step__header[data-collapsible="true"]');
    for (const header of stepHeaders) {
      header.addEventListener('click', () => {
        const step = header.closest('.bb-step');
        const body = step.querySelector('.bb-step__body');
        const chevron = header.querySelector('.bb-step__chevron');
        const isExpanded = header.getAttribute('aria-expanded') === 'true';

        header.setAttribute('aria-expanded', String(!isExpanded));
        body.hidden = isExpanded;

        if (chevron) {
          chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
        }
      });
    }
  }

  /** Initialize tab switching (show/hide pre-rendered panels) */
  #initTabs() {
    const tabs = this.querySelectorAll('.bb-tab');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const step = tab.closest('.bb-step');
        const tabContainer = tab.closest('.bb-tabs');
        const allTabs = tabContainer.querySelectorAll('.bb-tab');

        // Update tab states
        for (const t of allTabs) {
          t.dataset.active = 'false';
          t.classList.remove('bb-tab--active');
        }
        tab.dataset.active = 'true';
        tab.classList.add('bb-tab--active');

        // Toggle the matching product panel within this step
        const tabName = tab.dataset.tab;
        const panels = step.querySelectorAll('.bb-products__panel');
        for (const panel of panels) {
          panel.hidden = panel.dataset.tabPanel !== tabName;
        }
      });
    }
  }

  /** Bind Add handlers on all pre-rendered product cards */
  #bindCardButtons() {
    const buttons = this.querySelectorAll('.bb-card__action');
    for (const btn of buttons) {
      btn.addEventListener('click', this.#handleCardButtonClick);
    }
  }

  /** Parse JSON dataset value, returning a fallback on error. */
  #parseJSON(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  /** @param {MouseEvent} event */
  #handleCardButtonClick = (event) => {
    event.preventDefault();
    this.#triggerCardAdd(event.currentTarget);
  };

  /**
   * Run the Add decision for a product card's button — used by the card's own
   * click and by external page product cards (window.bundleBuilderAddProduct).
   * @param {HTMLElement} btn
   */
  #triggerCardAdd(btn) {
    if (!btn) return;
    const card = btn.closest('.bb-card');
    if (!card) return;

    const isMulti = btn.dataset.multiVariant === 'true';
    const wrapAvailable = btn.dataset.wrapAvailable === 'true';
    const variants = this.#parseJSON(btn.dataset.variants, []);

    // Single variant + no wrap subtitle → add straight to the bundle, no drawer.
    if (!isMulti && !wrapAvailable) {
      this.#addDirect(btn);
      return;
    }

    // Otherwise open the secondary drawer (variant picker + wrap subtitle).
    this.#openSecondary({
      card,
      productId: Number(btn.dataset.productId),
      title: btn.dataset.title || '',
      image: btn.dataset.image || '',
      handle: btn.dataset.handle || '',
      badge: btn.dataset.badge || '',
      isAddon: btn.dataset.addon === 'true',
      variants: Array.isArray(variants) && variants.length
        ? variants
        : [{
            id: Number(btn.dataset.variantId),
            title: 'Default Title',
            price: Number(btn.dataset.price),
            compare: Number(btn.dataset.comparePrice || 0),
            available: true,
            image: btn.dataset.image || '',
            delivery: '',
          }],
      wrapAvailable,
    });
  }

  /**
   * Open the drawer and start the Add flow for a product (used by page product
   * cards on the bundle-builder page). Routes through the same decision logic:
   * single-variant + no-wrap adds directly; otherwise the secondary drawer opens.
   * @param {number|string} productId
   */
  addProductById(productId) {
    this.open();
    const id = Number(productId);
    // Already in the current draft — just surface the drawer, don't re-add.
    if (this.#selectedItems.some((i) => i.productId === id)) return;
    const btn = this.querySelector(`.bb-card[data-product-id="${id}"] .bb-card__action`);
    if (btn) {
      this.#activateCardTab(btn);
      this.#triggerCardAdd(btn);
    }
  }

  /**
   * Switch the drawer to the tab/step that holds a given card so the shopper
   * sees it after an external trigger.
   * @param {HTMLElement} btn
   */
  #activateCardTab(btn) {
    const panel = btn.closest('.bb-products__panel');
    if (!panel) return;
    const tabName = panel.dataset.tabPanel;
    const step = panel.closest('.bb-step');
    if (!step || tabName == null) return;
    const tab = step.querySelector(`.bb-tab[data-tab="${CSS.escape(tabName)}"]`);
    if (tab) tab.click();
  }

  /**
   * Add a single-variant, no-wrap product directly to the bundle.
   * @param {HTMLElement} btn
   */
  #addDirect(btn) {
    const productId = Number(btn.dataset.productId);
    const isAddon = btn.dataset.addon === 'true';
    this.#removeByProduct(productId);
    this.#addItem({
      variantId: Number(btn.dataset.variantId),
      productId,
      title: btn.dataset.title,
      image: btn.dataset.image,
      price: Number(btn.dataset.price),
      compareAtPrice: Number(btn.dataset.comparePrice || 0),
      handle: btn.dataset.handle,
      badge: btn.dataset.badge || '',
      variantTitle: '',
      quantity: 1,
      isAddon,
    });
    this.#applyCardState(productId);
    this.#updateAddonStates();
    this.#updateProgress();
    this.#updateFooter();
  }

  // ── Secondary drawer (variant picker) ────────────────────────────

  /** Open the secondary drawer for a product. @param {object} ctx */
  #openSecondary(ctx) {
    this.#secondaryCtx = ctx;

    // Pre-select the default variant (first available, else first) — for both
    // single- and multi-variant products — so the Add CTA is enabled by default.
    const defaultVariant = ctx.variants.find((v) => v.available) || ctx.variants[0];
    ctx.selectedVariantId = defaultVariant ? defaultVariant.id : null;

    const titleEl = this.querySelector('[data-bb2-title]');
    if (titleEl) titleEl.textContent = this.dataset.variantSelectTitle || 'Select your size';

    const nameEl = this.querySelector('[data-bb2-product-name]');
    if (nameEl) nameEl.textContent = ctx.title;

    const variantsEl = this.querySelector('[data-bb2-variants]');
    if (variantsEl) {
      variantsEl.innerHTML = this.#renderSecondaryVariants(ctx.variants, ctx.title, ctx.selectedVariantId);
      for (const tile of variantsEl.querySelectorAll('.bb2-variant:not(.bb2-variant--single)')) {
        tile.addEventListener('click', this.#handleSecondaryVariantClick);
      }
    }

    const wrapSection = this.querySelector('[data-bb2-giftwrap]');
    if (wrapSection) wrapSection.hidden = !ctx.wrapAvailable;

    this.#updateSecondaryAddState();

    const overlay = this.refs.secondaryOverlay;
    const drawer = this.refs.secondaryDrawer;
    overlay.style.display = '';
    drawer.style.display = '';
    void drawer.offsetHeight;
    requestAnimationFrame(() => {
      overlay.classList.add('bb2-overlay--open');
      drawer.classList.add('bb2-drawer--open');
      // Move the focus trap to the secondary panel while it's open.
      trapFocus(drawer);
    });
  }

  /** Close the secondary drawer. @param {boolean} [immediate] */
  #closeSecondary(immediate = false) {
    const overlay = this.refs.secondaryOverlay;
    const drawer = this.refs.secondaryDrawer;
    if (!overlay || !drawer) return;
    if (drawer.style.display === 'none' || drawer.style.display === '') {
      if (!drawer.classList.contains('bb2-drawer--open')) {
        this.#secondaryCtx = null;
        return;
      }
    }

    overlay.classList.remove('bb2-overlay--open');
    drawer.classList.remove('bb2-drawer--open');
    this.#secondaryCtx = null;

    // Restore the focus trap to the main drawer (unless the whole drawer is
    // closing — close() has already called removeTrapFocus and set #isOpen false).
    if (this.#isOpen) trapFocus(this.refs.drawer);

    const hide = () => {
      overlay.style.display = 'none';
      drawer.style.display = 'none';
    };
    if (immediate) {
      hide();
      return;
    }
    drawer.addEventListener('transitionend', hide, { once: true });
    setTimeout(hide, 400);
  }

  /** Handle secondary drawer close/back */
  handleSecondaryClose(event) {
    event.preventDefault();
    this.#closeSecondary();
  }

  /** Handle secondary overlay (backdrop) click. See handleOverlayClick — compare
   *  against the ref, not event.currentTarget (which is document under delegation). */
  handleSecondaryOverlayClick(event) {
    if (event.target === this.refs.secondaryOverlay) {
      this.#closeSecondary();
    }
  }

  /** @param {MouseEvent} event */
  #handleSecondaryVariantClick = (event) => {
    const tile = event.currentTarget;
    if (tile.disabled || !this.#secondaryCtx) return;
    this.#secondaryCtx.selectedVariantId = Number(tile.dataset.variantId);
    const all = this.querySelectorAll('[data-bb2-variants] .bb2-variant');
    for (const t of all) {
      t.classList.toggle('bb2-variant--selected', t === tile);
    }
    this.#updateSecondaryAddState();
  };

  /** Enable the secondary Add button once a variant is selected. */
  #updateSecondaryAddState() {
    const addBtn = this.querySelector('[data-bb2-add]');
    if (!addBtn) return;
    addBtn.disabled = !(this.#secondaryCtx && this.#secondaryCtx.selectedVariantId);
  }

  /** Confirm the secondary selection and add the product to the bundle. */
  handleSecondaryAdd(event) {
    event.preventDefault();
    const ctx = this.#secondaryCtx;
    if (!ctx || !ctx.selectedVariantId) return;

    const variant = ctx.variants.find((v) => v.id === ctx.selectedVariantId) || ctx.variants[0];
    const variantTitle = variant.title && variant.title !== 'Default Title' ? variant.title : '';

    this.#removeByProduct(ctx.productId);
    this.#addItem({
      variantId: Number(variant.id),
      productId: ctx.productId,
      title: ctx.title,
      image: ctx.image,
      price: Number(variant.price),
      compareAtPrice: Number(variant.compare || 0),
      handle: ctx.handle,
      badge: ctx.badge,
      variantTitle,
      quantity: 1,
      isAddon: ctx.isAddon || false,
    });

    this.#applyCardState(ctx.productId);
    this.#closeSecondary();
    this.#updateAddonStates();
    this.#updateProgress();
    this.#updateFooter();
  }

  /**
   * Build the secondary variant tile markup.
   * @param {object[]} variants
   * @param {string} productTitle
   * @param {number|null} selectedId
   * @returns {string}
   */
  #renderSecondaryVariants(variants, productTitle, selectedId) {
    const single = variants.length === 1;
    return variants
      .map((v) => {
        const isSelected = v.id === selectedId;
        const showTitle = v.title && v.title !== 'Default Title' ? v.title : productTitle;
        const priceText = `$${(v.price / 100).toFixed(2)}`;
        const compareHTML =
          v.compare > v.price ? `<span class="bb2-variant__compare">$${(v.compare / 100).toFixed(2)}</span>` : '';
        const deliveryHTML =
          v.delivery && this.#badgeIconUrl
            ? `<span class="bb-card__badge"><img class="bb-card__badge-icon" src="${this.#escapeAttr(this.#badgeIconUrl)}" alt="" width="16" height="16"><span class="bb-card__badge-text">${this.#escapeHTML(v.delivery)}</span></span>`
            : '';
        const imageHTML = v.image
          ? `<img class="bb2-variant__image" src="${this.#escapeAttr(v.image)}" alt="${this.#escapeAttr(showTitle)}" width="64" height="64" loading="lazy">`
          : '<span class="bb2-variant__image bb2-variant__image--placeholder"></span>';
        return `
          <button type="button" class="bb2-variant${isSelected ? ' bb2-variant--selected' : ''}${single ? ' bb2-variant--single' : ''}"
            data-variant-id="${v.id}"
            data-price="${v.price}"
            data-compare="${v.compare}"
            ${v.available ? '' : 'disabled'}>
            ${imageHTML}
            <span class="bb2-variant__info">
              <span class="bb2-variant__title">${this.#escapeHTML(showTitle)}</span>
              <span class="bb2-variant__pricing"><span class="bb2-variant__price">${priceText}</span>${compareHTML}</span>
              ${deliveryHTML}
            </span>
          </button>
        `;
      })
      .join('');
  }

  // ── Bundle state ─────────────────────────────────────────────────

  /**
   * Add an item to the bundle
   * @param {BundleItem} item
   */
  #addItem(item) {
    if (!this.#selectedItems.some((i) => i.productId === item.productId)) {
      this.#selectedItems.push(item);
    }
  }

  /**
   * Whether the bundle has at least one non-addon (base) product.
   * @returns {boolean}
   */
  #hasBaseProduct() {
    return this.#selectedItems.some((i) => !i.isAddon);
  }

  /**
   * Enable or disable Step 2 add-on CTA buttons based on whether a base product
   * has been selected. Add-ons require at least one Step 1 product.
   */
  #updateAddonStates() {
    const hasBase = this.#hasBaseProduct();
    const addonBtns = this.querySelectorAll('.bb-card__action[data-addon="true"]');
    for (const btn of addonBtns) {
      // Only gate on the addon requirement — don't override a "Sold out" disabled state
      if (!btn.closest('.bb-card')?.querySelector('.bb-card__qty')) {
        btn.disabled = !hasBase || btn.textContent.trim() === 'Sold out';
      }
    }
  }

  /**
   * Remove all items belonging to a product from the bundle.
   * If removing the last base (non-addon) product, cascade-removes all addons too.
   * @param {number} productId
   */
  #removeByProduct(productId) {
    this.#selectedItems = this.#selectedItems.filter((i) => i.productId !== productId);

    // Cascade: if no base products remain, remove all addon items
    if (!this.#hasBaseProduct()) {
      const addonIds = this.#selectedItems.filter((i) => i.isAddon).map((i) => i.productId);
      this.#selectedItems = this.#selectedItems.filter((i) => !i.isAddon);
      for (const id of addonIds) {
        this.#applyCardState(id);
      }
    }
  }

  /**
   * Render either the Add button or a quantity stepper on every card for a product.
   * @param {number} productId
   */
  #applyCardState(productId) {
    const item = this.#selectedItems.find((i) => i.productId === productId);
    const cards = this.querySelectorAll(`.bb-card[data-product-id="${productId}"]`);
    for (const card of cards) {
      const btn = card.querySelector('.bb-card__action');
      let stepper = card.querySelector('.bb-card__qty');

      if (item) {
        if (btn) btn.style.display = 'none';
        if (!stepper) {
          stepper = this.#buildStepper(productId);
          if (btn) btn.insertAdjacentElement('afterend', stepper);
          else card.querySelector('.bb-card__info')?.appendChild(stepper);
        }
        const value = stepper.querySelector('[data-bb-qty-value]');
        if (value) value.textContent = String(item.quantity);
        const minus = stepper.querySelector('[data-bb-qty-minus]');
        if (minus) minus.setAttribute('aria-label', item.quantity <= 1 ? 'Remove item' : 'Decrease quantity');
        this.#setProductSelected(card, item.variantTitle, item.price);
      } else {
        if (stepper) stepper.remove();
        if (btn) btn.style.display = '';
        this.#restoreProductPrice(card);
      }
    }
  }

  /**
   * Build a quantity stepper element bound to a product.
   * @param {number} productId
   * @returns {HTMLElement}
   */
  #buildStepper(productId) {
    const stepper = document.createElement('div');
    stepper.className = 'bb-card__qty';
    stepper.innerHTML = `
      <button type="button" class="bb-card__qty-btn" data-bb-qty-minus aria-label="Decrease quantity">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 10H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <span class="bb-card__qty-value" data-bb-qty-value>1</span>
      <button type="button" class="bb-card__qty-btn" data-bb-qty-plus aria-label="Increase quantity">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 5V15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 10H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    `;
    stepper.querySelector('[data-bb-qty-minus]').addEventListener('click', () => this.#changeQty(productId, -1));
    stepper.querySelector('[data-bb-qty-plus]').addEventListener('click', () => this.#changeQty(productId, 1));
    return stepper;
  }

  /**
   * Change a product's bundle quantity. Going below 1 removes it (restores Add).
   * @param {number} productId
   * @param {number} delta
   */
  #changeQty(productId, delta) {
    const item = this.#selectedItems.find((i) => i.productId === productId);
    if (!item) return;
    const next = item.quantity + delta;
    if (next < 1) {
      this.#removeByProduct(productId);
    } else if (next > this.#maxQuantity) {
      return;
    } else {
      item.quantity = next;
    }
    this.#applyCardState(productId);
    this.#updateAddonStates();
    this.#updateProgress();
    this.#updateFooter();
  }

  /**
   * Show the chosen variant (name | price) on a card.
   * @param {HTMLElement} card
   * @param {string} variantTitle
   * @param {number} priceCents
   */
  #setProductSelected(card, variantTitle, priceCents) {
    const pricing = card.querySelector('.bb-card__pricing');
    if (!pricing) return;
    if (!this.#originalPricing.has(pricing)) {
      this.#originalPricing.set(pricing, pricing.innerHTML);
    }
    const label = variantTitle ? `${variantTitle} | ` : '';
    pricing.innerHTML = `<span class="bb-card__price">${this.#escapeHTML(label)}$${(priceCents / 100).toFixed(2)}</span>`;
  }

  /**
   * Restore the original "Starting at" pricing on a card.
   * @param {HTMLElement} card
   */
  #restoreProductPrice(card) {
    const pricing = card.querySelector('.bb-card__pricing');
    if (pricing && this.#originalPricing.has(pricing)) {
      pricing.innerHTML = this.#originalPricing.get(pricing);
    }
  }

  /**
   * Escape text for safe HTML output
   * @param {string} str
   * @returns {string}
   */
  #escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  /**
   * Escape a value for an HTML attribute
   * @param {string} str
   * @returns {string}
   */
  #escapeAttr(str) {
    return (str == null ? '' : String(str))
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Calculate bundle total in cents (price × quantity) */
  #getBundleTotal() {
    return this.#selectedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  /**
   * Map a bundle total to a fill percentage across the evenly-spaced markers.
   * The fill interpolates within each segment so it lands exactly on a marker
   * when its threshold is reached (markers are equally spaced, not value-scaled).
   * @param {number} total
   * @returns {number}
   */
  #progressPercent(total) {
    const markers = this.#markers;
    const n = markers.length;
    if (!n) return 0;
    let prevValue = 0;
    let prevPos = 0;
    for (let i = 0; i < n; i++) {
      const value = markers[i].threshold;
      const pos = ((i + 1) / n) * 100;
      if (total <= value) {
        if (value <= prevValue) return prevPos;
        const frac = (total - prevValue) / (value - prevValue);
        return Math.max(0, prevPos + frac * (pos - prevPos));
      }
      prevValue = value;
      prevPos = pos;
    }
    return 100;
  }

  /** Update the progress bar and threshold indicators */
  #updateProgress() {
    const total = this.#getBundleTotal() / 100;
    const freeDelivery = this.#discountConfig.freeDelivery;

    // Update progress bar fill (interpolated across the evenly-spaced markers)
    const fill = this.querySelector('.bundle-progress__fill');
    if (fill) {
      fill.style.width = `${this.#progressPercent(total)}%`;
    }

    // Update threshold dots (the solid start dot has no threshold — leave it alone)
    const dots = this.querySelectorAll('.bundle-progress__dot');
    for (const dot of dots) {
      if (dot.dataset.threshold == null) continue;
      const threshold = Number(dot.dataset.threshold);
      dot.classList.toggle('bundle-progress__dot--active', total >= threshold);
    }

    // Update progress text (anchored on the free-delivery threshold; amount bold)
    const textEl = this.querySelector('.bundle-progress__text');
    if (textEl) {
      if (freeDelivery > 0) {
        const remaining = Math.max(freeDelivery - total, 0);
        textEl.innerHTML = remaining > 0
          ? `Add <strong>$${remaining.toFixed(2)}</strong> more to get free delivery`
          : 'You qualify for free delivery!';
      } else {
        textEl.textContent = '';
      }
    }
  }

  /** Update the footer (total savings, ATC button text) */
  #updateFooter() {
    const total = this.#getBundleTotal() / 100;

    // Highest discount tier whose threshold the bundle total has reached.
    let discountPercent = 0;
    for (const tier of this.#discountConfig.tiers) {
      if (total >= tier.threshold) {
        discountPercent = Math.max(discountPercent, tier.percentage);
      }
    }

    const savings = total * (discountPercent / 100);
    const finalPrice = total - savings;

    // Update savings display
    const savingsAmount = this.querySelector('.bb-footer__savings-amount');
    if (savingsAmount) {
      savingsAmount.textContent = `$${savings.toFixed(2)}`;
    }

    const savingsRow = this.querySelector('.bb-footer__savings');
    if (savingsRow) {
      savingsRow.style.display = savings > 0 ? '' : 'none';
    }

    // Update ATC button
    const atcBtn = this.querySelector('.bb-footer__atc');
    if (atcBtn) {
      const baseText = this.dataset.addToCartText || 'Add to Cart';
      // Gift wraps are attached to a product (not separate selections), so they
      // never count here — the bundle needs at least #minBundleItems core products
      // and at least one base (non-addon) product.
      if (this.#selectedItems.length >= this.#minBundleItems && this.#hasBaseProduct()) {
        atcBtn.textContent = `${baseText} - $${finalPrice.toFixed(2)}`;
        atcBtn.disabled = false;
      } else {
        atcBtn.textContent = baseText;
        atcBtn.disabled = true;
      }
    }
  }

  /** Handle ATC button click */
  async handleAddToCart(event) {
    event.preventDefault();

    // Mirror the footer button's enabled state: enough items AND a base product.
    if (this.#selectedItems.length < this.#minBundleItems || !this.#hasBaseProduct()) return;

    const atcBtn = this.querySelector('.bb-footer__atc');
    if (atcBtn) {
      atcBtn.disabled = true;
      atcBtn.textContent = 'Adding...';
    }

    try {
      // Bundle lines carry only `_item_type: bundle_line_item` so identical
      // variants merge into one cart line and the discount function keys off the
      // type alone.
      const items = [];
      let lineOrder = 0;
      for (const item of this.#selectedItems) {
        // Bundle products are never on-goody — stamp it explicitly so the lines
        // are correct even if the cart-conflict guard isn't present.
        lineOrder += 1;
        const bundleProps = {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.bundleLineItem,
          [CART_PROPERTY_KEYS.isOnGoody]: 'false',
          [CART_PROPERTY_KEYS.lineItemOrder]: String(lineOrder),
        };
        if (item.isAddon) {
          bundleProps[CART_PROPERTY_KEYS.isBundleAddon] = 'true';
        }
        items.push({ id: item.variantId, quantity: item.quantity, properties: bundleProps });
      }

      // Step 3 — append the held personal message / greeting card as cart-wide
      // singleton lines. Clear any pre-existing singletons first (e.g. left by
      // the cart drawer) so we never duplicate them.
      const messageItems = this.#messages ? this.#messages.buildLineItems() : [];
      if (messageItems.length) {
        await this.#messages.clearExistingSingletons();
        items.push(...messageItems);
      }

      const itemCount = items.length;
      // Abort the add if the request hangs so the button never sticks on "Adding...".
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        response = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // The cart-conflict modal returns 409 when the shopper chooses to keep a
      // conflicting cart instead of clearing it. Nothing was added — quietly
      // restore the footer (keeping selections) so they can decide again.
      if (response.status === 409) {
        this.#updateFooter();
        return;
      }

      if (!response.ok) {
        throw new Error(`Cart add failed: ${response.status}`);
      }

      const responseData = await response.json();

      // Reset state — restore each selected product's default "Starting at" price
      // and Add button, then clear.
      const productIds = this.#selectedItems.map((i) => i.productId);
      this.#selectedItems = [];
      for (const productId of productIds) {
        this.#applyCardState(productId);
      }
      this.#messages?.reset();
      this.#updateProgress();
      this.#updateFooter();

      // Close the bundle drawer, then open the real cart drawer with fresh items.
      // The cart drawer auto-opens + refreshes when it receives a CartAddEvent.
      this.close();
      document.dispatchEvent(
        new CartAddEvent(responseData, this.id || 'ea-bundle-builder-drawer', {
          source: 'ea-bundle-builder-drawer',
          itemCount,
        })
      );
    } catch (error) {
      console.error('[BundleBuilder] ATC error:', error);
      if (atcBtn) {
        atcBtn.textContent = 'Error - Try Again';
        atcBtn.disabled = false;
      }
    }
  }
}

customElements.define('ea-bundle-builder-drawer', EaBundleBuilderDrawer);
