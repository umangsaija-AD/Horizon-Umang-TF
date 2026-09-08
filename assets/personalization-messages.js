import { CART_ITEM_TYPES, CART_PROPERTY_KEYS } from '@theme/cart-contract';

/**
 * Personalization Messages — shared flow module.
 *
 * Owns the personal-message UI + flow shared by the Cart Drawer and the Bundle
 * Builder Drawer: the two cards (free gift message / paid Printible greeting
 * card), both subviews (write-own + AI generate tabs with char counter; greeting
 * card occasion picker → Printible iframe), occasions fetch + custom dropdowns,
 * the AI generate call, and the Printible `postMessage` handler.
 *
 * Configuration is read from the `#cd-personalization-message-config` island
 * rendered by the Personalization Drawer (single source of truth — no new
 * merchant settings).
 *
 * Commit is host-driven:
 *   - Default (hold mode, used by the Bundle Builder): the module HOLDS the
 *     captured gift message text + greeting card data in memory and toggles the
 *     card add/added UI itself. The host reads `buildLineItems()` at its own
 *     Add-to-Cart time and calls `reset()` afterwards.
 *   - A host may pass async `handlers` (add/remove gift message + greeting card)
 *     to commit immediately on completion instead (future Cart Drawer use).
 *
 * All DOM is addressed via `data-pm-*` attributes so the module is host-agnostic.
 */

const PRINTIBLE_HOST_URL = 'https://myedible.myshopify.com';

export class PersonalizationMessages {
  /** @type {HTMLElement} */
  #root;
  /** @type {HTMLElement|null} */
  #mainView = null;
  /** @type {{add?:Function,removeGiftMessage?:Function,removeGreetingCard?:Function,addGiftMessage?:Function,addGreetingCard?:Function}|null} */
  #handlers = null;
  /** @type {(() => void)|null} Close-the-host-drawer callback for the subview "X". */
  #onRequestClose = null;
  /** @type {Object|null} Host-supplied config (takes precedence over the island). */
  #providedConfig = null;

  /** @type {Object} */
  #config = {};
  /** @type {string|null} */
  #giftMessageVariantId = null;
  /** @type {string|null} */
  #greetingCardVariantId = null;
  /** @type {string} */
  #greetingCardBaseUrl = '';
  /** @type {number} */
  #maxChars = 300;

  /** @type {string} Captured gift message text (held until host commits) */
  #giftMessageText = '';
  /** @type {Object|null} Captured Printible greeting card payload */
  #greetingCardData = null;
  /** @type {string|null} */
  #greetingCardOccasionId = null;
  /** @type {string|null} */
  #selectedOccasion = null;

  /** @type {Array<{id:number|string,name:string}>|null} */
  #occasionsData = null;
  /** @type {Promise<any>|null} */
  #occasionsPromise = null;

  #initialized = false;
  #boundPrintible = (event) => this.#handlePrintibleMessage(event);
  #boundOutsideClick = (event) => this.#handleOutsideClick(event);

  /**
   * @param {HTMLElement} root - element to scope all queries to
   * @param {Object} [options]
   * @param {string} [options.mainViewSelector] - selector of the main view to hide while a subview is open
   * @param {Object} [options.handlers] - optional immediate-commit handlers
   */
  constructor(root, options = {}) {
    this.#root = root;
    if (options.mainViewSelector) {
      this.#mainView = root.querySelector(options.mainViewSelector);
    }
    this.#handlers = options.handlers || null;
    this.#onRequestClose = typeof options.onRequestClose === 'function' ? options.onRequestClose : null;
    this.#providedConfig = options.config || null;
  }

  /** Close the host drawer if a close callback was supplied, else just the subview. */
  #requestClose(closeSubview) {
    if (this.#onRequestClose) this.#onRequestClose();
    else closeSubview();
  }

  /**
   * Configure and wire the message flow. Card/step visibility is decided
   * server-side (Liquid) — the module never hides them — so the UI renders even
   * if config is partial. Safe to call once.
   */
  init() {
    if (this.#initialized) return;

    this.#applyConfig();
    this.#populateOccasionDropdowns();
    this.#wireCards();
    this.#wireGiftMessageView();
    this.#wireGreetingCardView();

    window.addEventListener('message', this.#boundPrintible);
    document.addEventListener('click', this.#boundOutsideClick);

    this.#initialized = true;
  }

  /** Remove global listeners. Call from the host's disconnectedCallback. */
  destroy() {
    window.removeEventListener('message', this.#boundPrintible);
    document.removeEventListener('click', this.#boundOutsideClick);
  }

  /* ===== Public state accessors (hold mode) ===== */

  /** @returns {boolean} */
  get hasGiftMessage() {
    return !!this.#giftMessageText;
  }

  /** @returns {boolean} */
  get hasGreetingCard() {
    return !!this.#greetingCardData;
  }

  /** @returns {string} */
  get giftMessageText() {
    return this.#giftMessageText;
  }

  /** @returns {Object|null} */
  get greetingCardData() {
    return this.#greetingCardData;
  }

  /**
   * Build the cart line items for the currently held message / greeting card,
   * for the host to append to its own /cart/add.js batch.
   * @returns {Array<{id:number,quantity:number,properties:Object}>}
   */
  buildLineItems() {
    const items = [];
    if (this.#giftMessageText && this.#giftMessageVariantId) {
      items.push({
        id: parseInt(this.#giftMessageVariantId, 10),
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.giftMessage,
          [CART_PROPERTY_KEYS.giftMessageData]: this.#giftMessageText,
          [CART_PROPERTY_KEYS.isOnGoody]: 'false',
        },
      });
    }
    if (this.#greetingCardData && this.#greetingCardVariantId) {
      items.push({
        id: parseInt(this.#greetingCardVariantId, 10),
        quantity: 1,
        properties: {
          [CART_PROPERTY_KEYS.itemType]: CART_ITEM_TYPES.greetingCard,
          [CART_PROPERTY_KEYS.greetingCardData]: this.#greetingCardData,
          [CART_PROPERTY_KEYS.isOnGoody]: 'false',
        },
      });
    }
    return items;
  }

  /**
   * Remove any existing cart-wide gift_message / greeting_card singleton lines
   * before the host commits new ones (avoids duplicates with the cart drawer).
   * Uses /cart/update.js (not intercepted by the cart-conflict guard).
   * @returns {Promise<void>}
   */
  async clearExistingSingletons() {
    if (!this.#giftMessageText && !this.#greetingCardData) return;
    let cart;
    try {
      const response = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      cart = await response.json();
    } catch {
      return;
    }

    const types = new Set([CART_ITEM_TYPES.giftMessage, CART_ITEM_TYPES.greetingCard]);
    /** @type {Record<string, number>} */
    const updates = {};
    for (const item of cart.items || []) {
      const itemType = item.properties?.[CART_PROPERTY_KEYS.itemType];
      if (types.has(itemType)) updates[item.key] = 0;
    }
    if (Object.keys(updates).length === 0) return;

    try {
      await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
    } catch {
      /* best effort — duplicates are deduped by the cart drawer's upsert anyway */
    }
  }

  /**
   * Re-hydrate the card "added" states from the current cart. If a cart-wide
   * greeting_card / gift_message line already exists (e.g. added by a previous
   * bundle, or by the cart drawer), reflect it as "added" in the host drawer —
   * mirrors the Personalization / Cart drawers. A locally-held (uncommitted)
   * selection is never overwritten by an empty cart.
   * @returns {Promise<void>}
   */
  async syncFromCart() {
    let cart;
    try {
      const response = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      cart = await response.json();
    } catch {
      return;
    }
    const items = cart.items || [];
    const gcLine = items.find(
      (i) => i.properties?.[CART_PROPERTY_KEYS.itemType] === CART_ITEM_TYPES.greetingCard
    );
    const gmLine = items.find(
      (i) => i.properties?.[CART_PROPERTY_KEYS.itemType] === CART_ITEM_TYPES.giftMessage
    );

    // Greeting card
    if (gcLine) {
      const raw = gcLine.properties?.[CART_PROPERTY_KEYS.greetingCardData];
      this.#greetingCardData =
        typeof raw === 'string' ? this.#parseJsonMaybe(raw) || raw : raw || { fromCart: true };
      this.#toggleCardState('greeting-card', true);
    } else if (!this.#greetingCardData) {
      this.#toggleCardState('greeting-card', false);
    }

    // Gift message
    if (gmLine) {
      const text = gmLine.properties?.[CART_PROPERTY_KEYS.giftMessageData] || '';
      this.#giftMessageText = text;
      this.#toggleCardState('gift-message', true);
      const textarea = this.#q('[data-pm-gm-textarea]');
      if (textarea) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input'));
      }
    } else if (!this.#giftMessageText) {
      this.#toggleCardState('gift-message', false);
    }
  }

  /** @param {string} value @returns {Object|null} */
  #parseJsonMaybe(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Close both subviews (e.g. when the host drawer closes). */
  closeSubviews() {
    this.#closeGiftMessageView();
    this.#closeGreetingCardView();
  }

  /** Clear held state and reset both cards to their "add" state. */
  reset() {
    this.#giftMessageText = '';
    this.#greetingCardData = null;
    this.#greetingCardOccasionId = null;
    this.#toggleCardState('gift-message', false);
    this.#toggleCardState('greeting-card', false);
  }

  /* ===== Internal: config ===== */

  /** @param {string} selector @returns {HTMLElement|null} */
  #q(selector) {
    return this.#root.querySelector(selector);
  }

  /** @param {string} selector @returns {NodeListOf<HTMLElement>} */
  #qa(selector) {
    return this.#root.querySelectorAll(selector);
  }

  /** @returns {Object} Config from the shared island (fallback source). */
  #getIslandConfig() {
    const el = document.getElementById('cd-personalization-message-config');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent) || {};
    } catch {
      return {};
    }
  }

  /**
   * Merge the island config with any host-supplied config. Host values win, so
   * a self-contained host (the Bundle Builder) drives the flow without the
   * Personalization Drawer island being present.
   * @returns {Object}
   */
  #getMessageConfig() {
    const island = this.#getIslandConfig();
    if (!this.#providedConfig) return island;
    const merged = { ...island };
    // Host values win, but null/empty host values fall back to the island (e.g.
    // the gift message variant comes from the shared config island when the
    // Bundle Builder has no gift message product of its own).
    for (const [key, value] of Object.entries(this.#providedConfig)) {
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
    return merged;
  }

  /** Apply the shared config island to the markup (variants, copy, occasions). */
  #applyConfig() {
    const cfg = this.#getMessageConfig();
    this.#config = cfg;

    this.#giftMessageVariantId =
      cfg.giftMessageVariantId != null ? String(cfg.giftMessageVariantId) : null;
    this.#greetingCardVariantId =
      cfg.greetingCardVariantId != null ? String(cfg.greetingCardVariantId) : null;
    this.#greetingCardBaseUrl = cfg.iframeUrl || '';
    this.#maxChars = parseInt(cfg.maxChars, 10) || 300;

    const setText = (selector, value) => {
      if (!value) return;
      const node = this.#q(selector);
      if (node) node.textContent = value;
    };

    setText('[data-pm-greeting-card-title]', cfg.paidTitle);
    setText('[data-pm-gift-message-title]', cfg.freeTitle);
    setText('[data-pm-gm-description]', cfg.freeDescription);

    const gcBtn = this.#q('[data-pm-greeting-card-trigger]');
    if (gcBtn && cfg.paidButtonLabel) {
      gcBtn.textContent = cfg.paidPriceFormatted
        ? `${cfg.paidButtonLabel} - ${cfg.paidPriceFormatted}`
        : cfg.paidButtonLabel;
    }
    const gmBtn = this.#q('[data-pm-gift-message-trigger]');
    if (gmBtn && cfg.freeButtonLabel) gmBtn.textContent = cfg.freeButtonLabel;

    setText('[data-pm-gm-tab="write-own"]', cfg.tabWriteOwn);
    setText('[data-pm-gm-tab="generate"]', cfg.tabGenerate);

    const maxAttr = String(this.#maxChars);
    this.#qa('[data-pm-gm-textarea], [data-pm-gm-generated-textarea]').forEach((ta) => {
      ta.setAttribute('maxlength', maxAttr);
    });
    const counter = this.#q('[data-pm-gm-counter]');
    if (counter) {
      const ta = this.#q('[data-pm-gm-textarea]');
      counter.textContent = `${ta ? ta.value.length : 0}/${this.#maxChars}`;
    }

    // Seed dropdown options from the config island occasions (label + PD id).
    if (Array.isArray(cfg.occasions) && cfg.occasions.length) {
      const gmList = this.#q('[data-pm-gm-dropdown-list]');
      if (gmList) {
        gmList.innerHTML = '';
        for (const occ of cfg.occasions) {
          if (!occ || !occ.label) continue;
          gmList.appendChild(this.#buildOccasionLi('gm', occ.label));
        }
      }
      const gcList = this.#q('[data-pm-gc-dropdown-list]');
      if (gcList) {
        gcList.innerHTML = '';
        for (const occ of cfg.occasions) {
          if (!occ || !occ.id) continue;
          gcList.appendChild(this.#buildOccasionLi('gc', occ.label, occ.id));
        }
      }
    }
  }

  /**
   * @param {'gm'|'gc'} kind
   * @param {string} label
   * @param {string|number} [id]
   * @returns {HTMLLIElement}
   */
  #buildOccasionLi(kind, label, id) {
    const li = document.createElement('li');
    li.className = 'pm-dropdown-item';
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');
    if (kind === 'gm') {
      li.setAttribute('data-pm-gm-occasion', String(label));
    } else {
      li.setAttribute('data-pm-gc-occasion', String(label));
      li.setAttribute('data-pm-gc-occasion-id', id != null ? String(id) : '');
    }
    li.textContent = String(label);
    return li;
  }

  /* ===== Internal: occasions ===== */

  /** @returns {Promise<Array<{id:number|string,name:string}>>} */
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
        console.error('Personalization messages: failed to fetch occasions', error);
        this.#occasionsData = [];
      }
      return this.#occasionsData;
    })();

    return this.#occasionsPromise;
  }

  /** Populate both occasion dropdowns from the EA occasions API. */
  async #populateOccasionDropdowns() {
    const occasions = await this.#fetchOccasions();
    if (!occasions.length) return;

    const gmList = this.#q('[data-pm-gm-dropdown-list]');
    if (gmList) {
      gmList.innerHTML = '';
      for (const occasion of occasions) {
        if (!occasion || !occasion.name) continue;
        gmList.appendChild(this.#buildOccasionLi('gm', occasion.name));
      }
    }

    const gcList = this.#q('[data-pm-gc-dropdown-list]');
    if (gcList) {
      gcList.innerHTML = '';
      for (const occasion of occasions) {
        if (!occasion || !occasion.name) continue;
        gcList.appendChild(this.#buildOccasionLi('gc', occasion.name, occasion.id != null ? occasion.id : ''));
      }
    }
  }

  /* ===== Internal: cards + subview show/hide ===== */

  /** Wire card open triggers + added-state actions (single delegated listener). */
  #wireCards() {
    const root = this.#q('[data-pm-root]') || this.#root;
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-pm-gift-message-trigger]')) {
        this.#openGiftMessageView();
        return;
      }
      if (event.target.closest('[data-pm-greeting-card-trigger]')) {
        this.#openGreetingCardView();
        return;
      }
      const gmAction = event.target.closest('[data-pm-gift-message-action]');
      if (gmAction) {
        const action = gmAction.dataset.pmGiftMessageAction;
        if (action === 'remove') this.#handleRemoveGiftMessage();
        else if (action === 'edit') this.#handleEditGiftMessage();
        return;
      }
      const gcAction = event.target.closest('[data-pm-greeting-card-action]');
      if (gcAction) {
        const action = gcAction.dataset.pmGreetingCardAction;
        if (action === 'remove') this.#handleRemoveGreetingCard();
        else if (action === 'change') this.#handleChangeGreetingCard();
      }
    });
  }

  /**
   * Toggle a card between "add" and "added" states.
   * @param {'gift-message'|'greeting-card'} card
   * @param {boolean} added
   */
  #toggleCardState(card, added) {
    const cardEl = this.#q(`[data-pm-card="${card}"]`);
    if (!cardEl) return;
    cardEl.classList.toggle('pm-card--added', added);
    const addState = cardEl.querySelector('[data-pm-message-state="add"]');
    const addedState = cardEl.querySelector('[data-pm-message-state="added"]');
    if (addState) addState.style.display = added ? 'none' : '';
    if (addedState) addedState.style.display = added ? '' : 'none';
  }

  /**
   * @param {HTMLElement|null} panel
   * @param {boolean} show
   */
  #showPanel(panel, show) {
    if (panel) panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (this.#mainView) this.#mainView.setAttribute('aria-hidden', show ? 'true' : 'false');
  }

  #openGiftMessageView() {
    const writeOwnTab = this.#q('[data-pm-gm-tab="write-own"]');
    if (writeOwnTab && !writeOwnTab.classList.contains('pm-tab--active')) {
      writeOwnTab.click();
    }
    const textarea = this.#q('[data-pm-gm-textarea]');
    if (textarea) {
      textarea.value = this.#giftMessageText;
      textarea.dispatchEvent(new Event('input'));
    }
    this.#showPanel(this.#q('[data-pm-gift-message-view]'), true);
  }

  #closeGiftMessageView() {
    this.#showPanel(this.#q('[data-pm-gift-message-view]'), false);
  }

  #openGreetingCardView() {
    const panel = this.#q('[data-pm-greeting-card-view]');
    const iframe = panel?.querySelector('[data-pm-gc-iframe]');
    const wrap = panel?.querySelector('[data-pm-gc-occasion-wrap]');

    if (iframe && iframe.getAttribute('src')) {
      if (wrap) wrap.style.display = 'none';
      iframe.style.display = '';
    } else {
      if (wrap) wrap.style.display = '';
      if (iframe) iframe.style.display = 'none';
    }
    this.#showPanel(panel, true);
  }

  #closeGreetingCardView() {
    this.#showPanel(this.#q('[data-pm-greeting-card-view]'), false);
  }

  #handleChangeGreetingCard() {
    this.#greetingCardOccasionId = null;
    this.#resetGreetingCardSubviewUi();
    this.#openGreetingCardView();
  }

  #handleEditGiftMessage() {
    this.#openGiftMessageView();
  }

  /** Reset the greeting card subview to the occasion picker (clears iframe). */
  #resetGreetingCardSubviewUi() {
    const panel = this.#q('[data-pm-greeting-card-view]');
    if (!panel) return;
    const iframe = panel.querySelector('[data-pm-gc-iframe]');
    const wrap = panel.querySelector('[data-pm-gc-occasion-wrap]');
    const value = panel.querySelector('[data-pm-gc-dropdown-value]');
    const trigger = panel.querySelector('[data-pm-gc-dropdown-trigger]');
    const list = panel.querySelector('[data-pm-gc-dropdown-list]');
    if (iframe) {
      iframe.removeAttribute('src');
      iframe.style.display = 'none';
    }
    if (wrap) wrap.style.display = '';
    if (value) {
      value.textContent = '';
      value.style.display = 'none';
    }
    if (trigger) trigger.classList.remove('pm-field__select--filled', 'pm-field__select--open');
    if (list) {
      list.style.display = 'none';
      for (const i of list.querySelectorAll('[data-pm-gc-occasion]')) {
        i.classList.remove('pm-dropdown-item--selected');
      }
    }
  }

  /* ===== Internal: gift message subview (write own + generate) ===== */

  #wireGiftMessageView() {
    const panel = this.#q('[data-pm-gift-message-view]');
    if (!panel) return;
    const back = panel.querySelector('[data-pm-gift-message-back]');
    const close = panel.querySelector('[data-pm-gift-message-close]');
    if (back) back.addEventListener('click', () => this.#closeGiftMessageView());
    if (close) close.addEventListener('click', () => this.#requestClose(() => this.#closeGiftMessageView()));

    this.#setupGiftMessageTabs(panel);
    this.#setupWriteOwnMessage(panel);
    this.#setupGenerateMessage(panel);
  }

  /** @param {Element} panel */
  #setupGiftMessageTabs(panel) {
    const tabs = panel.querySelectorAll('[data-pm-gm-tab]');
    const panels = panel.querySelectorAll('[data-pm-gm-panel]');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const tabId = tab.getAttribute('data-pm-gm-tab');
        for (const t of tabs) {
          t.classList.toggle('pm-tab--active', t.getAttribute('data-pm-gm-tab') === tabId);
        }
        for (const p of panels) {
          p.style.display = p.getAttribute('data-pm-gm-panel') === tabId ? '' : 'none';
        }
      });
    }
  }

  /** @param {Element} panel */
  #setupWriteOwnMessage(panel) {
    const textarea = panel.querySelector('[data-pm-gm-textarea]');
    const counter = panel.querySelector('[data-pm-gm-counter]');
    const errorEl = panel.querySelector('[data-pm-gm-error]');
    const submitBtn = panel.querySelector('[data-pm-gm-submit]');
    if (!textarea || !counter || !submitBtn) return;

    const maxChars = this.#maxChars;
    const updateState = () => {
      const length = textarea.value.length;
      counter.textContent = `${length}/${maxChars}`;
      const isAtMax = length >= maxChars;
      const hasContent = length > 0;
      textarea.classList.toggle('pm-textarea--error', isAtMax);
      counter.classList.toggle('pm-counter--error', isAtMax);
      if (errorEl) errorEl.style.display = isAtMax ? '' : 'none';
      textarea.classList.toggle('pm-textarea--filled', hasContent && !isAtMax);
      submitBtn.disabled = !hasContent;
      submitBtn.classList.toggle('pm-btn--disabled', !hasContent);
    };

    textarea.addEventListener('input', updateState);
    textarea.addEventListener('paste', () => requestAnimationFrame(updateState));
    submitBtn.addEventListener('click', () => {
      if (!textarea.value.trim()) return;
      this.#handleAddGiftMessage(textarea.value.trim());
    });
  }

  /** @param {Element} panel */
  #setupGenerateMessage(panel) {
    const dropdownTrigger = panel.querySelector('[data-pm-gm-dropdown-trigger]');
    const dropdownList = panel.querySelector('[data-pm-gm-dropdown-list]');
    const dropdownValue = panel.querySelector('[data-pm-gm-dropdown-value]');
    const nameInput = panel.querySelector('[data-pm-gm-name-input]');
    const nameLabel = panel.querySelector('[data-pm-gm-name-label]');
    const generateBtn = panel.querySelector('[data-pm-gm-generate-btn]');
    const generatedWrap = panel.querySelector('[data-pm-gm-generated-wrap]');
    const generatedTextarea = panel.querySelector('[data-pm-gm-generated-textarea]');
    const generatedCounter = panel.querySelector('[data-pm-gm-generated-counter]');
    const generatedError = panel.querySelector('[data-pm-gm-generated-error]');
    const postGenerate = panel.querySelector('[data-pm-gm-post-generate]');
    const submitGenerated = panel.querySelector('[data-pm-gm-submit-generated]');
    const regenerateBtn = panel.querySelector('[data-pm-gm-regenerate-btn]');

    const maxChars = this.#maxChars;
    this.#selectedOccasion = null;

    if (dropdownTrigger && dropdownList) {
      dropdownTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = dropdownList.style.display !== 'none';
        dropdownList.style.display = isOpen ? 'none' : '';
        dropdownTrigger.classList.toggle('pm-field__select--open', !isOpen);
        dropdownTrigger.setAttribute('aria-expanded', String(!isOpen));
      });
      dropdownTrigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          dropdownTrigger.click();
        }
      });
      dropdownList.addEventListener('click', (event) => {
        const item = event.target.closest('[data-pm-gm-occasion]');
        if (!item) return;
        event.stopPropagation();
        const value = item.getAttribute('data-pm-gm-occasion');
        this.#selectedOccasion = value;
        if (dropdownValue) {
          dropdownValue.textContent = value;
          dropdownValue.style.display = '';
        }
        for (const i of dropdownList.querySelectorAll('[data-pm-gm-occasion]')) {
          i.classList.toggle('pm-dropdown-item--selected', i === item);
        }
        dropdownList.style.display = 'none';
        dropdownTrigger.classList.remove('pm-field__select--open');
        dropdownTrigger.classList.add('pm-field__select--filled');
        dropdownTrigger.setAttribute('aria-expanded', 'false');
        this.#updateGenerateButtonState(panel);
      });
      dropdownList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target.closest('[data-pm-gm-occasion]');
        if (!item) return;
        event.preventDefault();
        item.click();
      });
    }

    if (nameInput && nameLabel) {
      const inputWrap = nameInput.closest('.pm-field__input-wrap');
      const updateNameState = () => {
        const hasValue = nameInput.value.length > 0;
        if (inputWrap) {
          inputWrap.classList.toggle('pm-field__input-wrap--active', hasValue || document.activeElement === nameInput);
          inputWrap.classList.toggle('pm-field__input-wrap--filled', hasValue);
        }
        this.#updateGenerateButtonState(panel);
      };
      nameInput.addEventListener('input', updateNameState);
      nameInput.addEventListener('focus', () => {
        if (inputWrap) {
          inputWrap.classList.add('pm-field__input-wrap--active');
          inputWrap.classList.add('pm-field__input-wrap--focused');
        }
      });
      nameInput.addEventListener('blur', () => {
        if (inputWrap) {
          if (!nameInput.value) inputWrap.classList.remove('pm-field__input-wrap--active');
          inputWrap.classList.remove('pm-field__input-wrap--focused');
        }
      });
    }

    if (generateBtn) {
      generateBtn.addEventListener('click', async () => {
        if (!this.#selectedOccasion || !nameInput?.value.trim()) return;
        const originalText = generateBtn.textContent;
        generateBtn.textContent = 'Generating...';
        generateBtn.disabled = true;
        generateBtn.classList.add('pm-btn--disabled');
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
          generateBtn.classList.remove('pm-btn--disabled');
        }
      });
    }

    if (generatedTextarea && generatedCounter) {
      const updateGeneratedState = () => {
        const length = generatedTextarea.value.length;
        generatedCounter.textContent = `${length}/${maxChars}`;
        const isAtMax = length >= maxChars;
        generatedTextarea.classList.toggle('pm-textarea--error', isAtMax);
        generatedCounter.classList.toggle('pm-counter--error', isAtMax);
        if (generatedError) generatedError.style.display = isAtMax ? '' : 'none';
        generatedTextarea.classList.toggle('pm-textarea--filled', length > 0 && !isAtMax);
      };
      generatedTextarea.addEventListener('input', updateGeneratedState);
      generatedTextarea.addEventListener('paste', () => requestAnimationFrame(updateGeneratedState));
    }

    if (submitGenerated) {
      submitGenerated.addEventListener('click', () => {
        const text = generatedTextarea?.value.trim();
        if (!text) return;
        this.#handleAddGiftMessage(text);
      });
    }

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
              generatedCounter.classList.remove('pm-counter--error');
            }
            generatedTextarea.classList.remove('pm-textarea--error');
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

  /** @param {Element} panel */
  #updateGenerateButtonState(panel) {
    const nameInput = panel.querySelector('[data-pm-gm-name-input]');
    const generateBtn = panel.querySelector('[data-pm-gm-generate-btn]');
    if (!generateBtn) return;
    const hasOccasion = !!this.#selectedOccasion;
    const hasName = !!(nameInput && nameInput.value.trim());
    generateBtn.disabled = !(hasOccasion && hasName);
    generateBtn.classList.toggle('pm-btn--disabled', !(hasOccasion && hasName));
  }

  /**
   * @param {string} occasion
   * @param {string} name
   * @param {number} maxChars
   * @returns {Promise<string>}
   */
  async #generateGiftMessage(occasion, name, maxChars) {
    const params = new URLSearchParams({ recipient: '', occasion, sender: name });
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
          if (typeof message !== 'string') message = JSON.stringify(message);
        } else {
          message = await response.text();
        }
        message = message.trim().replace(/^"|"$/g, '');
        if (message) return message.substring(0, maxChars);
      }
    } catch (error) {
      console.error('Edible card-message API failed:', error);
    }
    const fallback = `Thinking of you on this ${occasion} and sending warm wishes your way. May this gift bring a smile to your face and brighten your day.\nWith love,\n${name || 'Me'}`;
    return fallback.substring(0, maxChars);
  }

  /**
   * Capture (hold mode) or commit (handlers mode) the gift message.
   * @param {string} text
   */
  async #handleAddGiftMessage(text) {
    this.#closeGiftMessageView();
    this.#giftMessageText = text;
    if (this.#handlers?.addGiftMessage) {
      await this.#handlers.addGiftMessage(text);
    }
    this.#toggleCardState('gift-message', true);
  }

  async #handleRemoveGiftMessage() {
    this.#giftMessageText = '';
    if (this.#handlers?.removeGiftMessage) {
      await this.#handlers.removeGiftMessage();
    }
    this.#toggleCardState('gift-message', false);
    const textarea = this.#q('[data-pm-gm-textarea]');
    if (textarea) {
      textarea.value = '';
      textarea.dispatchEvent(new Event('input'));
    }
  }

  /* ===== Internal: greeting card subview (occasion + Printible) ===== */

  #wireGreetingCardView() {
    const panel = this.#q('[data-pm-greeting-card-view]');
    if (!panel) return;
    const back = panel.querySelector('[data-pm-greeting-card-back]');
    const close = panel.querySelector('[data-pm-greeting-card-close]');
    if (back) back.addEventListener('click', () => this.#closeGreetingCardView());
    if (close) close.addEventListener('click', () => this.#requestClose(() => this.#closeGreetingCardView()));
    this.#setupGreetingCardOccasionDropdown(panel);
  }

  /** @param {Element} panel */
  #setupGreetingCardOccasionDropdown(panel) {
    const trigger = panel.querySelector('[data-pm-gc-dropdown-trigger]');
    const list = panel.querySelector('[data-pm-gc-dropdown-list]');
    const value = panel.querySelector('[data-pm-gc-dropdown-value]');
    if (!trigger || !list) return;

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = list.style.display !== 'none';
      list.style.display = isOpen ? 'none' : '';
      trigger.classList.toggle('pm-field__select--open', !isOpen);
      trigger.setAttribute('aria-expanded', String(!isOpen));
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        trigger.click();
      }
    });
    list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-pm-gc-occasion]');
      if (!item) return;
      event.stopPropagation();
      const label = item.getAttribute('data-pm-gc-occasion') || '';
      const occasionId = item.getAttribute('data-pm-gc-occasion-id') || '';
      this.#greetingCardOccasionId = occasionId;
      if (value) {
        value.textContent = label;
        value.style.display = '';
      }
      for (const i of list.querySelectorAll('[data-pm-gc-occasion]')) {
        i.classList.toggle('pm-dropdown-item--selected', i === item);
      }
      list.style.display = 'none';
      trigger.classList.remove('pm-field__select--open');
      trigger.classList.add('pm-field__select--filled');
      trigger.setAttribute('aria-expanded', 'false');
      this.#loadGreetingCardIframe();
    });
    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('[data-pm-gc-occasion]');
      if (!item) return;
      event.preventDefault();
      item.click();
    });
  }

  #loadGreetingCardIframe() {
    const panel = this.#q('[data-pm-greeting-card-view]');
    if (!panel) return;
    const iframe = panel.querySelector('[data-pm-gc-iframe]');
    const wrap = panel.querySelector('[data-pm-gc-occasion-wrap]');
    if (!iframe || !this.#greetingCardBaseUrl || !this.#greetingCardOccasionId) return;

    const separator = this.#greetingCardBaseUrl.includes('?') ? '&' : '?';
    const hostUrl = encodeURIComponent(PRINTIBLE_HOST_URL);
    const url = `${this.#greetingCardBaseUrl}${separator}occasionID=${encodeURIComponent(this.#greetingCardOccasionId)}&hostUrl=${hostUrl}`;
    iframe.setAttribute('src', url);

    if (wrap) wrap.style.display = 'none';
    iframe.style.display = '';
  }

  /** @param {MessageEvent} event */
  #handlePrintibleMessage(event) {
    if (!this.#isAllowedPrintibleOrigin(event.origin)) return;
    if (!event.data || !event.data.action) return;
    const iframe = this.#q('[data-pm-gc-iframe]');
    if (!iframe || event.source !== iframe.contentWindow) return;

    if (event.data.action === 'printibleCreated' && event.data.printibleID) {
      this.#greetingCardData = event.data;
      this.#handleGreetingCardComplete();
    } else if (event.data.action === 'closePrintibleWindow') {
      this.#closeGreetingCardView();
      this.#resetGreetingCardSubviewUi();
    }
  }

  /** @param {string} origin @returns {boolean} */
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

  async #handleGreetingCardComplete() {
    this.#closeGreetingCardView();
    if (this.#handlers?.addGreetingCard) {
      await this.#handlers.addGreetingCard(this.#greetingCardData);
    }
    this.#toggleCardState('greeting-card', true);
  }

  async #handleRemoveGreetingCard() {
    this.#greetingCardData = null;
    if (this.#handlers?.removeGreetingCard) {
      await this.#handlers.removeGreetingCard();
    }
    this.#resetGreetingCardSubviewUi();
    this.#toggleCardState('greeting-card', false);
  }

  /* ===== Internal: outside click ===== */

  /** @param {MouseEvent} event */
  #handleOutsideClick(event) {
    for (const sel of ['[data-pm-gm-dropdown]', '[data-pm-gc-dropdown]']) {
      const dropdown = this.#q(sel);
      if (!dropdown || dropdown.contains(event.target)) continue;
      const trigger = dropdown.querySelector('[data-pm-gm-dropdown-trigger], [data-pm-gc-dropdown-trigger]');
      const list = dropdown.querySelector('[data-pm-gm-dropdown-list], [data-pm-gc-dropdown-list]');
      if (list) list.style.display = 'none';
      if (trigger) {
        trigger.classList.remove('pm-field__select--open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    }
  }
}
