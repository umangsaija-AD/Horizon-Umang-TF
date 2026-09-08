import { Component } from '@theme/component';

/**
 * <image-parallax-component>
 *
 * Wraps an in-flow image (`.image-block__image`) and scrubs its vertical
 * position to the page scroll so it transitions from a content-aligned resting
 * state into an overflow of the adjacent section.
 *
 * Resting state (section entering the viewport): the image sits exactly where
 * it was placed in the layout — no repositioning. As the section scrolls
 * through the viewport the image drifts from that original position.
 * Overflow = 'top' → image drifts up; 'bottom' → image drifts down; 'both' →
 * image swings symmetrically around its resting position.
 *
 * Directional clipping is handled in CSS (clip-path on `.shopify-section` via
 * :has()), and the image is removed from the section's height calc in CSS so a
 * tall image can travel freely. This component only sets the transform.
 *
 * The wrapper is `display: contents`, so geometry is measured from the inner
 * image. Work is gated behind an IntersectionObserver + rAF and skipped under
 * prefers-reduced-motion.
 */

const PREFERS_REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How far past the border (as a fraction of image height) the image ends up. */
const OVERFLOW_FRACTION = 0.3;

export class ImageParallaxComponent extends Component {
  /** @type {HTMLImageElement | null} */
  #img = null;
  /** @type {HTMLElement | null} */
  #section = null;
  /** @type {'top' | 'bottom' | 'both'} */
  #overflow = 'bottom';
  /** @type {boolean} */
  #inView = false;
  /** @type {number | null} */
  #raf = null;
  /** @type {IntersectionObserver | null} */
  #io = null;
  /** @type {AbortController | null} */
  #abort = null;
  /** @type {number} resting offset aligning the image to the content edge */
  #base = 0;
  /** @type {number} total scroll-scrubbed travel toward/through the border */
  #range = 0;

  connectedCallback() {
    super.connectedCallback();

    if (PREFERS_REDUCED_MOTION) return;

    this.#img = this.querySelector('.image-block__image');
    if (!this.#img) return;

    this.#overflow = /** @type {'top' | 'bottom' | 'both'} */ (this.dataset.overflow || 'bottom');
    this.#section = this.closest('.shopify-section') || this.closest('section');

    this.#abort = new AbortController();
    const { signal } = this.#abort;

    if (this.#img.complete) {
      this.#computeBase();
    } else {
      this.#img.addEventListener('load', this.#computeBase, { once: true, signal });
    }
    window.addEventListener('resize', this.#onResize, { passive: true, signal });

    this.#io = new IntersectionObserver(this.#onIntersect, { rootMargin: '100px 0px' });
    this.#io.observe(this.#img);
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
   * Resting offset is 0 — the image stays exactly where it sits in the layout.
   * Range is the scroll-scrubbed drift distance (a fraction of image height),
   * applied from that resting position.
   */
  #computeBase = () => {
    if (!this.#img) return;

    this.#img.style.transform = 'translate3d(0, 0, 0)';
    const height = this.#img.getBoundingClientRect().height;
    if (!height) return; // not laid out yet

    const hang = OVERFLOW_FRACTION * height;

    // Keep the image at its natural position; only drift it on scroll.
    this.#base = 0;
    this.#range = this.#overflow === 'both' ? 2 * hang : hang;

    this.#schedule();
  };

  #onResize = () => {
    this.#computeBase();
  };

  /** @param {IntersectionObserverEntry[]} entries */
  #onIntersect = (entries) => {
    for (const entry of entries) {
      this.#inView = entry.isIntersecting;
      const signal = this.#abort?.signal;
      if (this.#inView) {
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
    if (!this.#img || !this.#section || !this.#inView) return;

    const secRect = this.#section.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;

    // progress: signed scrub centered on the section being centered in the
    // viewport. -1 = section entering from the bottom, 0 = centered, +1 =
    // section exiting past the top.
    const sectionCenter = secRect.top + secRect.height / 2;
    const span = (viewportH + secRect.height) / 2;
    let progress = span ? (viewportH / 2 - sectionCenter) / span : 0;
    progress = Math.max(-1, Math.min(1, progress));

    // f: 0 when the section is entering from the bottom of the viewport, 1 when
    // it has scrolled up and is exiting the top. The drift is continuous from
    // entry — so the effect is active well before the section is centered — but
    // eased (f²) so early motion is gentle and the image's top stays readable
    // through the in-focus zone, then reveals more strongly as it scrolls out.
    const f = (progress + 1) / 2;
    const eased = f * f;

    let translateY;
    if (this.#overflow === 'top') {
      translateY = this.#base - eased * this.#range;
    } else if (this.#overflow === 'bottom') {
      translateY = this.#base + eased * this.#range;
    } else {
      translateY = this.#base + (f - 0.5) * this.#range;
    }

    this.#img.style.transform = `translate3d(0, ${translateY.toFixed(2)}px, 0)`;
  };
}

if (!customElements.get('image-parallax-component')) {
  customElements.define('image-parallax-component', ImageParallaxComponent);
}
