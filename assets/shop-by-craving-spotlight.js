/**
 * ShopByCravingSpotlight
 *
 * Spotlight card + circular thumbnail rail.
 *
 * Pointer devices (hover: hover, pointer: fine):
 *   mouseenter on a thumb → preview that slide (temporary)
 *   mouseleave on the rail → revert to the committed slide
 *   click → commit the selection
 *
 * Touch / keyboard:
 *   click / Enter / Space → commit (no hover preview)
 *   focus → commit (keyboard nav advances the spotlight as the user tabs)
 *
 * prefers-reduced-motion: CSS disables transitions; JS behaviour is unchanged.
 */

class ShopByCravingSpotlight extends HTMLElement {
  connectedCallback() {
    this._slides = Array.from(this.querySelectorAll('[data-sbc-slide]'));
    this._thumbs = Array.from(this.querySelectorAll('[data-sbc-thumb]'));
    this._rail = this.querySelector('[data-sbc-rail]');
    this._activeIndex = 0;
    this._isPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    this._thumbs.forEach((thumb, index) => {
      if (this._isPointer) {
        thumb.addEventListener('mouseenter', () => this._preview(index));
      }

      thumb.addEventListener('click', () => this._commit(index));

      // Keyboard: committing on focus means tabbing through thumbs advances the spotlight
      thumb.addEventListener('focus', () => this._commit(index));
    });

    // On pointer devices: leaving the rail reverts the spotlight to the committed slide
    if (this._isPointer && this._rail) {
      this._rail.addEventListener('mouseleave', () => this._preview(this._activeIndex));
    }

    // Ensure JS-driven state matches the server-rendered initial state
    this._commit(0);
  }

  /**
   * Show a slide temporarily (hover preview or revert).
   * Does NOT change aria-selected or _activeIndex.
   */
  _preview(index) {
    this._slides.forEach((slide, i) => {
      const active = i === index;
      slide.dataset.active = active ? 'true' : 'false';
      if (active) {
        slide.removeAttribute('inert');
        slide.removeAttribute('aria-hidden');
      } else {
        slide.setAttribute('inert', '');
        slide.setAttribute('aria-hidden', 'true');
      }
    });

    this._thumbs.forEach((thumb, i) => {
      thumb.dataset.preview = i === index ? 'true' : 'false';
    });
  }

  /**
   * Commit a selection: update _activeIndex, aria-selected, and call _preview
   * so the correct slide is shown.
   */
  _commit(index) {
    this._activeIndex = index;

    this._thumbs.forEach((thumb, i) => {
      const selected = i === index;
      thumb.setAttribute('aria-selected', selected ? 'true' : 'false');
      thumb.dataset.preview = 'false';
    });

    this._preview(index);
  }
}

if (!customElements.get('shop-by-craving-spotlight')) {
  customElements.define('shop-by-craving-spotlight', ShopByCravingSpotlight);
}
