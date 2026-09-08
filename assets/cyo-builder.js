import { Component } from '@theme/component';
import { CartAddEvent, ThemeEvents } from '@theme/events';
import { setAtcBlock, ATC_BLOCK } from '@theme/atc-gate';

class CyoBuilder extends Component {
  /** @type {Array<{handle: string, id: string, variantId: string, title: string, imageUrl: string}>} */
  #selections = [];

  /** @type {Map<number, Array<{handle: string, id: string, variantId: string, title: string, imageUrl: string}>>} */
  #stepSelections = new Map();

  /** @type {HTMLFormElement|null} */
  #form = null;

  /** @type {HTMLButtonElement|null} */
  #atcButton = null;

  /** @type {string} */
  #originalAtcText = '';

  /** @type {HTMLElement|null} */
  #section = null;

  /** @type {Array<() => void>} */
  #scrollerCleanups = [];

  connectedCallback() {
    super.connectedCallback();

    this.totalSlots = parseInt(this.dataset.totalSlots, 10) || 12;
    this.selectionType = this.dataset.selectionType || 'single';
    this.boxTypeLabel = this.dataset.boxTypeLabel || '';

    /** @type {NodeListOf<HTMLElement>} */
    const steps = this.querySelectorAll('[data-cyo-step]');
    this.steps = Array.from(steps).map((stepEl) => ({
      el: stepEl,
      limit: parseInt(stepEl.dataset.selectionLimit, 10) || 4,
      totalQuantity: parseInt(stepEl.dataset.stepQuantity, 10) || this.totalSlots,
    }));

    // For segmented mode, derive totalSlots from the sum of per-step quantities
    // instead of the potentially-misconfigured data-total-slots attribute.
    if (this.selectionType === 'segmented') {
      this.totalSlots = this.steps.reduce((sum, s) => sum + s.totalQuantity, 0);
    }

    // Listen for slot updates on the document to update the preview
    document.addEventListener('cyo:slots-update', this.#handleSlotsUpdate);

    // Attach to the product form to intercept submit when CYO has selections
    this.#form = this.closest('.shopify-section')?.querySelector('form[data-type="add-to-cart-form"]') || null;
    if (this.#form) {
      this.#form.addEventListener('submit', this.#handleFormSubmit);
    }

    // ATC gating: skip when no CYO steps exist (metafield misconfiguration)
    if (this.steps.length === 0) return;

    this.#atcButton = this.closest('.shopify-section')?.querySelector('button[name="add"]') || null;
    if (this.#atcButton) {
      const textSpan = this.#atcButton.querySelector('.add-to-cart-text__content span span');
      this.#originalAtcText = textSpan?.textContent?.trim() || '';
      this.boxTypePluralLabel = this.dataset.boxTypePluralLabel || '';
      this.#updateAtcState();
    }

    // Reset selections when variant changes (e.g. different box size)
    this.#section = this.closest('.shopify-section');
    this.#section?.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate);

    this.#bindScrollers();
  }

  /**
   * Resets all CYO selections when the product variant changes.
   */
  #handleVariantUpdate = () => {
    this.handleClear();
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('cyo:slots-update', this.#handleSlotsUpdate);

    this.#section?.removeEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate);
    this.#section = null;

    for (const cleanup of this.#scrollerCleanups) cleanup();
    this.#scrollerCleanups = [];

    if (this.#form) {
      this.#form.removeEventListener('submit', this.#handleFormSubmit);
      this.#form = null;
    }

    this.#atcButton = null;
  }

  /**
   * Handles clicking a selection card - toggles selection state.
   * @param {Event} event
   */
  handleCardClick(event) {
    const card = event.currentTarget;
    if (!card) return;

    const stepEl = card.closest('[data-cyo-step]');
    const stepData = this.steps.find((s) => s.el === stepEl);
    if (!stepData) return;

    if (this.selectionType === 'combination') {
      this.#handleCombinationCardClick(card, stepEl, stepData);
    } else if (this.selectionType === 'segmented') {
      this.#handleSegmentedCardClick(card, stepEl, stepData);
    } else {
      const isSelected = card.getAttribute('aria-pressed') === 'true';

      if (isSelected) {
        // Deselect
        card.setAttribute('aria-pressed', 'false');
        const handle = card.dataset.productHandle;
        this.#selections = this.#selections.filter((s) => s.handle !== handle);
      } else {
        // Check selection limit for this step
        const stepCards = stepEl.querySelectorAll('[data-cyo-option][aria-pressed="true"]');
        if (stepCards.length >= stepData.limit) return;

        card.setAttribute('aria-pressed', 'true');
        this.#selections.push({
          handle: card.dataset.productHandle,
          id: card.dataset.productId,
          variantId: card.dataset.variantId,
          title: card.dataset.productTitle,
          imageUrl: card.dataset.productImage,
        });
      }

      this.#updateClearButton();
      this.#distributeSlots(stepData);
      this.#updateAtcState();
    }
  }

  /**
   * Handles card click for combination selection type.
   * Manages per-step selections independently.
   * @param {HTMLElement} card
   * @param {HTMLElement} stepEl
   * @param {Object} stepData
   */
  #handleCombinationCardClick(card, stepEl, stepData) {
    const stepIndex = parseInt(stepEl.dataset.cyoStep, 10);
    const isSelected = card.getAttribute('aria-pressed') === 'true';

    if (!this.#stepSelections.has(stepIndex)) {
      this.#stepSelections.set(stepIndex, []);
    }

    const stepSels = this.#stepSelections.get(stepIndex);

    if (isSelected) {
      card.setAttribute('aria-pressed', 'false');
      const handle = card.dataset.productHandle;
      this.#stepSelections.set(
        stepIndex,
        stepSels.filter((s) => s.handle !== handle)
      );
    } else {
      const stepCards = stepEl.querySelectorAll('[data-cyo-option][aria-pressed="true"]');
      if (stepCards.length >= stepData.limit) return;

      card.setAttribute('aria-pressed', 'true');
      stepSels.push({
        handle: card.dataset.productHandle,
        id: card.dataset.productId,
        variantId: card.dataset.variantId,
        title: card.dataset.productTitle,
        imageUrl: card.dataset.productImage,
      });
    }

    this.#updateClearButton();
    this.#distributeCombinationSlots();
    this.#updateAtcState();
  }

  /**
   * Handles toggling the accordion header.
   * @param {Event} event
   */
  handleToggle(event) {
    const header = event.currentTarget;
    const step = header.closest('[data-cyo-step]');
    if (!step) return;

    const isExpanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!isExpanded));
  }

  /**
   * Clears all selections and resets the preview.
   */
  handleClear() {
    this.#selections = [];
    this.#stepSelections.clear();

    const cards = this.querySelectorAll('[data-cyo-option]');
    for (const card of cards) {
      card.setAttribute('aria-pressed', 'false');
    }

    this.#updateClearButton();

    // Build empty slots array
    const slots = [];
    for (let i = 0; i < this.totalSlots; i++) {
      slots.push({ index: i, imageUrl: null, productTitle: null });
    }

    this.dispatchEvent(
      new CustomEvent('cyo:slots-update', {
        detail: { slots },
        bubbles: true,
      })
    );

    this.dispatchEvent(
      new CustomEvent('cyo:selection-change', {
        detail: { selections: [] },
        bubbles: true,
      })
    );

    this.#updateAtcState();
  }

  /**
   * Distributes the total quantity evenly across selected products.
   * Remainder slots go to the earliest-selected products.
   * @param {Object} stepData
   */
  #distributeSlots(stepData) {
    const totalQuantity = stepData.totalQuantity;
    const count = this.#selections.length;
    const slots = [];

    if (count === 0) {
      for (let i = 0; i < totalQuantity; i++) {
        slots.push({ index: i, imageUrl: null, productTitle: null });
      }
    } else {
      const base = Math.floor(totalQuantity / count);
      const remainder = totalQuantity % count;
      let slotIndex = 0;

      for (let i = 0; i < count; i++) {
        const qty = base + (i < remainder ? 1 : 0);
        for (let j = 0; j < qty; j++) {
          slots.push({
            index: slotIndex,
            imageUrl: this.#selections[i].imageUrl,
            productTitle: this.#selections[i].title,
          });
          slotIndex++;
        }
      }
    }

    this.dispatchEvent(
      new CustomEvent('cyo:slots-update', {
        detail: { slots },
        bubbles: true,
      })
    );

    this.dispatchEvent(
      new CustomEvent('cyo:selection-change', {
        detail: {
          selections: this.#selections.map((s) => ({
            handle: s.handle,
            id: s.id,
            title: s.title,
          })),
        },
        bubbles: true,
      })
    );
  }

  /**
   * Distributes combination slots across all steps.
   * Each step fills its own portion of the grid based on preceding steps' totalQuantity.
   */
  #distributeCombinationSlots() {
    const slots = [];
    let slotOffset = 0;

    for (let si = 0; si < this.steps.length; si++) {
      const step = this.steps[si];
      const stepSels = this.#stepSelections.get(si) || [];
      // Combination mode: each step fills the full slot count so the preview
      // layer matches the serialization quantities, regardless of per-step
      // data-step-quantity which may be misconfigured.
      const totalQuantity = this.totalSlots;
      const count = stepSels.length;

      if (count === 0) {
        for (let i = 0; i < totalQuantity; i++) {
          slots.push({ index: slotOffset + i, imageUrl: null, productTitle: null });
        }
      } else {
        const base = Math.floor(totalQuantity / count);
        const remainder = totalQuantity % count;
        let idx = 0;

        for (let i = 0; i < count; i++) {
          const qty = base + (i < remainder ? 1 : 0);
          for (let j = 0; j < qty; j++) {
            slots.push({
              index: slotOffset + idx,
              imageUrl: stepSels[i].imageUrl,
              productTitle: stepSels[i].title,
            });
            idx++;
          }
        }
      }

      slotOffset += totalQuantity;
    }

    this.dispatchEvent(
      new CustomEvent('cyo:slots-update', {
        detail: { slots },
        bubbles: true,
      })
    );

    // Merge all step selections for the selection-change event
    const allSelections = [];
    for (const [, sels] of this.#stepSelections) {
      for (const s of sels) {
        allSelections.push({ handle: s.handle, id: s.id, title: s.title });
      }
    }

    this.dispatchEvent(
      new CustomEvent('cyo:selection-change', {
        detail: { selections: allSelections },
        bubbles: true,
      })
    );
  }

  /**
   * Handles card click for segmented selection type.
   * Same per-step logic as combination but distributes via #distributeSegmentedSlots.
   * @param {HTMLElement} card
   * @param {HTMLElement} stepEl
   * @param {Object} stepData
   */
  #handleSegmentedCardClick(card, stepEl, stepData) {
    const stepIndex = parseInt(stepEl.dataset.cyoStep, 10);
    const isSelected = card.getAttribute('aria-pressed') === 'true';

    if (!this.#stepSelections.has(stepIndex)) {
      this.#stepSelections.set(stepIndex, []);
    }

    const stepSels = this.#stepSelections.get(stepIndex);

    if (isSelected) {
      card.setAttribute('aria-pressed', 'false');
      const handle = card.dataset.productHandle;
      this.#stepSelections.set(
        stepIndex,
        stepSels.filter((s) => s.handle !== handle)
      );
    } else {
      const stepCards = stepEl.querySelectorAll('[data-cyo-option][aria-pressed="true"]');
      if (stepCards.length >= stepData.limit) return;

      card.setAttribute('aria-pressed', 'true');
      stepSels.push({
        handle: card.dataset.productHandle,
        id: card.dataset.productId,
        variantId: card.dataset.variantId,
        title: card.dataset.productTitle,
        imageUrl: card.dataset.productImage,
      });
    }

    this.#updateClearButton();
    this.#distributeSegmentedSlots();
    this.#updateAtcState();
  }

  /**
   * Distributes segmented slots across all steps.
   * Same even-fill logic as combination, but each slot entry includes stepIndex
   * and the event detail includes stepRanges for board visual consumption.
   */
  #distributeSegmentedSlots() {
    const slots = [];
    const stepRanges = [];
    let slotOffset = 0;

    for (let si = 0; si < this.steps.length; si++) {
      const step = this.steps[si];
      const stepSels = this.#stepSelections.get(si) || [];
      const totalQuantity = step.totalQuantity;
      const count = stepSels.length;

      stepRanges.push({
        stepIndex: si,
        slotStart: slotOffset,
        slotEnd: slotOffset + totalQuantity - 1,
        totalQuantity,
      });

      if (count === 0) {
        for (let i = 0; i < totalQuantity; i++) {
          slots.push({ index: slotOffset + i, imageUrl: null, productTitle: null, stepIndex: si });
        }
      } else {
        const base = Math.floor(totalQuantity / count);
        const remainder = totalQuantity % count;
        let idx = 0;

        for (let i = 0; i < count; i++) {
          const qty = base + (i < remainder ? 1 : 0);
          for (let j = 0; j < qty; j++) {
            slots.push({
              index: slotOffset + idx,
              imageUrl: stepSels[i].imageUrl,
              productTitle: stepSels[i].title,
              stepIndex: si,
            });
            idx++;
          }
        }
      }

      slotOffset += totalQuantity;
    }

    this.dispatchEvent(
      new CustomEvent('cyo:slots-update', {
        detail: { slots, stepRanges },
        bubbles: true,
      })
    );

    // Merge all step selections for the selection-change event
    const allSelections = [];
    for (const [, sels] of this.#stepSelections) {
      for (const s of sels) {
        allSelections.push({ handle: s.handle, id: s.id, title: s.title });
      }
    }

    this.dispatchEvent(
      new CustomEvent('cyo:selection-change', {
        detail: { selections: allSelections },
        bubbles: true,
      })
    );
  }

  // ---------------------------------------------------------------------------
  // ATC gating
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the CYO box is fully completed.
   * Single type: at least 1 selection (even-fill distributes across all slots).
   * Combination type: every step must have at least 1 selection.
   * @returns {boolean}
   */
  #isComplete() {
    if (this.selectionType === 'combination' || this.selectionType === 'segmented') {
      for (let i = 0; i < this.steps.length; i++) {
        const stepSels = this.#stepSelections.get(i);
        if (!stepSels || stepSels.length === 0) return false;
      }
      return true;
    }
    return this.#selections.length > 0;
  }

  /**
   * Returns progress text for the ATC button when the CYO box is incomplete.
   * Single type: "Choose your cupcakes" (or "Choose your items" when no label configured).
   * Combination type: "Complete all steps (X/Y)" showing how many steps have selections.
   * @returns {string}
   */
  #getProgressText() {
    if (this.selectionType === 'combination' || this.selectionType === 'segmented') {
      let completed = 0;
      for (let i = 0; i < this.steps.length; i++) {
        const stepSels = this.#stepSelections.get(i);
        if (stepSels && stepSels.length > 0) completed++;
      }
      return `Complete all steps (${completed}/${this.steps.length})`;
    }
    const label = this.boxTypePluralLabel || this.boxTypeLabel || 'items';
    return `Choose your ${label}`;
  }

  /**
   * Toggles the ATC button disabled state and text based on CYO completion.
   * Also manages data-cyo-ready on the button and data-cyo-incomplete on the component.
   */
  #updateAtcState() {
    if (!this.#atcButton) return;

    const complete = this.#isComplete();
    const textSpan = this.#atcButton.querySelector('.add-to-cart-text__content span span');

    if (complete) {
      setAtcBlock(this.#atcButton, ATC_BLOCK.cyo, false);
      this.#atcButton.setAttribute('data-cyo-ready', '');
      this.removeAttribute('data-cyo-incomplete');
      if (textSpan) textSpan.textContent = this.#originalAtcText;
    } else {
      setAtcBlock(this.#atcButton, ATC_BLOCK.cyo, true);
      this.#atcButton.removeAttribute('data-cyo-ready');
      this.setAttribute('data-cyo-incomplete', '');
      if (textSpan) textSpan.textContent = this.#getProgressText();
    }
  }

  /**
   * Shows or hides the clear button based on whether selections exist.
   */
  #updateClearButton() {
    if (this.refs.clearButton) {
      const hasSelections = this.#hasSelections();
      this.refs.clearButton.style.display = hasSelections ? '' : 'none';
    }
  }

  /**
   * Returns true if any CYO selections exist.
   * @returns {boolean}
   */
  #hasSelections() {
    if (this.selectionType === 'combination' || this.selectionType === 'segmented') {
      return Array.from(this.#stepSelections.values()).some((s) => s.length > 0);
    }
    return this.#selections.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Cart integration
  // ---------------------------------------------------------------------------

  /**
   * Intercepts the product form submit on CYO products.
   * Always prevents native submission — only calls #submitCyoCart when the box is complete.
   * When CYO steps exist, the normal product-form-component submit is never reached.
   * @param {SubmitEvent} event
   */
  #handleFormSubmit = (event) => {
    // Skip gating when no CYO steps exist (metafield misconfiguration)
    if (this.steps.length === 0) return;

    event.preventDefault();
    event.stopPropagation();

    if (this.#isComplete()) {
      this.#submitCyoCart();
    }
  };

  /**
   * Computes per-selection quantities using even-fill distribution.
   * For single type: distributes the first step's totalQuantity across #selections.
   * For combination type: distributes each step's totalQuantity across its selections,
   * then aggregates by variantId.
   * @returns {Array<{variantId: string, quantity: number, title: string}>}
   */
  #computeQuantities() {
    if (this.selectionType === 'combination' || this.selectionType === 'segmented') {
      /** @type {Map<string, {quantity: number, title: string}>} */
      const aggregated = new Map();

      for (let si = 0; si < this.steps.length; si++) {
        const step = this.steps[si];
        const stepSels = this.#stepSelections.get(si) || [];
        const count = stepSels.length;
        if (count === 0) continue;

        // Combination mode: use totalSlots for child-quantity distribution so
        // mirrored builds (step 2 empty) correctly double to 2×totalSlots.
        // Segmented mode: use the step's own totalQuantity (per-step quantities
        // are independent and already summed into totalSlots by connectedCallback).
        const totalQuantity = this.selectionType === 'combination' ? this.totalSlots : step.totalQuantity;
        const base = Math.floor(totalQuantity / count);
        const remainder = totalQuantity % count;

        for (let i = 0; i < count; i++) {
          const qty = base + (i < remainder ? 1 : 0);
          const vid = stepSels[i].variantId;
          const existing = aggregated.get(vid);
          if (existing) {
            existing.quantity += qty;
          } else {
            aggregated.set(vid, { quantity: qty, title: stepSels[i].title });
          }
        }
      }

      return Array.from(aggregated.entries()).map(([variantId, data]) => ({
        variantId,
        quantity: data.quantity,
        title: data.title,
      }));
    }

    // Single type: use first step's totalQuantity
    const count = this.#selections.length;
    if (count === 0) return [];

    const totalQuantity = this.steps[0]?.totalQuantity || this.totalSlots;
    const base = Math.floor(totalQuantity / count);
    const remainder = totalQuantity % count;

    return this.#selections.map((sel, i) => ({
      variantId: sel.variantId,
      quantity: base + (i < remainder ? 1 : 0),
      title: sel.title,
    }));
  }

  /**
   * Builds the batch cart payload with parent CYO product + child option products.
   * @returns {{items: Array<{id: number, quantity: number, properties: Record<string, string>}>}}
   */
  #buildCartPayload() {
    const parentVariantId = this.#form?.querySelector('input[name="id"]')?.value;
    if (!parentVariantId) return { items: [] };

    const groupKey = `cyo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const childQuantities = this.#computeQuantities();

    // Build human-readable summary: "Title x4, Title x4"
    const summary = childQuantities.map((c) => `${c.title} x${c.quantity}`).join(', ');
    const itemCount = String(childQuantities.length);
    const productId = this.dataset.productId || '';

    // Build snapshot properties for the parent line item
    const snapshotProps = {
      _cyo_box_type_label: this.boxTypeLabel,
      _cyo_snapshot_count: String(childQuantities.length),
    };
    for (let i = 0; i < childQuantities.length; i++) {
      snapshotProps[`_cyo_snapshot_${i + 1}_name`] = childQuantities[i].title;
      snapshotProps[`_cyo_snapshot_${i + 1}_qty`] = String(childQuantities[i].quantity);
    }

    const parentItem = {
      id: Number(parentVariantId),
      quantity: 1,
      properties: {
        _cyo_group_key: groupKey,
        _cyo_role: 'parent',
        _cyo_box_type: this.selectionType,
        _cyo_summary: summary,
        _cyo_item_count: itemCount,
        ...snapshotProps,
      },
    };

    const childItems = childQuantities.map((child) => ({
      id: Number(child.variantId),
      quantity: child.quantity,
      properties: {
        _cyo_group_key: groupKey,
        _cyo_role: 'child',
        _cyo_parent_product_id: productId,
      },
    }));

    return { items: [parentItem, ...childItems] };
  }

  /**
   * Collects section IDs from cart-items-component elements for section rendering.
   * Matches the pattern used in ProductFormComponent.#processBatchAddToCart.
   * @returns {string}
   */
  #getCartSectionIds() {
    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    const sectionIds = [];
    for (const item of cartItemsComponents) {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        sectionIds.push(item.dataset.sectionId);
      }
    }
    return sectionIds.join(',');
  }

  /**
   * Finds the error display element in the section's buy-buttons block.
   * @returns {HTMLElement|null}
   */
  #getErrorElement() {
    return this.closest('.shopify-section')?.querySelector('[ref="addToCartTextError"]') || null;
  }

  /**
   * Submits the CYO cart payload via /cart/add.js and dispatches CartAddEvent on success.
   */
  async #submitCyoCart() {
    const { items } = this.#buildCartPayload();
    if (items.length === 0) return;

    const sections = this.#getCartSectionIds();
    const payload = { items, sections };
    const errorEl = this.#getErrorElement();

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.status) {
        // Error response from Shopify (e.g. sold out, invalid variant)
        if (errorEl) {
          errorEl.classList.remove('hidden');
          const textNode = errorEl.childNodes[2];
          if (textNode) {
            textNode.textContent = data.message;
          } else {
            errorEl.appendChild(document.createTextNode(data.message));
          }
        }

        this.dispatchEvent(
          new CartAddEvent({}, this.dataset.productId || '', {
            didError: true,
            source: 'cyo-builder',
            itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
            productId: this.dataset.productId,
          })
        );
        return;
      }

      // Success
      if (errorEl) {
        errorEl.classList.add('hidden');
      }

      this.dispatchEvent(
        new CartAddEvent(data ?? undefined, this.dataset.productId || '', {
          source: 'cyo-builder',
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
          productId: this.dataset.productId,
          sections: data.sections,
        })
      );

      // Reset builder to empty state after successful add
      this.handleClear();
    } catch (error) {
      console.error('CYO cart add failed:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Scroll arrows (desktop horizontal scroll for option rows)
  // ---------------------------------------------------------------------------

  /**
   * Binds scroll listeners and click handlers on each .cyo-builder__scroller.
   * Uses ResizeObserver for initial arrow state and container size changes.
   */
  #bindScrollers() {
    const scrollers = this.querySelectorAll('.cyo-builder__scroller');
    for (const scroller of scrollers) {
      const cards = scroller.querySelector('.cyo-builder__cards');
      const prevBtn = scroller.querySelector('[data-cyo-scroll-prev]');
      const nextBtn = scroller.querySelector('[data-cyo-scroll-next]');
      if (!cards || !prevBtn || !nextBtn) continue;

      const update = () => this.#updateArrows(cards, prevBtn, nextBtn);

      cards.addEventListener('scroll', update, { passive: true });

      const ro = new ResizeObserver(update);
      ro.observe(cards);

      const scrollAmount = 228; // card width (220) + gap (8)
      const onPrev = () => cards.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
      const onNext = () => cards.scrollBy({ left: scrollAmount, behavior: 'smooth' });

      prevBtn.addEventListener('click', onPrev);
      nextBtn.addEventListener('click', onNext);

      this.#scrollerCleanups.push(() => {
        cards.removeEventListener('scroll', update);
        ro.disconnect();
        prevBtn.removeEventListener('click', onPrev);
        nextBtn.removeEventListener('click', onNext);
      });
    }
  }

  /**
   * Refreshes arrow visibility on every scroller in this component.
   * Call after any event that may change scrollable width (e.g. DOM updates).
   */
  #updateAllArrows() {
    const scrollers = this.querySelectorAll('.cyo-builder__scroller');
    for (const scroller of scrollers) {
      const cards = scroller.querySelector('.cyo-builder__cards');
      const prevBtn = scroller.querySelector('[data-cyo-scroll-prev]');
      const nextBtn = scroller.querySelector('[data-cyo-scroll-next]');
      if (!cards || !prevBtn || !nextBtn) continue;
      this.#updateArrows(cards, prevBtn, nextBtn);
    }
  }

  /**
   * Toggles .is-visible on prev/next arrow buttons based on scroll position.
   * Moves focus to the other arrow when the focused arrow hides at a boundary.
   * @param {HTMLElement} cards
   * @param {HTMLButtonElement} prevBtn
   * @param {HTMLButtonElement} nextBtn
   */
  #updateArrows(cards, prevBtn, nextBtn) {
    const maxScroll = cards.scrollWidth - cards.clientWidth;
    if (maxScroll <= 0) {
      prevBtn.classList.remove('is-visible');
      nextBtn.classList.remove('is-visible');
      return;
    }

    const scrollLeft = Math.round(cards.scrollLeft);

    if (scrollLeft > 1) {
      prevBtn.classList.add('is-visible');
    } else {
      prevBtn.classList.remove('is-visible');
      if (document.activeElement === prevBtn) nextBtn.focus();
    }

    if (scrollLeft < maxScroll - 1) {
      nextBtn.classList.add('is-visible');
    } else {
      nextBtn.classList.remove('is-visible');
      if (document.activeElement === nextBtn) prevBtn.focus();
    }
  }

  /**
   * Handles cyo:slots-update on the document to update the preview slide.
   * @param {CustomEvent} event
   */
  #handleSlotsUpdate = (event) => {
    const { slots } = event.detail;
    if (!slots) return;

    // Update CYO preview slide slot images
    const previewEl = document.querySelector('[data-cyo-preview]');
    if (!previewEl) return;

    for (const slot of slots) {
      const slotEl = previewEl.querySelector(`[data-cyo-slot="${slot.index}"]`);
      if (!slotEl) continue;

      const emptyEl = slotEl.querySelector('[data-cyo-slot-empty]');
      const imgEl = slotEl.querySelector('[data-cyo-slot-image]');

      if (slot.imageUrl) {
        if (imgEl) {
          imgEl.src = slot.imageUrl;
          imgEl.alt = slot.productTitle || '';
        }
        slotEl.dataset.filled = 'true';
      } else {
        if (imgEl) {
          imgEl.removeAttribute('src');
          imgEl.alt = '';
        }
        slotEl.dataset.filled = 'false';
      }
    }

    // Show/hide the clear button in the preview
    const clearBtn = previewEl.querySelector('[data-cyo-clear]');
    if (clearBtn) {
      const hasSelections = slots.some((s) => s.imageUrl != null);
      clearBtn.style.display = hasSelections ? '' : 'none';
    }
  };
}

if (!customElements.get('cyo-builder')) {
  customElements.define('cyo-builder', CyoBuilder);
}

// Handle the clear button in the CYO preview slide
document.addEventListener('click', (event) => {
  const clearBtn = event.target.closest('[data-cyo-clear]');
  if (!clearBtn) return;

  const builder = document.querySelector('cyo-builder');
  if (builder) {
    builder.handleClear();
  }
});
