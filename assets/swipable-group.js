/**
 * Horizontally scrollable group with optional prev/next arrow controls.
 * Registered under multiple tag names for section-specific markup.
 */
export class SwipableGroupElement extends HTMLElement {
  connectedCallback() {
    if (this._scroller) return;

    const scheduleSetup = this.querySelector('slideshow-component')
      ? (fn) => setTimeout(fn, 0)
      : (fn) => requestAnimationFrame(fn);

    const trySetup = () => {
      if (!this.isConnected || this._scroller) return;
      if (this.querySelector('[data-scroller]')) {
        this._setup();
      } else {
        scheduleSetup(trySetup);
      }
    };

    scheduleSetup(trySetup);
  }

  disconnectedCallback() {
    if (this._prevBtn) this._prevBtn.removeEventListener('click', this._onPrevClick);
    if (this._nextBtn) this._nextBtn.removeEventListener('click', this._onNextClick);
    if (this._scroller) this._scroller.removeEventListener('scroll', this._onScroll);
    if (this._slideshow) this._slideshow.removeEventListener('slideshow:select', this._onScroll);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._arrowRaf) cancelAnimationFrame(this._arrowRaf);
    this._finishSettle?.();
    this._teardownDrag();
    this._scroller = null;
    this._prevBtn = null;
    this._nextBtn = null;
    this._slideshow = null;
  }

  _setup() {
    if (this._scroller) return;

    this._slideshow = this.querySelector('slideshow-component');
    this._scroller = this.querySelector('[data-scroller]');
    this._prevBtn = this.querySelector('[data-prev]');
    this._nextBtn = this.querySelector('[data-next]');

    this._onPrevClick = (event) => this._navigate(-1, event);
    this._onNextClick = (event) => this._navigate(1, event);
    // rAF-throttled; skipped mid-drag so pointer tracking stays smooth.
    this._onScroll = () => {
      if (this._isDragging || this._arrowRaf) return;
      this._arrowRaf = requestAnimationFrame(() => {
        this._arrowRaf = null;
        this._updateArrows();
      });
    };

    if (this._prevBtn) this._prevBtn.addEventListener('click', this._onPrevClick);
    if (this._nextBtn) this._nextBtn.addEventListener('click', this._onNextClick);
    if (this._slideshow) {
      this._slideshow.addEventListener('slideshow:select', this._onScroll);
    }
    if (this._scroller) {
      this._scroller.addEventListener('scroll', this._onScroll, { passive: true });
      this._resizeObserver = new ResizeObserver(this._onScroll);
      this._resizeObserver.observe(this._scroller);
    }

    this._setupDrag();
    requestAnimationFrame(() => this._updateArrows());
  }

  /**
   * Enables mouse drag-to-scroll, following Horizon's slideshow interaction.
   * Touch remains native overflow scrolling.
   */
  _setupDrag() {
    if (!this._scroller) return;

    this._dragController = null;
    this._isDragging = false;
    this._suppressClick = false;

    this._onClickCapture = (/** @type {MouseEvent} */ event) => {
      if (!this._suppressClick) return;

      this._suppressClick = false;
      clearTimeout(this._suppressClickTimer);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    this._onMouseDown = (/** @type {MouseEvent} */ event) => {
      if (event.button !== 0 || this._isDragging) return;
      if (this._scroller.scrollWidth <= this._scroller.clientWidth) return;

      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select')) return;

      event.preventDefault();
      this._finishSettle?.();
      this._dragController?.abort();

      const startX = event.clientX;
      let previousX = startX;
      let moved = false;
      const actionTarget = target instanceof Element ? target.closest('[on\\:click]') : null;
      const action = actionTarget?.getAttribute('on:click');

      const controller = new AbortController();
      this._dragController = controller;
      const { signal } = controller;

      const onMove = (/** @type {MouseEvent} */ moveEvent) => {
        const distanceFromStart = startX - moveEvent.clientX;

        if (!moved && Math.abs(distanceFromStart) >= 6) {
          moved = true;
          this._isDragging = true;
          this._scroller.style.scrollSnapType = 'none';
          this._scroller.style.scrollBehavior = 'auto';
          this._scroller.classList.add('is-dragging');

          // Horizon delegates `on:click` from document before a scroller
          // capture listener can cancel it. Disable the pressed action while
          // dragging so a video poster cannot start playback.
          if (actionTarget && action) {
            actionTarget.removeAttribute('on:click');
            this._dragActionTarget = actionTarget;
            this._dragAction = action;
          }
        }

        if (!moved) return;

        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();

        const delta = previousX - moveEvent.clientX;
        previousX = moveEvent.clientX;
        this._scroller.scrollLeft += delta;
      };

      const onEnd = () => {
        controller.abort();
        this._dragController = null;
        this._scroller.classList.remove('is-dragging');

        if (moved) {
          this._suppressClick = true;
          clearTimeout(this._suppressClickTimer);
          this._suppressClickTimer = setTimeout(() => {
            this._suppressClick = false;
          }, 400);

          if (actionTarget && action) {
            clearTimeout(this._restoreActionTimer);
            this._restoreActionTimer = setTimeout(() => {
              actionTarget.setAttribute('on:click', action);
              this._dragActionTarget = null;
              this._dragAction = null;
            });
          }

          this._settleToNearest();
        } else {
          this._scroller.style.scrollSnapType = '';
          this._scroller.style.scrollBehavior = '';
        }

        this._isDragging = false;
      };

      document.addEventListener('mousemove', onMove, { signal });
      document.addEventListener('mouseup', onEnd, { signal });
    };

    this._scroller.addEventListener('mousedown', this._onMouseDown);
    this._scroller.addEventListener('click', this._onClickCapture, true);
  }

  /**
   * Aligns the nearest card before restoring scroll snap.
   */
  _settleToNearest() {
    const scroller = this._scroller;
    if (!scroller) return;

    const items = Array.from(scroller.children);
    if (!items.length) {
      scroller.style.scrollSnapType = '';
      scroller.style.scrollBehavior = '';
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
      clearTimeout(this._settleTimer);
      scroller.style.scrollSnapType = '';
      scroller.style.scrollBehavior = '';
      this._finishSettle = null;
      this._updateArrows();
    };

    this._finishSettle = finish;
    scroller.style.scrollBehavior = reduceMotion ? 'auto' : 'smooth';
    scroller.addEventListener('scrollend', finish, { once: true });
    scroller.scrollTo({ left: clamped, behavior: reduceMotion ? 'auto' : 'smooth' });

    this._settleTimer = setTimeout(finish, reduceMotion ? 0 : 600);
  }

  /**
   * Cleans up pointer drag listeners and any in-flight gesture.
   */
  _teardownDrag() {
    if (this._dragController) {
      this._dragController.abort();
      this._dragController = null;
    }

    clearTimeout(this._suppressClickTimer);
    this._suppressClick = false;
    clearTimeout(this._restoreActionTimer);

    if (this._dragActionTarget && this._dragAction) {
      this._dragActionTarget.setAttribute('on:click', this._dragAction);
    }
    this._dragActionTarget = null;
    this._dragAction = null;

    if (this._scroller && this._onMouseDown) {
      this._scroller.removeEventListener('mousedown', this._onMouseDown);
    }

    if (this._scroller && this._onClickCapture) {
      this._scroller.removeEventListener('click', this._onClickCapture, true);
    }
  }

  /**
   * Slides that participate in layout (excludes display:none promo on mobile).
   * @returns {HTMLElement[]}
   */
  _getNavigableSlides() {
    const slides = this._slideshow?.slides;
    if (!slides?.length) return [];

    return slides.filter((slide) => {
      if (slide.hasAttribute('hidden')) return false;
      return slide.offsetWidth > 0;
    });
  }

  /**
   * @returns {boolean}
   */
  _isAtScrollStart() {
    if (!this._scroller) return true;

    const navigable = this._getNavigableSlides();
    const firstSlide = navigable[0];
    if (firstSlide) {
      const scrollerRect = this._scroller.getBoundingClientRect();
      const firstRect = firstSlide.getBoundingClientRect();
      if (firstRect.left >= scrollerRect.left - 2) return true;
    }

    return this._scroller.scrollLeft <= 1;
  }

  /**
   * @returns {boolean}
   */
  _isAtScrollEnd() {
    if (!this._scroller) return true;

    const navigable = this._getNavigableSlides();
    const lastSlide = navigable[navigable.length - 1];
    if (lastSlide) {
      const scrollerRect = this._scroller.getBoundingClientRect();
      const lastRect = lastSlide.getBoundingClientRect();
      if (lastRect.right <= scrollerRect.right + 2) return true;
    }

    const { scrollLeft, scrollWidth, clientWidth } = this._scroller;
    return scrollLeft + clientWidth >= scrollWidth - 2;
  }

  /**
   * Index within navigable slides aligned to the scroller's leading edge.
   * @returns {number}
   */
  _getActiveNavigableIndex() {
    const navigable = this._getNavigableSlides();
    if (!navigable.length) return 0;

    if (!this._scroller) return 0;

    const scrollerStart = this._scroller.getBoundingClientRect().left;
    let activeIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < navigable.length; i++) {
      const distance = Math.abs(navigable[i].getBoundingClientRect().left - scrollerStart);
      if (distance < closestDistance) {
        closestDistance = distance;
        activeIndex = i;
      }
    }

    return activeIndex;
  }

  /**
   * @param {number} direction
   * @param {Event} [event]
   */
  _navigate(direction, event) {
    if (this._slideshow) {
      const navigable = this._getNavigableSlides();
      const { slides } = this._slideshow;
      if (!navigable.length || !slides?.length) return;

      const activeNavIndex = this._getActiveNavigableIndex();
      const targetNavIndex = activeNavIndex + direction;
      if (targetNavIndex < 0 || targetNavIndex >= navigable.length) return;

      const targetIndex = slides.indexOf(navigable[targetNavIndex]);
      if (targetIndex === -1) return;

      this._slideshow.select(targetIndex, event);
      return;
    }

    if (!this._scroller) return;
    const items = Array.from(this._scroller.children);
    if (!items.length) return;
    const gap = parseFloat(getComputedStyle(this._scroller).columnGap) || 0;
    const itemWidth = items[0].getBoundingClientRect().width + gap;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    this._scroller.scrollBy({ left: itemWidth * direction, behavior });
  }

  _updateArrows() {
    if (this._slideshow && this._scroller) {
      const { infinite } = this._slideshow;

      if (this._prevBtn) this._prevBtn.disabled = Boolean(!infinite && this._isAtScrollStart());
      if (this._nextBtn) this._nextBtn.disabled = Boolean(!infinite && this._isAtScrollEnd());
      return;
    }

    if (!this._scroller) return;
    if (this._prevBtn) this._prevBtn.disabled = this._isAtScrollStart();
    if (this._nextBtn) this._nextBtn.disabled = this._isAtScrollEnd();
  }
}

/** @param {string} tagName */
function defineSwipableGroup(tagName) {
  if (!customElements.get(tagName)) {
    // Each tag needs its own constructor; the registry rejects reusing one class.
    customElements.define(tagName, class extends SwipableGroupElement {});
  }
}

defineSwipableGroup('swipable-group-component');
defineSwipableGroup('product-list-carousel');
defineSwipableGroup('featured-collections-carousel');
