class DynamicYieldWidget extends HTMLElement {
  connectedCallback() {
    if (this._isSetup) return;

    const setupStartedAt = performance.now();
    const setupTimeoutMs = 10000;

    const trySetup = () => {
      if (!this.isConnected || this._isSetup) return;

      if (this.querySelector("[class*='tabcontent_'], a[class*='tabbed-recs-card_'] img")) {
        this._setup();
      } else if (performance.now() - setupStartedAt < setupTimeoutMs) {
        requestAnimationFrame(trySetup);
      }
    };

    requestAnimationFrame(trySetup);
  }

  disconnectedCallback() {
    this._teardownDrag();
    this._isSetup = false;
    this._scrollers = null;
  }

  _setup() {
    if (this._isSetup) return;

    this._isSetup = true;
    this._scrollers = Array.from(this.querySelectorAll("[class*='tabcontent_']"));

    this.querySelectorAll("a[class*='tabbed-recs-card_'] img").forEach((image) => this._setupImageFallback(image));
    this._scrollers.forEach((scroller) => this._setupDrag(scroller));
  }

  _setupImageFallback(image) {
    if (!(image instanceof HTMLImageElement) || image.dataset.dyImageFallback === 'true') return;

    image.dataset.dyImageFallback = 'true';
    image.addEventListener('error', () => image.classList.add('dy-image-error'));

    if (!image.getAttribute('src') || image.getAttribute('src') === 'null') {
      image.classList.add('dy-image-error');
    }
  }

  /**
   * Enables mouse drag-to-scroll, following the swipable-group interaction.
   * Touch remains native overflow scrolling.
   */
  _setupDrag(scroller) {
    if (!(scroller instanceof HTMLElement)) return;

    this._dragHandlers ||= new Map();
    if (this._dragHandlers.has(scroller)) return;

    const state = {
      dragController: null,
      isDragging: false,
      suppressClick: false,
      suppressClickTimer: null,
      finishSettle: null,
      settleTimer: null,
    };

    const onClickCapture = (event) => {
      if (!state.suppressClick) return;

      state.suppressClick = false;
      clearTimeout(state.suppressClickTimer);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const finishScroll = () => {
      scroller.style.scrollSnapType = '';
      scroller.style.scrollBehavior = '';
      state.finishSettle = null;
    };

    const settleToNearest = () => {
      const items = Array.from(scroller.children);
      if (!items.length) {
        finishScroll();
        return;
      }

      const styles = getComputedStyle(scroller);
      const padLeft = parseFloat(styles.scrollPaddingLeft) || parseFloat(styles.scrollPaddingInlineStart) || 0;
      const edge = scroller.getBoundingClientRect().left + padLeft;

      let nearest = items[0];
      let best = Infinity;
      for (const item of items) {
        const distance = Math.abs(item.getBoundingClientRect().left - edge);
        if (distance < best) {
          best = distance;
          nearest = item;
        }
      }

      const target = scroller.scrollLeft + (nearest.getBoundingClientRect().left - edge);
      const maxLeft = scroller.scrollWidth - scroller.clientWidth;
      const clamped = Math.max(0, Math.min(target, maxLeft));
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        scroller.removeEventListener('scrollend', finish);
        clearTimeout(state.settleTimer);
        finishScroll();
      };

      state.finishSettle = finish;
      scroller.style.scrollBehavior = reduceMotion ? 'auto' : 'smooth';
      scroller.addEventListener('scrollend', finish, { once: true });
      scroller.scrollTo({ left: clamped, behavior: reduceMotion ? 'auto' : 'smooth' });

      state.settleTimer = setTimeout(finish, reduceMotion ? 0 : 600);
    };

    const onMouseDown = (event) => {
      if (event.button !== 0 || state.isDragging) return;
      if (scroller.scrollWidth <= scroller.clientWidth) return;

      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select')) return;

      event.preventDefault();
      state.finishSettle?.();
      state.dragController?.abort();

      const startX = event.clientX;
      let previousX = startX;
      let moved = false;

      const controller = new AbortController();
      state.dragController = controller;
      const { signal } = controller;

      const onMove = (moveEvent) => {
        const distanceFromStart = startX - moveEvent.clientX;

        if (!moved && Math.abs(distanceFromStart) >= 6) {
          moved = true;
          state.isDragging = true;
          scroller.style.scrollSnapType = 'none';
          scroller.style.scrollBehavior = 'auto';
          scroller.classList.add('is-dragging');
        }

        if (!moved) return;

        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();

        const delta = previousX - moveEvent.clientX;
        previousX = moveEvent.clientX;
        scroller.scrollLeft += delta;
      };

      const onEnd = () => {
        controller.abort();
        state.dragController = null;
        scroller.classList.remove('is-dragging');

        if (moved) {
          state.suppressClick = true;
          clearTimeout(state.suppressClickTimer);
          state.suppressClickTimer = setTimeout(() => {
            state.suppressClick = false;
          }, 400);

          settleToNearest();
        } else {
          finishScroll();
        }

        state.isDragging = false;
      };

      document.addEventListener('mousemove', onMove, { signal });
      document.addEventListener('mouseup', onEnd, { signal });
    };

    scroller.addEventListener('mousedown', onMouseDown);
    scroller.addEventListener('click', onClickCapture, true);
    this._dragHandlers.set(scroller, { onMouseDown, onClickCapture, state });
  }

  _teardownDrag() {
    if (!this._dragHandlers) return;

    this._dragHandlers.forEach(({ onMouseDown, onClickCapture, state }, scroller) => {
      state.dragController?.abort();
      state.finishSettle?.();
      clearTimeout(state.suppressClickTimer);
      clearTimeout(state.settleTimer);
      scroller.removeEventListener('mousedown', onMouseDown);
      scroller.removeEventListener('click', onClickCapture, true);
    });

    this._dragHandlers.clear();
  }
}

if (!customElements.get('dynamic-yield-widget')) {
  customElements.define('dynamic-yield-widget', DynamicYieldWidget);
}
