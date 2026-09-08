import { Component } from '@theme/component';

/**
 * <parallax-image-component>
 *
 * Small decorative image that scrolls slower than the page (classic depth
 * parallax). Works inside any parent section — the component ensures the
 * closest section ancestor has position:relative so the absolute positioning
 * lands correctly.
 *
 * Parallax is always driven by a rAF-based scroll handler gated behind an
 * IntersectionObserver so the work only happens while the element is visible.
 */

const PREFERS_REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const MOBILE_QUERY = '(max-width: 749px)';

export class ParallaxImageComponent extends Component {
  /** @type {HTMLImageElement | SVGElement | null} */
  #img = null;
  /** @type {number} 0-1, where 0 = strongest parallax, 1 = no parallax */
  #speed = 0.5;
  /** @type {'none' | 'both' | 'desktop_only' | 'mobile_only'} */
  #visibility = 'none';
  /** @type {boolean} */
  #inView = false;
  /** @type {number | null} */
  #raf = null;
  /** @type {IntersectionObserver | null} */
  #io = null;
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {MediaQueryList | null} */
  #mobileMQ = null;
  /** @type {number} max px the image can travel in either direction */
  #maxTravel = 80;

  connectedCallback() {
    super.connectedCallback();

    this.#ensureParentPositioned();

    if (PREFERS_REDUCED_MOTION) return;

    this.#img = this.querySelector('.parallax-image__img');
    if (!this.#img) return;

    this.#speed = parseFloat(this.dataset.speed ?? '0.5') || 0;
    this.#visibility = /** @type {'none' | 'both' | 'desktop_only' | 'mobile_only'} */ (
      this.dataset.visibility ?? 'none'
    );
    this.#maxTravel = parseFloat(
      getComputedStyle(this).getPropertyValue('--parallax-travel')
    ) || 80;

    if (this.#visibility === 'none' || this.#speed >= 1) return;

    this.#mobileMQ = matchMedia(MOBILE_QUERY);

    this.#abort = new AbortController();
    const { signal } = this.#abort;

    this.#mobileMQ.addEventListener('change', this.#onMediaChange, { signal });

    this.#io = new IntersectionObserver(this.#onIntersect, { rootMargin: '100px 0px' });
    this.#io.observe(this);

    if (this.#shouldHide()) return;

    window.addEventListener('resize', this.#schedule, { passive: true, signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this.#abort?.abort();
    this.#io?.disconnect();
    if (this.#raf != null) cancelAnimationFrame(this.#raf);
    window.removeEventListener('scroll', this.#schedule);
    this.#raf = null;
    this.#io = null;
    this.#abort = null;
  }

  /**
   * Ensure the closest section ancestor has position:relative so this
   * element's absolute positioning resolves against it.
   */
  #ensureParentPositioned() {
    const section = this.closest('.shopify-section') || this.closest('section');
    if (!section) return;
    const pos = getComputedStyle(section).position;
    if (pos === 'static') section.style.position = 'relative';
  }

  /** @returns {boolean} */
  #shouldHide() {
    if (this.#visibility === 'none') return true;
    if (!this.#mobileMQ) return false;
    if (this.#visibility === 'desktop_only') return this.#mobileMQ.matches;
    if (this.#visibility === 'mobile_only') return !this.#mobileMQ.matches;
    return false;
  }

  #onMediaChange = () => {
    if (this.#shouldHide()) {
      this.#resetTransform();
      window.removeEventListener('scroll', this.#schedule);
      window.removeEventListener('resize', this.#schedule);
    } else {
      const signal = this.#abort?.signal;
      window.addEventListener('resize', this.#schedule, { passive: true, signal });
      if (this.#inView) {
        window.addEventListener('scroll', this.#schedule, { passive: true, signal });
        this.#schedule();
      }
    }
  };

  /** @param {IntersectionObserverEntry[]} entries */
  #onIntersect = (entries) => {
    for (const entry of entries) {
      this.#inView = entry.isIntersecting;
      if (this.#inView) {
        if (this.#shouldHide()) continue;
        const signal = this.#abort?.signal;
        window.addEventListener('scroll', this.#schedule, { passive: true, signal });
        this.#schedule();
      } else {
        window.removeEventListener('scroll', this.#schedule);
      }
    }
  };

  #schedule = () => {
    if (this.#raf != null) return;
    this.#raf = requestAnimationFrame(this.#update);
  };

  #update = () => {
    this.#raf = null;
    if (!this.#img || !this.#inView) return;
    if (this.#shouldHide()) return;

    const rect = this.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;

    // progress: -1 when element centre is at viewport bottom, +1 at viewport top
    const centre = rect.top + rect.height / 2;
    const raw = (viewportH / 2 - centre) / (viewportH / 2 + rect.height / 2);
    const progress = Math.max(-1, Math.min(1, raw));

    const intensity = 1 - this.#speed;
    const translateY = progress * intensity * this.#maxTravel;

    this.#img.style.transform = `translate3d(0, ${translateY.toFixed(2)}px, 0)`;
  };

  #resetTransform() {
    if (this.#img) this.#img.style.transform = 'translate3d(0, 0, 0)';
  }
}

if (!customElements.get('parallax-image-component')) {
  customElements.define('parallax-image-component', ParallaxImageComponent);
}
