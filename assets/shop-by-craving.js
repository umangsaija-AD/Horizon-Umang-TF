/**
 * ShopByCraving — hover-to-expand (desktop) / tap-to-expand (touch).
 *
 * Auto-rotation interval is driven by data-auto-interval (seconds) on the
 * custom element, set from the section's auto_rotation_interval schema setting.
 *
 * Behaviours:
 *  - Desktop (pointer: fine): mouseenter on any panel opens it.
 *  - Touch / mobile: clicking the trigger bar opens the panel.
 *  - Focus (keyboard): focusing a trigger opens its panel on any device.
 *  - Auto-rotation: cycles every N seconds when idle; pauses on hover /
 *    focus / interaction; restarts 2 s after the pointer leaves.
 *  - prefers-reduced-motion: auto-rotation is skipped entirely (CSS handles
 *    disabling blur/scale transitions).
 */

class ShopByCraving extends HTMLElement {
  connectedCallback() {
    this._panels = Array.from(this.querySelectorAll('[data-craving-panel]'));
    this._autoTimer = null;
    this._resumeTimer = null;
    this._activeIndex = 0;
    this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._isPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    // Interval in ms from schema setting (seconds); fall back to 5 s
    this._intervalMs = (parseInt(this.dataset.autoInterval, 10) || 5) * 1000;

    this._panels.forEach((panel, index) => {
      const trigger = panel.querySelector('[data-craving-trigger]');
      if (!trigger) return;

      if (this._isPointer) {
        panel.addEventListener('mouseenter', () => {
          this._pauseAuto();
          this._openPanel(index);
        });
      } else {
        trigger.addEventListener('click', () => {
          this._pauseAuto();
          this._openPanel(index);
        });
      }

      // Keyboard: focus opens the panel on any device
      trigger.addEventListener('focus', () => {
        this._pauseAuto();
        this._openPanel(index);
      });
    });

    if (this._isPointer) {
      this.addEventListener('mouseleave', () => this._scheduleResume());
    }

    // First panel open by default
    if (this._panels.length > 0) {
      this._openPanel(0);
    }

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
    }, this._intervalMs);
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
