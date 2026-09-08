import { Component } from '@theme/component';
import { fetchProductAvailability } from '@theme/ea-availability';
import { ThemeEvents } from '@theme/events';
import { AVAILABILITY_API } from '@theme/ea-api-endpoints';
import { setAtcBlock, ATC_BLOCK } from '@theme/atc-gate';

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Check if a value is truthy: boolean true or string 'true'.
 * All other values (false, 'false', undefined, null) resolve to false.
 * @param {*} val
 * @returns {boolean}
 */
function isTruthyFlag(val) {
  return val === true || val === 'true';
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PdpAvailabilityRefs
 * @property {HTMLInputElement}  zipInput
 * @property {HTMLButtonElement} checkButton
 * @property {HTMLButtonElement} deliveryToggle
 * @property {HTMLButtonElement} pickupToggle
 * @property {HTMLElement}       timeOptions
 * @property {HTMLElement}       datepickerContainer
 * @property {HTMLElement}       storeList
 * @property {HTMLElement}       status
 * @property {HTMLElement}       zipError
 * @property {HTMLButtonElement} clearButton
 * @property {HTMLElement}       toggleSecondary
 * @property {HTMLElement}       autoNotice
 * @property {HTMLElement}       autoNoticeText
 * @property {HTMLButtonElement} changeStoreBtn
 * @property {HTMLScriptElement} blockSettings
 */

/**
 * @typedef {object} RichStore
 * @property {string}  storeNumber
 * @property {string}  [address1]
 * @property {string}  [customerFriendlyName]
 * @property {string}  [city]
 * @property {string}  [state]
 * @property {string}  [timingsShort]
 * @property {string}  [phone]
 * @property {number}  [distance]
 * @property {boolean} [curbSide]
 * @property {boolean} [smoothies]
 * @property {boolean} [kosher]
 */

/**
 * @typedef {object} VariantEntry
 * @property {boolean}     disabled  - true if variant cannot be served at any store
 * @property {Set<string>} stores    - Set of store numbers that can serve this variant
 * @property {boolean}     oneHour   - true if any store offers one-hour for this variant
 */

/**
 * @typedef {object} TypeEntry
 * @property {Object<string, VariantEntry>} variants  - keyed by variant ID
 * @property {RichStore[]}                  storeList  - distance-sorted stores for this type
 */

// ── Component ───────────────────────────────────────────────────────────────

/**
 * PDP availability block — handles fulfillment mode toggle, time-option
 * selection, ZIP validation, store lookup, store card rendering,
 * nearest-store auto-select, and variant change re-gating.
 *
 * @extends Component<PdpAvailabilityRefs>
 */
class PdpAvailabilityComponent extends Component {
  /** @type {import('@theme/air-datepicker-adapter').default | null} */
  #datepickerInstance = null;

  /** @type {string | null} */
  #activeTimeOption = null;

  /** @type {Map<string, object>} country|zip → store-location full response */
  #storeCache = new Map();

  /** @type {Map<string, object>} country|zip|date → product-availability response */
  #availCache = new Map();

  /** @type {Map<string, RichStore>} storeNumber → rich store object */
  #storesById = new Map();

  /** @type {Object<string, TypeEntry> | null} fulfillment type → TypeEntry */
  #map = null;

  /** @type {boolean} */
  #hasStores = false;

  /** @type {boolean} */
  #resolved = false;

  /** @type {string | null} auto-selected store number */
  #autoSelected = null;

  /** @type {number} incrementing sequence number for stale-fetch detection */
  #fetchSeq = 0;

  /** @type {AbortController | null} */
  #fetchController = null;

  /** @type {string | null} currently selected Shopify variant ID */
  #currentVariantId = null;

  /** @type {string | null} currently selected store number */
  #selectedStore = null;

  /** @type {Element | null} cached reference to closest .shopify-section */
  #sectionEl = null;

  /** @type {((e: Event) => void) | null} */
  #variantChangeHandler = null;

  /** @type {((e: Event) => void) | null} */
  #variantUpdateHandler = null;

  /** @type {object | null} parsed block settings cache */
  #parsedSettings = null;

  /** @type {HTMLButtonElement | null} cached ATC button in the same section */
  #atcButton = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this.dataset.mode = 'delivery';
    this.#atcButton = this.closest('.shopify-section')?.querySelector('button[name="add"]') || null;
    this.#observeVariantPicker();
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.#destroyDatepicker();
    this.#cancelFetch();

    // Remove variant listeners
    if (this.#sectionEl) {
      if (this.#variantChangeHandler) {
        this.#sectionEl.removeEventListener('change', this.#variantChangeHandler);
      }
      if (this.#variantUpdateHandler) {
        this.#sectionEl.removeEventListener(ThemeEvents.variantUpdate, this.#variantUpdateHandler);
      }
    }
    this.#variantChangeHandler = null;
    this.#variantUpdateHandler = null;
    this.#sectionEl = null;
    this.#clearGating();
    this.#atcButton = null;
  }

  // ── Settings accessor ─────────────────────────────────────────────────────

  /** @returns {object} Parsed block settings from the embedded JSON script */
  get #settings() {
    if (!this.#parsedSettings) {
      const el = this.refs.blockSettings;
      try {
        this.#parsedSettings = el ? JSON.parse(el.textContent) : {};
      } catch {
        this.#parsedSettings = {};
      }
    }
    return this.#parsedSettings;
  }

  // ── Public handlers (declarative binding) ─────────────────────────────────

  /**
   * Toggle between Delivery and Pickup modes.
   * @param {Event} event
   * @param {string} [mode]
   */
  handleToggleMode(event, mode) {
    event.preventDefault();

    const target = /** @type {HTMLButtonElement} */ (event.currentTarget);
    const newMode = mode || target.dataset.mode;
    if (!newMode || newMode === this.dataset.mode) return;

    this.dataset.mode = newMode;
    this.#updateToggleButtons(newMode);
    this.#clearTimeSelection();

    // Re-render store cards from cached map if resolved
    if (this.#resolved && this.#map) {
      this.#renderStoreCards();
      this.#autoSetup();
    }
  }

  /**
   * Handle time-option button click (single-select).
   * @param {Event} event
   * @param {string} [optionId]
   */
  handleTimeOption(event, optionId) {
    event.preventDefault();

    const target = /** @type {HTMLButtonElement} */ (event.currentTarget);
    const id = optionId || target.dataset.option;
    if (!id) return;

    const buttons = this.refs.timeOptions?.querySelectorAll('[data-option]');
    if (!buttons) return;

    const isDeselect = this.#activeTimeOption === id;

    for (const btn of buttons) {
      btn.setAttribute('aria-pressed', 'false');
    }

    if (isDeselect) {
      this.#activeTimeOption = null;
      this.#hideDatepicker();
      return;
    }

    target.setAttribute('aria-pressed', 'true');
    this.#activeTimeOption = id;

    if (id === 'select-date') {
      this.#showDatepicker();
    } else {
      this.#hideDatepicker();
    }
  }

  /**
   * Validate ZIP on Check button click and trigger store lookup.
   * @param {Event} event
   */
  handleCheck(event) {
    event.preventDefault();

    const input = this.refs.zipInput;
    const errorEl = this.refs.zipError;
    if (!input || !errorEl) return;

    const zip = input.value.trim();
    const isValid = /^\d{5}$/.test(zip);

    if (!isValid) {
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      return;
    }

    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');

    this.#resolve(zip, 'US');
  }

  /**
   * Clear time selection and reset date picker.
   * @param {Event} event
   */
  handleClear(event) {
    event.preventDefault();
    this.#clearTimeSelection();
  }

  /**
   * Show the store list and hide the auto-notice (user wants to pick manually).
   * @param {Event} event
   */
  handleChangeStore(event) {
    event.preventDefault();
    if (this.refs.autoNotice) this.refs.autoNotice.hidden = true;
    if (this.refs.storeList) this.refs.storeList.hidden = false;
  }

  // ── Core resolution flow ──────────────────────────────────────────────────

  /**
   * Main resolution: fetch stores → resolve active type → fetch availability
   * → build map → render cards → auto-select.
   *
   * @param {string} zip
   * @param {string} country
   */
  async #resolve(zip, country) {
    const seq = ++this.#fetchSeq;
    this.#cancelFetch();
    this.#fetchController = new AbortController();
    const { signal } = this.#fetchController;

    this.#setLoading(true);
    this.#setStatus(this.#settings.status_loading || 'Checking availability...');

    try {
      // 1. Fetch store-location (or use cache)
      const storeCacheKey = `${country}|${zip}`;
      let storeData = this.#storeCache.get(storeCacheKey);
      if (!storeData) {
        storeData = await this.#fetchStoreLocation(zip, country, signal);
        if (seq !== this.#fetchSeq) return; // stale
        this.#storeCache.set(storeCacheKey, storeData);
      }

      // 2. Extract area flags and rich stores
      const area = storeData.area || {};
      const areaAvail = area.availability || {};
      const richStores = Array.isArray(storeData.richStores)
        ? storeData.richStores
        : Array.isArray(storeData.stores)
          ? storeData.stores
          : [];

      // Index stores by storeNumber
      this.#storesById.clear();
      for (const store of richStores) {
        if (store.storeNumber) {
          this.#storesById.set(String(store.storeNumber), store);
        }
      }

      // 3. Resolve active type from area flags
      const activeType = this.#resolveActiveType(areaAvail);

      // If no type is available, show no-results and stop
      if (!activeType) {
        this.#hasStores = false;
        this.#resolved = true;
        this.#map = null;
        this.#setStatus(this.#settings.status_no_results || 'Please try with another Zip Code.');
        this.#setLoading(false);
        this.#hideStoreList();
        this.#hideAutoNotice();
        return;
      }

      // Sync mode toggle to match available types
      if (activeType === 'delivery' || activeType === 'shipment') {
        this.dataset.mode = 'delivery';
        this.#updateToggleButtons('delivery');
      } else {
        this.dataset.mode = activeType;
        this.#updateToggleButtons(activeType);
      }

      // 4. Compute request date
      const requestDate = this.#computeRequestDate();

      // 5. Fetch product availability (or use cache)
      const variantIds = this.#getVariantIds();
      let availData = null;

      if (variantIds.length > 0 && requestDate) {
        const availCacheKey = `${country}|${zip}|${requestDate}`;
        availData = this.#availCache.get(availCacheKey);
        if (!availData) {
          availData = await fetchProductAvailability({
            zip,
            country,
            date: requestDate,
            variantIds,
            mode: this.dataset.mode,
            signal,
          });
          if (seq !== this.#fetchSeq) return; // stale
          this.#availCache.set(availCacheKey, availData);
        }
      }

      // 6. Build the in-memory map
      this.#map = this.#buildMap(richStores, availData, areaAvail);
      this.#hasStores = richStores.length > 0;
      this.#resolved = true;

      // 7. Render store cards
      if (this.#hasStores) {
        this.#setStatus('');
        this.#renderStoreCards();
        this.#autoSetup();
      } else {
        this.#setStatus(this.#settings.status_no_results || 'Please try with another Zip Code.');
        this.#hideStoreList();
        this.#hideAutoNotice();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[pdp-availability] resolve failed:', err);
      this.#setStatus(this.#settings.status_check_failed || 'Something went wrong. Please try again.');
      this.#hideStoreList();
      this.#hideAutoNotice();
    } finally {
      if (seq === this.#fetchSeq) {
        this.#setLoading(false);
      }
    }
  }

  /**
   * Fetch store-location endpoint directly (with fulfillmentType: 'all')
   * to get the full response including area flags and richStores.
   *
   * @param {string} zip
   * @param {string} country
   * @param {AbortSignal} signal
   * @returns {Promise<object>}
   */
  async #fetchStoreLocation(zip, country, signal) {
    const response = await fetch(AVAILABILITY_API.storeLocation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zip, country, fulfillmentType: 'all' }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Store location fetch failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Resolve the active fulfillment type from area availability flags.
   * Priority: delivery → shipment. Pickup is always allowed alongside.
   *
   * @param {object} areaAvail - { delivery?: bool, pickup?: bool, shipment?: bool }
   * @returns {string | null} 'delivery' | 'pickup' | 'shipment' | null
   */
  #resolveActiveType(areaAvail) {
    if (isTruthyFlag(areaAvail.delivery)) return 'delivery';
    if (isTruthyFlag(areaAvail.shipment)) return 'shipment';
    if (isTruthyFlag(areaAvail.pickup)) return 'pickup';
    return null;
  }

  /**
   * Compute the ISO date string for the request based on the selected time
   * option. Falls back to today if no option is selected.
   *
   * @returns {string} ISO date string (YYYY-MM-DD)
   */
  #computeRequestDate() {
    const now = new Date();
    let target;

    switch (this.#activeTimeOption) {
      case 'next-day':
        target = new Date(now);
        target.setDate(target.getDate() + 1);
        break;
      case 'select-date':
        // If a datepicker date is selected, use it; otherwise fall back to today
        if (this.#datepickerInstance?.selectedDate) {
          target = new Date(this.#datepickerInstance.selectedDate);
        } else {
          target = now;
        }
        break;
      case 'one-hour':
      case 'same-day':
      default:
        target = now;
        break;
    }

    const yyyy = target.getFullYear();
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // ── Map building ──────────────────────────────────────────────────────────

  /**
   * Build the in-memory map from store-location and product-availability
   * responses. Keyed by fulfillment type.
   *
   * @param {RichStore[]} richStores  - distance-sorted stores from store-location
   * @param {object|null} availData   - product-availability response (may be null)
   * @param {object}      areaAvail   - area availability flags
   * @returns {Object<string, TypeEntry>}
   */
  #buildMap(richStores, availData, areaAvail) {
    const map = {};

    // Build entries for each available fulfillment type
    for (const type of ['delivery', 'pickup', 'shipment']) {
      if (!isTruthyFlag(areaAvail[type])) continue;
      map[type] = this.#buildTypeMap(type, richStores, availData);
    }

    return map;
  }

  /**
   * Build the map entry for one fulfillment type.
   *
   * @param {string}       type        - 'delivery' | 'pickup' | 'shipment'
   * @param {RichStore[]}  richStores  - distance-sorted stores
   * @param {object|null}  availData   - product-availability response
   * @returns {TypeEntry}
   */
  #buildTypeMap(type, richStores, availData) {
    /** @type {Object<string, VariantEntry>} */
    const variants = {};

    // Collect per-variant store sets from the availability response
    const variantEntries = this.#extractVariants(availData);

    for (const [variantId, variantAvail] of variantEntries) {
      const storeIds = new Set();
      let oneHour = false;

      // variantAvail.stores is expected to be an array or object of store-level data
      const storeItems = variantAvail.stores || variantAvail.storeList || [];

      if (Array.isArray(storeItems)) {
        for (const item of storeItems) {
          const sn = String(item.storeNumber || item.storeId || item);
          if (isTruthyFlag(item.available !== undefined ? item.available : true)) {
            storeIds.add(sn);
          }
          if (isTruthyFlag(item.oneHour)) oneHour = true;
        }
      } else if (typeof storeItems === 'object') {
        for (const [sn, data] of Object.entries(storeItems)) {
          if (isTruthyFlag(data.available !== undefined ? data.available : true)) {
            storeIds.add(String(sn));
          }
          if (isTruthyFlag(data.oneHour)) oneHour = true;
        }
      }

      variants[variantId] = {
        disabled: storeIds.size === 0,
        stores: storeIds,
        oneHour,
      };
    }

    // Build storeList by filtering richStores (distance-sorted) against
    // the union of all variant store sets for this type.
    const allStoreIds = new Set();
    for (const v of Object.values(variants)) {
      for (const sn of v.stores) {
        allStoreIds.add(sn);
      }
    }

    // If no availability data, include all richStores
    const storeList = allStoreIds.size > 0
      ? richStores.filter((s) => allStoreIds.has(String(s.storeNumber)))
      : richStores;

    return { variants, storeList };
  }

  /**
   * Extract variant entries from the availability response. Handles multiple
   * possible response shapes.
   *
   * @param {object|null} availData
   * @returns {Array<[string, object]>} Array of [variantId, variantAvailData] pairs
   */
  #extractVariants(availData) {
    if (!availData) return [];

    // Shape 1: { variants: [ { variantId, stores: [...] }, ... ] }
    if (Array.isArray(availData.variants)) {
      return availData.variants.map((v) => [
        String(v.variantId || v.id || v.eaId),
        v,
      ]);
    }

    // Shape 2: { variants: { [id]: { stores: ... }, ... } }
    if (availData.variants && typeof availData.variants === 'object') {
      return Object.entries(availData.variants).map(([id, data]) => [
        String(id),
        data,
      ]);
    }

    // Shape 3: { data: { variants: ... } } (nested)
    if (availData.data?.variants) {
      return this.#extractVariants(availData.data);
    }

    return [];
  }

  // ── Store card rendering ──────────────────────────────────────────────────

  /**
   * Render store cards into the storeList container for the current mode.
   */
  #renderStoreCards() {
    const container = this.refs.storeList;
    if (!container) return;

    const mode = this.dataset.mode || 'delivery';
    const typeKey = mode === 'delivery' ? (this.#map?.delivery ? 'delivery' : 'shipment') : mode;
    const typeEntry = this.#map?.[typeKey];

    if (!typeEntry || typeEntry.storeList.length === 0) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }

    // Get current variant's available stores (if we have variant data)
    const variantStores = this.#currentVariantId
      ? typeEntry.variants[this.#currentVariantId]?.stores
      : null;

    const cards = [];
    for (const store of typeEntry.storeList) {
      const sn = String(store.storeNumber);
      const isAvailable = variantStores ? variantStores.has(sn) : true;
      const isSelected = this.#selectedStore === sn;
      cards.push(this.#buildStoreCard(store, isSelected, isAvailable));
    }

    container.innerHTML = cards.join('');
    container.hidden = false;

    // Attach event delegation for store selection
    container.onclick = (e) => {
      const card = /** @type {HTMLElement} */ (e.target).closest('[data-store]');
      if (card) {
        this.#selectStore(card.dataset.store);
      }
    };

    // Keyboard navigation for radiogroup
    container.onkeydown = (e) => {
      const cards = /** @type {NodeListOf<HTMLElement>} */ (
        container.querySelectorAll('[data-store]')
      );
      if (cards.length === 0) return;

      const current = /** @type {HTMLElement} */ (document.activeElement);
      const idx = Array.from(cards).indexOf(current);

      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = idx < cards.length - 1 ? idx + 1 : 0;
        cards[next].focus();
        this.#selectStore(cards[next].dataset.store);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = idx > 0 ? idx - 1 : cards.length - 1;
        cards[prev].focus();
        this.#selectStore(cards[prev].dataset.store);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (current?.dataset?.store) {
          this.#selectStore(current.dataset.store);
        }
      }
    };
  }

  /**
   * Build HTML for a single store card.
   *
   * @param {RichStore} store
   * @param {boolean}   isSelected
   * @param {boolean}   isAvailable
   * @returns {string}  HTML string
   */
  #buildStoreCard(store, isSelected, isAvailable) {
    const s = this.#settings;
    const sn = String(store.storeNumber);
    const name = store.address1 || store.customerFriendlyName || s.store_fallback || 'Edible Store';
    const city = store.city || '';
    const state = store.state || '';
    const address = [city, state].filter(Boolean).join(', ');
    const hours = store.timingsShort || '';
    const phone = store.phone || '';
    const dist = store.distance != null ? store.distance : '';
    const unit = s.distance_unit || 'mi';
    const viewLabel = s.view_details || 'View details';
    const hideLabel = s.hide_details || 'Hide details';

    // Feature flags
    const features = [];
    if (isTruthyFlag(store.curbSide) || isTruthyFlag(store.hasCurbside)) {
      features.push(s.feature_curbside || 'Curbside pickup');
    }
    if (isTruthyFlag(store.smoothies) || isTruthyFlag(store.hasSmoothies)) {
      features.push(s.feature_smoothies || 'Smoothies');
    }
    if (isTruthyFlag(store.kosher) || isTruthyFlag(store.isKosher)) {
      features.push(s.feature_kosher || 'Kosher');
    }

    const featuresHtml = features.length > 0
      ? `<div class="pdp-avail__store-features">${features.map((f) => `<span class="pdp-avail__store-feature">${f}</span>`).join('')}</div>`
      : '';

    const distHtml = dist !== ''
      ? `<span class="pdp-avail__store-distance">${dist} ${unit}</span>`
      : '';

    const phoneHtml = phone
      ? `<div class="pdp-avail__store-phone">${phone}</div>`
      : '';

    const hoursHtml = hours
      ? `<div class="pdp-avail__store-hours">${hours}</div>`
      : '';

    const detailsContent = (hoursHtml || phoneHtml || featuresHtml)
      ? `<details class="pdp-avail__store-details">
          <summary class="body-small">${viewLabel}</summary>
          <div class="pdp-avail__store-info">
            ${hoursHtml}${phoneHtml}${featuresHtml}
          </div>
        </details>`
      : '';

    return `<div
      class="pdp-avail__store-card${isAvailable ? '' : ' pdp-avail__store-card--unavailable'}"
      tabindex="0"
      role="radio"
      aria-checked="${isSelected}"
      data-store="${sn}"
      ${!isAvailable ? 'aria-disabled="true"' : ''}
    >
      <div class="pdp-avail__store-header">
        <span class="pdp-avail__store-name">${name}</span>
        ${distHtml}
      </div>
      ${address ? `<div class="pdp-avail__store-address body-small">${address}</div>` : ''}
      ${detailsContent}
    </div>`;
  }

  /**
   * Select a store by store number. Updates aria-checked on all cards and
   * shows the selection notice.
   *
   * @param {string} storeNumber
   */
  #selectStore(storeNumber) {
    if (!storeNumber) return;

    this.#selectedStore = storeNumber;

    // Update aria-checked on all cards
    const container = this.refs.storeList;
    if (container) {
      for (const card of container.querySelectorAll('[data-store]')) {
        card.setAttribute('aria-checked', String(card.dataset.store === storeNumber));
      }
    }

    // Show notice with selected-store text
    const s = this.#settings;
    const isAuto = this.#autoSelected === storeNumber;
    const noticeText = isAuto
      ? (s.auto_notice_text || 'Closest store automatically selected.')
      : (s.selected_notice_text || 'Store selected.');

    if (this.refs.autoNoticeText) {
      this.refs.autoNoticeText.textContent = noticeText;
    }
    if (this.refs.autoNotice) {
      this.refs.autoNotice.hidden = false;
    }
  }

  // ── Auto-select ───────────────────────────────────────────────────────────

  /**
   * For delivery: auto-select the nearest store (first in distance-sorted
   * storeList) that can serve the currently selected variant.
   * For pickup: no auto-select.
   */
  #autoSetup() {
    this.#autoSelected = null;

    const mode = this.dataset.mode || 'delivery';
    if (mode !== 'delivery') {
      // Pickup has no auto-select — show store list directly
      if (this.refs.storeList) this.refs.storeList.hidden = false;
      this.#hideAutoNotice();
      return;
    }

    const typeKey = this.#map?.delivery ? 'delivery' : 'shipment';
    const typeEntry = this.#map?.[typeKey];
    if (!typeEntry || typeEntry.storeList.length === 0) return;

    // Find the first store that can serve the current variant
    const variantEntry = this.#currentVariantId
      ? typeEntry.variants[this.#currentVariantId]
      : null;

    let autoStore = null;
    for (const store of typeEntry.storeList) {
      const sn = String(store.storeNumber);
      if (!variantEntry || variantEntry.stores.has(sn)) {
        autoStore = sn;
        break;
      }
    }

    if (autoStore) {
      this.#autoSelected = autoStore;
      this.#selectStore(autoStore);
      // Hide the full store list; show only the notice with "Change store"
      if (this.refs.storeList) this.refs.storeList.hidden = true;
    } else {
      // No store can serve this variant — show list and let user see
      if (this.refs.storeList) this.refs.storeList.hidden = false;
      this.#hideAutoNotice();
    }
  }

  // ── Variant observation ───────────────────────────────────────────────────

  /**
   * Attach listeners for variant changes on the closest section element.
   * Uses 'change' for instant re-gate from radio clicks and
   * ThemeEvents.variantUpdate for post-morph updates from Horizon.
   */
  #observeVariantPicker() {
    this.#sectionEl = this.closest('.shopify-section, dialog');
    if (!this.#sectionEl) return;

    // 'change' listener: catches variant radio input changes immediately
    this.#variantChangeHandler = (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const variantId = target?.dataset?.variantId;
      if (variantId && variantId !== this.#currentVariantId) {
        this.#handleVariantChange(variantId);
      }
    };

    // ThemeEvents.variantUpdate: fires after Horizon morphs the picker HTML
    this.#variantUpdateHandler = (e) => {
      const resource = e.detail?.resource;
      if (resource?.id) {
        const variantId = String(resource.id);
        // Re-acquire ATC button — morph may have replaced the element
        this.#atcButton = this.closest('.shopify-section')?.querySelector('button[name="add"]') || null;
        // Determine if variant is sold out from Shopify's perspective
        const shopifyAvailable = resource.available !== false;
        this.#handleVariantChange(variantId, shopifyAvailable);
      }
    };

    this.#sectionEl.addEventListener('change', this.#variantChangeHandler);
    this.#sectionEl.addEventListener(ThemeEvents.variantUpdate, this.#variantUpdateHandler);
  }

  /**
   * Re-gate on variant change from the cached map (no refetch).
   * Updates store card availability states for the new variant,
   * gates/un-gates ATC, and toggles variant strikethrough.
   *
   * @param {string}  variantId
   * @param {boolean} [shopifyAvailable=true] - false when variant is sold out
   */
  #handleVariantChange(variantId, shopifyAvailable = true) {
    this.#currentVariantId = variantId;

    if (!this.#resolved || !this.#map) {
      // No availability data yet — if variant is sold out, release our
      // gate (the button is already natively disabled by the theme morph
      // and the gate module's `had` guard prevents re-enabling)
      if (!shopifyAvailable) {
        this.#gateAddToCart(false);
      }
      return;
    }

    // Re-render store cards to reflect new variant availability
    this.#renderStoreCards();
    this.#autoSetup();

    // Determine if current variant can be served at any store
    const mode = this.dataset.mode || 'delivery';
    const typeKey = mode === 'delivery' ? (this.#map?.delivery ? 'delivery' : 'shipment') : mode;
    const typeEntry = this.#map?.[typeKey];
    const variantEntry = typeEntry?.variants[variantId];
    const storeAvailable = !variantEntry || !variantEntry.disabled;

    // Gate ATC: block when variant exists in map but has no stores.
    // For sold-out variants, set block=false — the gate module's `had`
    // guard prevents re-enabling on a fresh natively-disabled element.
    const block = shopifyAvailable && !storeAvailable;
    this.#gateAddToCart(block);

    // Toggle variant strikethrough SVGs
    this.#toggleVariantStrike();
  }

  // ── ATC gating ────────────────────────────────────────────────────────────

  /**
   * Block or unblock the ATC button via the shared gate registry.
   * @param {boolean} shouldBlock
   */
  #gateAddToCart(shouldBlock) {
    setAtcBlock(this.#atcButton, ATC_BLOCK.availability, shouldBlock);
  }

  /**
   * Release the availability gate when the component disconnects.
   */
  #clearGating() {
    setAtcBlock(this.#atcButton, ATC_BLOCK.availability, false);
  }

  // ── Variant strikethrough ────────────────────────────────────────────────

  /**
   * Toggle the `.variant-option__strikethrough` SVG on variant option labels
   * based on store-availability data from the map. Struck variants remain
   * clickable — the radio input is never disabled by this block.
   *
   * Uses `data-pdp-strike` as a marker attribute to distinguish availability-
   * driven strikethroughs (added/removed by this code) from Shopify's own
   * sold-out strikethroughs (server-rendered and left untouched).
   */
  #toggleVariantStrike() {
    if (!this.#sectionEl || !this.#map) return;

    const mode = this.dataset.mode || 'delivery';
    const typeKey = mode === 'delivery' ? (this.#map?.delivery ? 'delivery' : 'shipment') : mode;
    const typeEntry = this.#map?.[typeKey];
    if (!typeEntry) return;

    const radios = this.#sectionEl.querySelectorAll('[data-variant-id]');
    for (const radio of radios) {
      const vid = radio.dataset.variantId;
      if (!vid) continue;

      const label = radio.closest('label') || radio.parentElement;
      if (!label) continue;

      const variantEntry = typeEntry.variants[vid];
      const unavailable = variantEntry?.disabled === true;

      // Only manage our own strikethroughs (marked with data-pdp-strike)
      const existing = label.querySelector('.variant-option__strikethrough[data-pdp-strike]');

      if (unavailable && !existing) {
        // Add strikethrough SVG
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'variant-option__strikethrough');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-pdp-strike', '');

        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '100');
        line1.setAttribute('y1', '0');
        line1.setAttribute('x2', '0');
        line1.setAttribute('y2', '100');
        line1.setAttribute('vector-effect', 'non-scaling-stroke');

        const line2 = line1.cloneNode(false);

        svg.appendChild(line1);
        svg.appendChild(line2);
        label.appendChild(svg);
      } else if (!unavailable && existing) {
        // Remove our strikethrough
        existing.remove();
      }
    }
  }

  // ── Variant ID collection ─────────────────────────────────────────────────

  /**
   * Collect all Shopify variant IDs from the variant picker radios
   * in the section. Returns numeric ID strings.
   *
   * @returns {string[]}
   */
  #getVariantIds() {
    if (!this.#sectionEl) return [];

    const radios = this.#sectionEl.querySelectorAll('[data-variant-id]');
    const ids = new Set();
    for (const radio of radios) {
      const vid = radio.dataset.variantId;
      if (vid) ids.add(vid);
    }
    return Array.from(ids);
  }

  // ── Status management ─────────────────────────────────────────────────────

  /**
   * Show or hide the status line with the given text.
   * Empty string hides the status element.
   *
   * @param {string} text
   */
  #setStatus(text) {
    const el = this.refs.status;
    if (!el) return;

    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  /**
   * Set or clear the loading state on the component.
   * @param {boolean} isLoading
   */
  #setLoading(isLoading) {
    this.dataset.loading = String(isLoading);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  #hideStoreList() {
    if (this.refs.storeList) {
      this.refs.storeList.innerHTML = '';
      this.refs.storeList.hidden = true;
    }
  }

  #hideAutoNotice() {
    if (this.refs.autoNotice) this.refs.autoNotice.hidden = true;
  }

  #cancelFetch() {
    if (this.#fetchController) {
      this.#fetchController.abort();
      this.#fetchController = null;
    }
  }

  // ── Existing private helpers ──────────────────────────────────────────────

  /**
   * @param {string} mode
   */
  #updateToggleButtons(mode) {
    const { deliveryToggle, pickupToggle, toggleSecondary } = this.refs;

    if (deliveryToggle) {
      deliveryToggle.setAttribute('aria-pressed', String(mode === 'delivery'));
    }
    if (pickupToggle) {
      pickupToggle.setAttribute('aria-pressed', String(mode === 'pickup'));
    }

    // Update the secondary link text visibility
    if (toggleSecondary) {
      const deliveryLink = toggleSecondary.querySelector('[data-mode="delivery"]');
      const pickupLink = toggleSecondary.querySelector('[data-mode="pickup"]');
      if (deliveryLink) deliveryLink.hidden = mode === 'delivery';
      if (pickupLink) pickupLink.hidden = mode === 'pickup';
    }
  }

  #clearTimeSelection() {
    this.#activeTimeOption = null;
    const buttons = this.refs.timeOptions?.querySelectorAll('[data-option]');
    if (buttons) {
      for (const btn of buttons) {
        btn.setAttribute('aria-pressed', 'false');
      }
    }
    this.#hideDatepicker();
  }

  async #showDatepicker() {
    const container = this.refs.datepickerContainer;
    if (!container) return;

    container.hidden = false;

    if (!this.#datepickerInstance) {
      try {
        const { default: AirDatepickerAdapter } = await import('@theme/air-datepicker-adapter');
        this.#datepickerInstance = new AirDatepickerAdapter(container);
      } catch (err) {
        console.warn('[pdp-availability] air-datepicker-adapter not available:', err);
      }
    }
  }

  #hideDatepicker() {
    const container = this.refs.datepickerContainer;
    if (container) {
      container.hidden = true;
    }
    this.#destroyDatepicker();
  }

  #destroyDatepicker() {
    if (this.#datepickerInstance) {
      this.#datepickerInstance.destroy?.();
      this.#datepickerInstance = null;
    }
  }
}

customElements.define('pdp-availability-component', PdpAvailabilityComponent);
