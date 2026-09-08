/**
 * Native Search Drawer
 *
 * Handles input debouncing, predictive search API fetching,
 * DOM toggling between empty state and results, and keyboard support.
 */
export {};

const DEBOUNCE_MS = 300;
const SECTION_ID = 'search-drawer';

class NativeSearchDrawer {
  /** @type {HTMLElement|null} */
  #drawer = null;
  /** @type {HTMLInputElement|null} */
  #input = null;
  /** @type {HTMLElement|null} */
  #clearBtn = null;
  /** @type {HTMLElement|null} */
  #emptyState = null;
  /** @type {HTMLElement|null} */
  #resultsContainer = null;
  /** @type {HTMLElement|null} */
  #loading = null;
  /** @type {string} */
  #rootUrl = '/';
  /** @type {number|null} */
  #debounceTimer = null;
  /** @type {AbortController|null} */
  #abortController = null;
  /** @type {MutationObserver|null} */
  #observer = null;

  constructor() {
    this.#drawer = document.querySelector('.js-search-drawer');
    if (!this.#drawer) return;

    this.#input = this.#drawer.querySelector('[data-search-input]');
    this.#clearBtn = this.#drawer.querySelector('[data-search-clear]');
    this.#emptyState = this.#drawer.querySelector('[data-search-empty-state]');
    this.#resultsContainer = this.#drawer.querySelector('[data-search-results]');
    this.#loading = this.#drawer.querySelector('[data-search-loading]');
    // routes.root_url is '/' on the primary locale but '/fr' (no trailing
    // slash) on localized storefronts — normalize so the suggest URL becomes
    // '/fr/search/suggest', not '/frsearch/suggest'.
    const rootUrl = this.#drawer.dataset.rootUrl || '/';
    this.#rootUrl = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`;

    if (!this.#input) return;

    this.#bindEvents();
    this.#observeDrawerState();
  }

  #bindEvents() {
    this.#input.addEventListener('input', this.#handleInput.bind(this));
    this.#input.addEventListener('keydown', this.#handleKeydown.bind(this));

    if (this.#clearBtn) {
      this.#clearBtn.addEventListener('click', this.#handleClear.bind(this));
    }

    const form = this.#input.form;
    if (form) {
      form.addEventListener('submit', this.#handleSubmit.bind(this));
    }
  }

  /**
   * @param {SubmitEvent} event
   */
  #handleSubmit(event) {
    const term = this.#input.value.trim();
    if (!term) {
      event.preventDefault();
      this.#input.focus();
    }
  }

  #observeDrawerState() {
    this.#observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;

        const isOpen = this.#drawer.classList.contains('--is-open');
        if (isOpen) {
          this.#onDrawerOpen();
        } else {
          this.#onDrawerClose();
        }
      }
    });

    this.#observer.observe(this.#drawer, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  #onDrawerOpen() {
    requestAnimationFrame(() => {
      this.#input.focus();
    });
  }

  #onDrawerClose() {
    this.#reset();
  }

  /**
   * @param {Event} event
   */
  #handleInput(event) {
    const term = event.target.value.trim();

    this.#updateClearButtonVisibility(term.length > 0);

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }

    if (!term) {
      this.#showEmptyState();
      return;
    }

    this.#debounceTimer = setTimeout(() => {
      this.#fetchResults(term);
    }, DEBOUNCE_MS);
  }

  /**
   * @param {KeyboardEvent} event
   */
  #handleKeydown(event) {
    if (event.key !== 'Escape') return;

    event.preventDefault();
    event.stopPropagation();

    const term = this.#input.value.trim();
    if (term) {
      this.#input.value = '';
      this.#showEmptyState();
      this.#updateClearButtonVisibility(false);
    } else {
      const trigger = document.querySelector('.js-search-trigger');
      if (trigger) trigger.click();
    }
  }

  #handleClear() {
    this.#input.value = '';
    this.#showEmptyState();
    this.#updateClearButtonVisibility(false);
    this.#input.focus();
  }

  /**
   * @param {boolean} visible
   */
  #updateClearButtonVisibility(visible) {
    if (!this.#clearBtn) return;
    this.#clearBtn.style.display = visible ? 'flex' : 'none';
  }

  /**
   * @param {string} term
   */
  async #fetchResults(term) {
    if (this.#abortController) {
      this.#abortController.abort();
    }

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.#showLoading();

    const url = `${this.#rootUrl}search/suggest?q=${encodeURIComponent(term)}&resources[type]=product,page,article&section_id=${SECTION_ID}`;

    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        this.#showError('Please try again, something went wrong!');
        return;
      }

      const text = await response.text();
      const html = this.#extractSectionHTML(text);
      this.#showResults(html);
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.#hideLoading();
      console.error('Search fetch error:', error);
    }
  }

  /**
   * Extract the section innerHTML from the API response.
   * Shopify wraps the section output in a <div id="shopify-section-{id}">.
   * @param {string} text
   * @returns {string}
   */
  #extractSectionHTML(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    const sectionEl = doc.querySelector(`#shopify-section-${SECTION_ID}`);
    return sectionEl ? sectionEl.innerHTML : text;
  }

  /**
   * @param {string} html
   */
  #showResults(html) {
    if (!this.#resultsContainer || !this.#emptyState) return;

    this.#resultsContainer.innerHTML = html;
    this.#emptyState.classList.add('--hidden');
    this.#hideLoading();
    this.#resultsContainer.classList.remove('--hidden');
  }

  #showEmptyState() {
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }

    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    if (!this.#resultsContainer || !this.#emptyState) return;

    this.#hideLoading();
    this.#resultsContainer.innerHTML = '';
    this.#resultsContainer.classList.add('--hidden');
    this.#emptyState.classList.remove('--hidden');
  }

  #showLoading() {
    if (this.#emptyState) this.#emptyState.classList.add('--hidden');
    if (this.#resultsContainer) this.#resultsContainer.classList.add('--hidden');
    if (this.#loading) this.#loading.classList.remove('--hidden');
  }

  #hideLoading() {
    if (this.#loading) this.#loading.classList.add('--hidden');
  }

  #showError(message) {
    this.#hideLoading();
    if (this.#resultsContainer) {
      this.#resultsContainer.innerHTML = `<p class="search-drawer__error">${message}</p>`;
      this.#resultsContainer.classList.remove('--hidden');
    }
  }

  #reset() {
    if (this.#input) {
      this.#input.value = '';
    }
    this.#updateClearButtonVisibility(false);
    this.#showEmptyState();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new NativeSearchDrawer());
} else {
  new NativeSearchDrawer();
}
