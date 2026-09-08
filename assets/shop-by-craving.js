/**
 * ShopByCraving — custom element for exclusive-accordion panel behaviour.
 *
 * State is driven entirely via data-open attributes so CSS can target
 * [data-open="true"] / [data-open="false"] with zero extra class toggling.
 *
 * Usage:
 *   <shop-by-craving>
 *     <div data-craving-panel data-open="false">
 *       <button data-craving-trigger>Category Name</button>
 *       <div class="shop-by-craving__content">...</div>
 *     </div>
 *     <!-- more panels -->
 *   </shop-by-craving>
 */

class ShopByCraving extends HTMLElement {
  connectedCallback() {
    this._panels = Array.from(this.querySelectorAll('[data-craving-panel]'));

    // Attach a click listener to each trigger button.
    this._panels.forEach((panel, index) => {
      const trigger = panel.querySelector('[data-craving-trigger]');
      if (!trigger) return;

      trigger.addEventListener('click', () => {
        this.openPanel(index);
      });
    });

    // Open the first panel (index 0 in DOM order) by default.
    if (this._panels.length > 0) {
      this.openPanel(0);
    }
  }

  /**
   * Opens the panel at the given DOM index and collapses all sibling panels.
   * Exactly one panel has data-open="true" at any time (exclusive accordion).
   *
   * @param {number} index - Zero-based index of the panel to open.
   */
  openPanel(index) {
    this._panels.forEach((panel, i) => {
      const isTarget = i === index;
      panel.dataset.open = isTarget ? 'true' : 'false';

      const trigger = panel.querySelector('[data-craving-trigger]');
      if (trigger) {
        trigger.setAttribute('aria-expanded', isTarget ? 'true' : 'false');
      }

      const content = panel.querySelector('.shop-by-craving__content');
      if (content) {
        content.setAttribute('aria-hidden', isTarget ? 'false' : 'true');
      }
    });
  }
}

if (!customElements.get('shop-by-craving')) {
  customElements.define('shop-by-craving', ShopByCraving);
}
