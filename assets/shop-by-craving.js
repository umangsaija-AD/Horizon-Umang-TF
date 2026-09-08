/**
 * ShopByCraving — hover-to-expand on pointer devices, tap-to-expand on touch.
 *
 * Behaviours:
 *  - Desktop (pointer: fine / hover: hover): mouseenter on any panel opens it.
 *    The trigger button covers the full tile so the whole tile is the hit zone.
 *  - Touch / mobile: clicking the trigger bar toggles the panel.
 *  - Focus (keyboard): focusing a trigger opens its panel on any device.
 *  - Auto-rotation: cycles panels every 4 500 ms when idle; pauses on any
 *    hover/focus/interaction and restarts after the user leaves.
 *  - prefers-reduced-motion: disables auto-rotation (CSS handles scale).
 */

class ShopByCraving extends HTMLElement {
  connectedCallback() {
    this._panels = Array.from(this.querySelectorAll('[data-craving-panel]'));
    this._autoTimer = null;
    this._resumeTimer = null;
    this._activeIndex = 0;
    this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // pointer: fine = mouse/trackpad with hover capability
    this._isPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    this._panels.forEach((panel, index) => {
      const trigger = panel.querySelector('[data-craving-trigger]');
      if (!trigger) return;

      if (this._isPointer) {
        // Hover opens the panel — whole tile is the hit zone via CSS
        panel.addEventListener('mouseenter', () => {
          this._pauseAuto();
          this._openPanel(index);
        });
      } else {
        // Touch: tap the trigger bar to expand
        trigger.addEventListener('click', () => {
          this._pauseAuto();
          this._openPanel(index);
        });
      }

      // Keyboard: focusing the trigger opens the panel on any device
      trigger.addEventListener('focus', () => {
        this._pauseAuto();
        this._openPanel(index);
      });
    });

    // Resume auto-rotation when the pointer leaves the component entirely
    if (this._isPointer) {
      this.addEventListener('mouseleave', () => this._scheduleResume());
    }

    // Open the first panel immediately
    if (this._panels.length > 0) {
      this._openPanel(0);
    }

    // Start idle auto-rotation (skipped for reduced-motion users)
    if (!this._reducedMotion) {
      this._startAuto();
    }
  }

  disconnectedCallback() {
    this._stopAuto();
    clearTimeout(this._resumeTimer);
  }

  _openPanel(index) {
    this._activeIndex = index;
    this._panels.forEach((panel, i) => {
      const open = i === index;
      panel.dataset.open = open ? 'true' : 'false';

      const trigger = panel.querySelector('[data-craving-trigger]');
      if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');

      const content = panel.querySelector('.shop-by-craving__content');
      if (content) content.setAttribute('aria-hidden', open ? 'false' : 'true');
    });
  }

  _startAuto() {
    this._stopAuto();
    this._autoTimer = setInterval(() => {
      this._activeIndex = (this._activeIndex + 1) % this._panels.length;
      this._openPanel(this._activeIndex);
    }, 4500);
  }

  _stopAuto() {
    clearInterval(this._autoTimer);
    this._autoTimer = null;
  }

  _pauseAuto() {
    this._stopAuto();
    clearTimeout(this._resumeTimer);
    this._resumeTimer = null;
  }

  // Restart auto-rotation 2 s after the user stops interacting
  _scheduleResume() {
    clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => {
      if (!this._reducedMotion) this._startAuto();
    }, 2000);
  }
}

if (!customElements.get('shop-by-craving')) {
  customElements.define('shop-by-craving', ShopByCraving);
}
