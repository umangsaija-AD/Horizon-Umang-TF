// @ts-nocheck
/**
 * Catering Quick View — standalone ES module.
 * Intercepts product card image clicks on catering collection pages,
 * fetches a server-rendered Quick View section via the Section Rendering API,
 * and opens it inside the global drawer.
 *
 * No @theme/* imports — fully self-contained, loaded via <script type="module">.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a price in cents as a USD string. Used as a fallback when
 * server-rendered `formatted_price` is not available on a variant.
 * @param {number} cents
 * @returns {string}
 */
function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Cache ────────────────────────────────────────────────────────────────────
// Per-handle cache: { html: string, product: object }
const _cache = new Map();

// Shimmer skeleton shown while product data is fetched — mirrors the drawer's
// content shape (gallery → details → variants → CTA). Styles live in
// snippets/catering-quick-view.liquid.
const LOADING_SKELETON_HTML = `
  <div class="catering-quick-view" aria-busy="true" aria-label="Loading product">
    <div class="catering-quick-view__body">
      <div class="catering-quick-view__gallery">
        <div class="catering-quick-view__main-images">
          <div class="catering-quick-view__slide cqv-skel"></div>
        </div>
        <div class="catering-quick-view__thumbnails">
          <div class="catering-quick-view__thumbnail cqv-skel"></div>
          <div class="catering-quick-view__thumbnail cqv-skel"></div>
          <div class="catering-quick-view__thumbnail cqv-skel"></div>
          <div class="catering-quick-view__thumbnail cqv-skel"></div>
        </div>
      </div>
      <div class="catering-quick-view__details">
        <div class="catering-quick-view__content">
          <div class="catering-quick-view__heading-block">
            <div class="cqv-skel cqv-skel--title"></div>
            <div class="cqv-skel cqv-skel--price"></div>
          </div>
          <div class="catering-quick-view__variant-section">
            <div class="cqv-skel cqv-skel--label"></div>
            <div class="catering-quick-view__variant-list">
              <div class="cqv-skel cqv-skel--variant"></div>
              <div class="cqv-skel cqv-skel--variant"></div>
            </div>
          </div>
        </div>
        <div class="catering-quick-view__cta">
          <div class="cqv-skel cqv-skel--btn"></div>
        </div>
      </div>
    </div>
  </div>`;

// ── State ────────────────────────────────────────────────────────────────────
let _currentProduct = null;
let _selectedVariantId = null;
// Whether catering event details have been entered this session. Tracked via the
// same `catering:event:saved` event that catering-cart.js listens to, so the
// Quick View ATC can gate on it exactly like the product-grid ATC does.
let _hasEventDetails = false;
// Monotonic token identifying the latest open request. Used instead of
// `dialog.open` to decide whether to render fetched content, because the dialog
// opens on a requestAnimationFrame (see dialog.js) while a cache hit resolves on
// an earlier microtask — so `dialog.open` is still false on a fast second open.
let _openRequestId = 0;
// Quantity entered in the originating product card's stepper, captured when the
// Quick View opens so the QV "Add" matches the card's Add-button flow.
let _pendingQuantity = 1;

// ── Fetch section HTML ──────────────────────────────────────────────────────

function fetchQuickViewData(handle) {
  // Cache hit: reuse the stored promise. Repeat opens of the same product — and
  // concurrent clicks before the first request settles — share a single fetch.
  if (_cache.has(handle)) return _cache.get(handle);

  const request = (async () => {
    // Fetch the section markup and the product data in parallel.
    // Product data comes from Shopify's native `/products/{handle}.js` endpoint
    // (the same reliable source the catering variant-selector drawer uses)
    // rather than a hand-rolled JSON blob embedded in the section — the section
    // render does not reliably receive `product` context, which left the
    // embedded JSON (and the drawer body) empty.
    const sectionUrl = `/products/${encodeURIComponent(handle)}?section_id=catering-quick-view-content`;
    const productUrl = `/products/${encodeURIComponent(handle)}.js`;

    const [sectionResponse, productResponse] = await Promise.all([
      fetch(sectionUrl),
      fetch(productUrl),
    ]);

    if (!sectionResponse.ok) throw new Error(`Quick View section fetch failed: ${sectionResponse.status}`);
    if (!productResponse.ok) throw new Error(`Quick View product fetch failed: ${productResponse.status}`);

    const rawHtml = await sectionResponse.text();
    const product = await productResponse.json();

    // Extract inner content from the section wrapper.
    // The Section Rendering API wraps in <div id="shopify-section-..." class="shopify-section">
    const temp = document.createElement('div');
    temp.innerHTML = rawHtml;
    const sectionWrapper = temp.querySelector('.shopify-section');
    const html = sectionWrapper ? sectionWrapper.innerHTML : rawHtml;

    return { html, product };
  })();

  // Store the in-flight promise immediately so concurrent calls dedupe onto it.
  // Drop it on failure so a later open can retry instead of replaying the error.
  _cache.set(handle, request);
  request.catch(() => _cache.delete(handle));

  return request;
}

// ── Open drawer ─────────────────────────────────────────────────────────────

async function openQuickView(handle) {
  if (!window.GlobalDrawer || typeof window.GlobalDrawer.openDrawer !== 'function') {
    console.warn('[catering-quick-view] GlobalDrawer not available');
    return;
  }

  // Mark this as the latest open request. If a newer request starts (the user
  // clicks another product) before this one's data resolves, we skip rendering.
  const requestId = ++_openRequestId;

  // Show loading state immediately by opening the drawer with a skeleton.
  // This is the ONLY openDrawer call — subsequent updates go directly to
  // refs.content.innerHTML to avoid the dialog.open guard.
  window.GlobalDrawer.openDrawer({
    title: 'Product details',
    content: LOADING_SKELETON_HTML,
    drawerStyle: { width: 'calc(100vw - 32px)', desktopWidth: '588px' },
    titleStyle: { preset: 'h4', color: '#464646', weight: '600' },
    showBack: true,
  });

  try {
    const { html, product } = await fetchQuickViewData(handle);

    // A newer open request superseded this one — let it own the drawer.
    if (requestId !== _openRequestId) return;

    if (!product) {
      console.error('[catering-quick-view] No product data found');
      window.GlobalDrawer.closeDrawer();
      return;
    }

    _currentProduct = product;

    // Auto-select first available variant
    const firstAvailable = product.variants.find((v) => v.available);
    const selectedVariant = firstAvailable || product.variants[0] || null;
    _selectedVariantId = selectedVariant ? selectedVariant.id : null;

    // Replace loading spinner with actual content directly on the content ref.
    // This avoids a second openDrawer() call which would be blocked by the
    // dialog.open guard in GlobalDrawer.
    window.GlobalDrawer.refs.content.innerHTML = html;

    // Filter the gallery to the auto-selected variant's image + shared media,
    // so the drawer doesn't show other variants' images. Runs synchronously
    // before paint, so there's no flash of the unfiltered gallery.
    const wrapper = window.GlobalDrawer.refs.content.querySelector('[data-catering-quick-view]');
    if (wrapper && selectedVariant) filterMediaForVariant(wrapper, selectedVariant);
  } catch (err) {
    if (requestId !== _openRequestId) return;
    console.error('[catering-quick-view] Error loading Quick View:', err);
    window.GlobalDrawer.closeDrawer();
  }
}

// ── Gallery interaction ─────────────────────────────────────────────────────

/**
 * Activate the gallery slide (and matching thumbnail) at the given index, and
 * scroll the horizontal image strip to it. Used by both thumbnail clicks and
 * variant selection.
 * @param {HTMLElement} wrapper
 * @param {number|string} index - zero-based slide index
 * @param {'smooth'|'auto'} [behavior='smooth'] - 'auto' for an instant jump
 *   (used on variant change, where the gallery has just been re-filtered).
 */
function goToSlide(wrapper, index, behavior = 'smooth') {
  if (!wrapper || index == null) return;
  const idx = String(index);

  setActiveThumb(wrapper, idx);

  const mainImages = wrapper.querySelector('[data-cqv-main-images]');
  const targetSlide = wrapper.querySelector(`[data-cqv-slide="${idx}"]`);
  if (!mainImages || !targetSlide) return;

  // Suppress scroll-driven thumb sync during this programmatic scroll, otherwise
  // the active thumb flickers through the intermediate slides the scroll passes
  // over. The target thumb is already set above.
  _suppressThumbSync = true;
  if (_suppressThumbSyncTimer) clearTimeout(_suppressThumbSyncTimer);
  _suppressThumbSyncTimer = setTimeout(() => { _suppressThumbSync = false; }, 600);

  // Defer one frame so any just-applied media filtering (hidden slides) has
  // reflowed and CSS scroll-snap has re-settled before we measure. Measuring
  // synchronously after filterMediaForVariant() reads a stale layout, which made
  // the strip scroll to the wrong spot and then snap back.
  requestAnimationFrame(() => {
    const visibleSlides = mainImages.querySelectorAll('[data-cqv-slide]:not([hidden])');
    const isLast = visibleSlides.length && visibleSlides[visibleSlides.length - 1] === targetSlide;

    // The last slide is `scroll-snap-align: end` and can't left-align — scroll
    // fully to the end so mandatory snap rests on it.
    if (isLast) {
      mainImages.scrollTo({ left: mainImages.scrollWidth, behavior });
      return;
    }

    // Land the slide on its mandatory snap point — i.e. inset by the container's
    // scroll-padding — not the container's border edge. Scrolling to the border
    // edge leaves the browser to re-snap by the padding amount right after, which
    // is the visible "scroll then jump back".
    const cs = getComputedStyle(mainImages);
    const snapInset = parseFloat(cs.scrollPaddingLeft) || parseFloat(cs.paddingLeft) || 0;
    const delta =
      targetSlide.getBoundingClientRect().left - mainImages.getBoundingClientRect().left - snapInset;
    mainImages.scrollBy({ left: delta, behavior });
  });
}

/**
 * Show only the selected variant's image plus shared/unattached media (videos and
 * images not tied to any variant), hiding other variants' images — mirrors the
 * PDP's hide_variants gallery. If the variant has no image, nothing is hidden.
 */
function filterMediaForVariant(wrapper, variant) {
  const selPos = (variant && variant.featured_image && typeof variant.featured_image.position === 'number')
    ? String(variant.featured_image.position)
    : null;
  const apply = (el) => {
    const attached = el.getAttribute('data-cqv-attached') === 'true';
    el.hidden = attached && selPos != null && el.getAttribute('data-cqv-image-position') !== selPos;
  };
  wrapper.querySelectorAll('[data-cqv-slide]').forEach(apply);
  wrapper.querySelectorAll('[data-cqv-thumb]').forEach(apply);
}

/** Highlight the thumbnail matching the given slide index. */
function setActiveThumb(wrapper, index) {
  const idx = String(index);
  wrapper.querySelectorAll('[data-cqv-thumb]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.cqvThumb === idx);
  });
}

function handleThumbnailClick(thumbBtn) {
  const wrapper = thumbBtn.closest('[data-catering-quick-view]');
  if (!wrapper) return;

  const index = thumbBtn.dataset.cqvThumb;
  if (index == null) return;

  goToSlide(wrapper, index);
}

// Keep the active thumbnail in sync while the user scrolls the image strip.
let _galleryScrollRaf = null;
// Set while goToSlide() runs a programmatic smooth scroll, so the scroll handler
// doesn't fight it by highlighting the slides the animation passes through.
let _suppressThumbSync = false;
let _suppressThumbSyncTimer = null;

function handleGalleryScroll(e) {
  const container = e.target;
  if (!(container instanceof Element) || !container.matches('[data-cqv-main-images]')) return;
  if (_suppressThumbSync) return;
  if (_galleryScrollRaf) return;
  _galleryScrollRaf = requestAnimationFrame(() => {
    _galleryScrollRaf = null;
    syncThumbToScroll(container);
  });
}

function syncThumbToScroll(container) {
  const wrapper = container.closest('[data-catering-quick-view]');
  if (!wrapper) return;

  const slides = container.querySelectorAll('[data-cqv-slide]:not([hidden])');
  if (!slides.length) return;

  let activeIndex = null;

  // When scrolled to (or near) the end, the last slide is active — it can never
  // reach the left edge, so the "nearest to left" test below would wrongly pick
  // the second-to-last slide.
  if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 2) {
    activeIndex = slides[slides.length - 1].dataset.cqvSlide;
  } else {
    // Otherwise highlight the slide currently snapped to the left.
    const containerLeft = container.getBoundingClientRect().left;
    let minDist = Infinity;
    slides.forEach((slide) => {
      const dist = Math.abs(slide.getBoundingClientRect().left - containerLeft);
      if (dist < minDist) {
        minDist = dist;
        activeIndex = slide.dataset.cqvSlide;
      }
    });
  }

  if (activeIndex != null) setActiveThumb(wrapper, activeIndex);
}

// ── Variant interaction ─────────────────────────────────────────────────────

function handleVariantSelect(variantCard) {
  if (!_currentProduct) return;

  const variantId = parseInt(variantCard.dataset.cqvVariant, 10);
  if (isNaN(variantId)) return;

  const variant = _currentProduct.variants.find((v) => v.id === variantId);
  if (!variant) return;

  // Out-of-stock variants are still selectable (so the user can view them); the
  // Add button below switches to a disabled "Sold out" state for them.
  _selectedVariantId = variantId;

  const wrapper = variantCard.closest('[data-catering-quick-view]');
  if (!wrapper) return;

  // Update variant card selection
  wrapper.querySelectorAll('[data-cqv-variant]').forEach((card) => {
    const id = parseInt(card.dataset.cqvVariant, 10);
    const isSelected = id === variantId;
    card.classList.toggle('is-selected', isSelected);
    card.setAttribute('aria-selected', String(isSelected));
  });

  // Show only this variant's image + shared media (hide other variants' images),
  // then switch the gallery to the variant's image. Slides may include videos, so
  // map the image's 1-based `position` to its slide via data-cqv-image-position
  // rather than assuming slide index === image position.
  filterMediaForVariant(wrapper, variant);
  if (variant.featured_image && typeof variant.featured_image.position === 'number') {
    const slide = wrapper.querySelector(`[data-cqv-image-position="${variant.featured_image.position}"]`);
    // Instant jump (not smooth): the gallery was just re-filtered above, so a
    // smooth scroll would animate across slides that are mid-reflow and fight the
    // scroll-snap re-settle.
    if (slide) goToSlide(wrapper, slide.dataset.cqvSlide, 'auto');
  }

  // Update only the variant value; the bold option name + colon are static.
  const valueEl = wrapper.querySelector('[data-cqv-variant-value]');
  if (valueEl) {
    valueEl.textContent = variant.title;
  }

  // Show the selected variant's ingredients (variant-specific, server-rendered),
  // hiding the others — matches the PDP's per-variant ingredients.
  wrapper.querySelectorAll('[data-cqv-ingredients]').forEach((el) => {
    el.hidden = el.getAttribute('data-cqv-ingredients') !== String(variantId);
  });

  // Update the price shown under the title for the selected variant.
  const priceBlock = wrapper.querySelector('[data-cqv-price-block]');
  if (priceBlock) {
    const priceEl = priceBlock.querySelector('.catering-quick-view__price');
    if (priceEl) priceEl.textContent = variant.formatted_price || formatPrice(variant.price);

    // Show, create, or hide the compare-at price depending on the variant.
    let compareEl = priceBlock.querySelector('.catering-quick-view__compare-price');
    const hasCompare = variant.compare_at_price && variant.compare_at_price > variant.price;
    if (hasCompare) {
      if (!compareEl && priceEl) {
        compareEl = document.createElement('span');
        compareEl.className = 'catering-quick-view__compare-price';
        priceEl.insertAdjacentElement('afterend', compareEl);
      }
      if (compareEl) {
        compareEl.textContent = formatPrice(variant.compare_at_price);
        compareEl.style.display = '';
      }
    } else if (compareEl) {
      compareEl.style.display = 'none';
    }
  }

  // Update the Add button: "Add - <price>" when available, disabled "Sold out"
  // otherwise. Mirrors the server-rendered sold-out state.
  const addBtn = wrapper.querySelector('[data-cqv-add]');
  if (addBtn) {
    if (variant.available) {
      addBtn.disabled = false;
      const priceStr = variant.formatted_price || formatPrice(variant.price);
      addBtn.textContent = `Add - ${priceStr}`;
    } else {
      addBtn.disabled = true;
      addBtn.textContent = 'Sold out';
    }
  }

  // Update delivery availability
  const deliveryEl = wrapper.querySelector('[data-cqv-delivery]');
  if (deliveryEl && variant.delivery_availability) {
    const da = variant.delivery_availability;
    // Build nodes directly (no data-derived innerHTML) to avoid an XSS surface.
    deliveryEl.textContent = '';
    if (da.icon) {
      const img = document.createElement('img');
      img.src = da.icon;
      img.alt = '';
      img.width = 16;
      img.height = 16;
      img.loading = 'lazy';
      img.style.width = '16px';
      img.style.height = '16px';
      deliveryEl.appendChild(img);
    }
    const span = document.createElement('span');
    span.textContent = da.name || '';
    deliveryEl.appendChild(span);
    deliveryEl.style.display = '';
  } else if (deliveryEl) {
    deliveryEl.style.display = 'none';
  }
}

// ── Add to cart ─────────────────────────────────────────────────────────────

function handleAddToCart() {
  if (!_currentProduct || !_selectedVariantId) return;

  // Gate on catering event details, mirroring the product-grid ATC flow: if the
  // customer hasn't entered them yet, close the Quick View and open the
  // event-details drawer instead. (Quick View is a top-layer <dialog>, so it
  // must be closed first or the event drawer would render behind it.)
  if (!_hasEventDetails) {
    if (window.GlobalDrawer && typeof window.GlobalDrawer.closeDrawer === 'function') {
      window.GlobalDrawer.closeDrawer();
    }
    const trigger = document.querySelector('[data-open-catering-drawer]');
    if (trigger) {
      trigger.click();
    } else {
      document.dispatchEvent(new CustomEvent('catering:open-event-drawer'));
    }
    return;
  }

  const variant = _currentProduct.variants.find((v) => v.id === _selectedVariantId);
  if (!variant) return;

  // `/products/{handle}.js` returns `images` as an array of URL strings, while
  // each variant's `featured_image` is an object with a `src`. Handle both.
  const productImages = _currentProduct.images || [];
  let image = '';
  if (variant.featured_image && variant.featured_image.src) {
    image = variant.featured_image.src;
  } else if (productImages.length > 0) {
    const first = productImages[0];
    image = typeof first === 'string' ? first : (first.src || '');
  }

  document.dispatchEvent(new CustomEvent('catering:add-to-cart', {
    detail: {
      variantId: variant.id,
      productId: _currentProduct.id,
      title: _currentProduct.title,
      variantTitle: variant.title,
      price: variant.price,
      image: image,
      quantity: _pendingQuantity,
    },
  }));

  // Close the drawer
  if (window.GlobalDrawer && typeof window.GlobalDrawer.closeDrawer === 'function') {
    window.GlobalDrawer.closeDrawer();
  }

  _currentProduct = null;
  _selectedVariantId = null;
  _pendingQuantity = 1;
}

// ── Delegated click handler (drawer interactions) ───────────────────────────

function handleDrawerClick(e) {
  const wrapper = e.target.closest('[data-catering-quick-view]');
  if (!wrapper) return;

  // Thumbnail click
  const thumbBtn = e.target.closest('[data-cqv-thumb]');
  if (thumbBtn) {
    e.preventDefault();
    handleThumbnailClick(thumbBtn);
    return;
  }

  // Variant card click — out-of-stock variants are selectable too (the Add
  // button then shows the disabled "Sold out" state).
  const variantCard = e.target.closest('[data-cqv-variant]');
  if (variantCard) {
    handleVariantSelect(variantCard);
    return;
  }

  // Add button click
  const addBtn = e.target.closest('[data-cqv-add]');
  if (addBtn && !addBtn.disabled) {
    handleAddToCart();
    return;
  }
}

// ── Image gallery click interception ────────────────────────────────────────

/**
 * Resolve the product handle for a Quick View trigger. Prefers the handle on the
 * trigger itself (`data-cqv-handle`), then the card's catering ATC element
 * (`data-product-handle`), then a legacy product href as a last resort.
 */
function resolveHandle(trigger, card) {
  let handle = trigger.getAttribute('data-cqv-handle') || '';

  if (!handle && card) {
    const atcEl = card.querySelector('[data-product-handle]');
    handle = atcEl ? atcEl.getAttribute('data-product-handle') : '';
  }

  if (!handle) {
    const href = trigger.getAttribute('href') || '';
    const segs = href.split('/products/');
    if (segs.length >= 2) handle = segs[1].split('?')[0].split('#')[0];
  }

  return handle;
}

function openFromTrigger(e, trigger) {
  const card = trigger.closest('.product-card');
  if (!card) return;

  e.preventDefault();
  e.stopPropagation();

  const handle = resolveHandle(trigger, card);
  if (!handle) return;

  // Capture the card's entered quantity so QV "Add" matches the card Add flow.
  _pendingQuantity = readCardQuantity(card);
  openQuickView(handle);
}

/** Read the quantity entered in the card's stepper; defaults to 1. */
function readCardQuantity(card) {
  const input = card.querySelector('[data-catering-qty-count]');
  const qty = input ? parseInt(input.value, 10) : 1;
  return Math.max(1, qty || 1);
}

function handleImageClick(e) {
  // Only active on catering pages
  if (!document.querySelector('[data-catering-cart-bar]')) return;

  // Catering image trigger ([data-cqv-image], no href so it never navigates),
  // falling back to a legacy product link if one is present.
  const trigger = e.target.closest('[data-cqv-image]')
    || e.target.closest('product-image-gallery a[href*="/products/"]');
  if (!trigger) return;

  openFromTrigger(e, trigger);
}

// The catering image trigger is a role="button"; support keyboard activation.
function handleImageKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  if (!document.querySelector('[data-catering-cart-bar]')) return;

  const trigger = e.target.closest('[data-cqv-image]');
  if (!trigger) return;

  openFromTrigger(e, trigger);
}

// ── Drawer header (back + title) closes the Quick View ───────────────────────
// The back arrow already closes via its own on:click="/closeDrawer"; this also
// makes the adjacent title text clickable so the whole "< Product details"
// affordance dismisses the drawer. Scoped to when Quick View content is shown.
function handleHeaderClick(e) {
  if (!window.GlobalDrawer || !window.GlobalDrawer.refs) return;
  const dialog = window.GlobalDrawer.refs.dialog;
  if (!dialog || !dialog.querySelector('.catering-quick-view')) return;
  if (!e.target.closest('.global-drawer__title')) return;

  window.GlobalDrawer.closeDrawer();
}

// ── Init ────────────────────────────────────────────────────────────────────

function init() {
  // Guard: only activate on catering collection pages
  if (!document.querySelector('[data-catering-cart-bar]')) return;

  // Intercept image clicks on product cards (capture phase to beat navigation)
  document.addEventListener('click', handleImageClick, true);
  document.addEventListener('keydown', handleImageKeydown, true);

  // Handle interactions inside the Quick View drawer (bubble phase)
  document.addEventListener('click', handleDrawerClick);

  // Clicking the drawer title (next to the back arrow) closes the Quick View.
  document.addEventListener('click', handleHeaderClick);

  // Sync the active thumbnail as the image strip is scrolled (capture phase —
  // scroll events don't bubble).
  document.addEventListener('scroll', handleGalleryScroll, true);

  // Track whether catering event details have been entered, so the ATC can gate
  // on them. Mirrors catering-cart.js's own `catering:event:saved` listener.
  document.addEventListener('catering:event:saved', (e) => {
    _hasEventDetails = Boolean(e.detail);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
