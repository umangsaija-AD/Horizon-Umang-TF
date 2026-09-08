import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

/* ------------------------------------------------------------------ */
/*  Predictive Search API                                              */
/* ------------------------------------------------------------------ */

async function fetchPredictiveSearchResults(query, { signal, rootPath = '/' } = {}) {
  const base = rootPath.endsWith('/') ? rootPath : rootPath + '/';
  const url =
    `${base}search/suggest.json?q=${encodeURIComponent(query)}` +
    '&resources[type]=product,collection,article,page,query' +
    '&resources[limit]=10';

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search request failed (${res.status})`);

  const json = await res.json();
  const r = json.resources?.results || {};

  return {
    queries: r.queries || [],
    products: r.products || [],
    collections: r.collections || [],
    pages: r.pages || [],
    articles: r.articles || [],
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightTitle(title, query) {
  const q = query.trim();
  if (!q || !title) return title;
  try {
    const re = new RegExp(`(${escapeRegExp(q)})`, 'gi');
    const parts = String(title).split(re);
    return parts.map((part, i) =>
      part.toLowerCase() === q.toLowerCase()
        ? html`<mark key=${`${i}-${part}`} className="ps-highlight">${part}</mark>`
        : html`<${React.Fragment} key=${`${i}-${part}`}>${part}<//>`
    );
  } catch {
    return title;
  }
}

function formatMoney(value) {
  if (value === undefined || value === null || value === '') return '';
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (Number.isNaN(n)) return '';
  const { currency, localeCode } = window.globalConfig || {
    currency: 'USD',
    localeCode: 'en-US',
  };
  return new Intl.NumberFormat(localeCode, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function productImageUrl(product) {
  if (product.featured_image?.url) return product.featured_image.url;
  if (product.image) return product.image;
  const v = product.variants?.[0];
  if (v && typeof v === 'object' && 'featured_image' in v && v.featured_image?.url) {
    return v.featured_image.url;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ProductCard({ product, query }) {
  const img = productImageUrl(product);
  const variantCount =
    typeof product.variantCount === 'number'
      ? product.variantCount
      : Array.isArray(product.variants)
        ? product.variants.length
        : 0;
  const variantLine = variantCount > 1 ? `${variantCount} options available` : null;

  const min = product.price_min ?? product.price;
  const max = product.price_max ?? product.price;
  let priceLabel = '';
  if (min != null && max != null && min !== max) {
    priceLabel = `Starting at ${formatMoney(min)}`;
  } else if (min != null) {
    priceLabel = formatMoney(min);
  }

  const compareMin = product.compare_at_price_min;
  const showCompare = compareMin != null && min != null && Number(compareMin) > Number(min);

  return html`
    <li className="ps-product-card">
      <a href=${product.url} className="ps-product-link">
        <div className="ps-product-image-wrap">
          ${img && html`
            <img
              src=${img}
              alt=${product.title}
              loading="lazy"
              className="ps-product-image"
              width=${480}
              height=${360}
            />
          `}
        </div>
        <div className="ps-product-info">
          <p className="ps-product-title">${highlightTitle(product.title, query)}</p>
          ${variantLine && html`<p className="ps-product-variants">${variantLine}</p>`}
          <div className="ps-product-price-row">
            ${showCompare && html`
              <span className="ps-price-compare">${formatMoney(compareMin)}</span>
            `}
            <span>${priceLabel}</span>
          </div>
        </div>
      </a>
    </li>
  `;
}

function SideSection({ title, children }) {
  return html`
    <section className="ps-side-section">
      <h3 className="ps-side-title">${title}</h3>
      ${children}
    </section>
  `;
}

function SideLink({ href, children }) {
  return html`<a href=${href} className="ps-side-link">${children}</a>`;
}

/* ------------------------------------------------------------------ */
/*  Results Panel                                                      */
/* ------------------------------------------------------------------ */

function ResultsPanel({ labels, query, results, loading, error, searchUrl, emptyState }) {
  const queries = results.queries ?? [];
  const pages = results.pages ?? [];
  const articles = results.articles ?? [];
  const collections = results.collections ?? [];
  const products = results.products ?? [];

  const hasAny = queries.length + pages.length + articles.length + collections.length + products.length > 0;
  const hasSideColumn = queries.length + pages.length + articles.length + collections.length > 0;
  const isEmptyQuery = !query.trim();

  if (loading) {
    return html`<div className="ps-loading" aria-live="polite">Searching\u2026</div>`;
  }

  if (error) {
    return html`<div className="ps-error">${error}</div>`;
  }

  if (!isEmptyQuery && !hasAny) {
    const noResultsText = (labels.noResults || '').replace(/__TERMS__/g, query);
    return html`<div className="ps-no-results">${noResultsText}</div>`;
  }

  return html`
    <div
      className=${hasSideColumn ? 'ps-results ps-results--with-sidebar' : 'ps-results'}
      data-query=${query}
    >
      ${!isEmptyQuery && html`
        <${React.Fragment}>
          ${hasSideColumn && html`
            <aside className="ps-sidebar" aria-label=${labels.sidebarAria ?? 'Text results'}>
              ${queries.length > 0 && html`
                <${SideSection} title=${labels.queries}>
                  <ul className="ps-side-list">
                    ${queries.map((item) => html`
                      <li key=${item.url} className="ps-side-item">
                        <${SideLink} href=${item.url}>
                          ${item.styled_text
                            ? html`<span dangerouslySetInnerHTML=${{ __html: item.styled_text }} />`
                            : item.text}
                        <//>
                      </li>
                    `)}
                  </ul>
                <//>
              `}
              ${pages.length > 0 && html`
                <${SideSection} title=${labels.pages}>
                  <ul className="ps-side-list">
                    ${pages.map((p) => html`
                      <li key=${p.id} className="ps-side-item">
                        <${SideLink} href=${p.url}>${highlightTitle(p.title, query)}<//>
                      </li>
                    `)}
                  </ul>
                <//>
              `}
              ${articles.length > 0 && html`
                <${SideSection} title=${labels.articles}>
                  <ul className="ps-side-list">
                    ${articles.map((a) => html`
                      <li key=${a.id} className="ps-side-item">
                        <${SideLink} href=${a.url}>${highlightTitle(a.title, query)}<//>
                      </li>
                    `)}
                  </ul>
                <//>
              `}
              ${collections.length > 0 && html`
                <${SideSection} title=${labels.collections}>
                  <ul className="ps-side-list">
                    ${collections.map((c) => html`
                      <li key=${c.id} className="ps-side-item">
                        <${SideLink} href=${c.url}>${highlightTitle(c.title, query)}<//>
                      </li>
                    `)}
                  </ul>
                <//>
              `}
            </aside>
          `}
          <div className=${hasSideColumn ? 'ps-main ps-main--with-sidebar' : 'ps-main'}>
            ${products.length > 0 ? html`
              <div>
                <h3 className="ps-products-heading">${labels.products}</h3>
                <ul className="ps-products-grid">
                  ${products.slice(0, 3).map((p) => html`
                    <${ProductCard} key=${p.id} product=${p} query=${query} />
                  `)}
                </ul>
              </div>
            ` : html`
              <p className="ps-no-products">${labels.noProducts}</p>
            `}
          </div>
        <//>
      `}

      ${isEmptyQuery && html`
        <div className="ps-empty-state">
          ${(emptyState.title || emptyState.collectionUrl) && html`
            <section className="ps-empty-featured">
              ${emptyState.title && html`
                <h3 className="ps-empty-title">${emptyState.title}</h3>
              `}
              ${emptyState.collectionUrl && html`
                <a href=${emptyState.collectionUrl} className="ps-empty-collection-link">
                  ${emptyState.collectionTitle || labels.collections}
                </a>
              `}
            </section>
          `}
          ${emptyState.topSearches.length > 0 && html`
            <section className="ps-empty-top-searches">
              <h3 className="ps-empty-title">${labels.queries}</h3>
              <ul className="ps-top-searches-list">
                ${emptyState.topSearches.map((term) => html`
                  <li key=${term} className="ps-top-search-item">
                    <a
                      href=${`${searchUrl}?q=${encodeURIComponent(term)}`}
                      className="ps-top-search-pill"
                    >${term}</a>
                  </li>
                `)}
              </ul>
            </section>
          `}
        </div>
      `}
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Root Component                                                     */
/* ------------------------------------------------------------------ */

function PredictiveSearch() {
  const inputId = useId();
  const inputRef = useRef(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({});

  const mount = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return document.getElementById('predictive-search');
  }, []);

  const labels = useMemo(() => {
    const d = mount?.dataset ?? {};
    return {
      search: d.labelSearch || 'Search',
      placeholder: d.labelPlaceholder || 'Search',
      clear: d.labelClear || 'Clear',
      close: d.labelClose || 'Close',
      products: d.labelProducts || 'Products',
      pages: d.labelPages || 'Pages',
      articles: d.labelArticles || 'Blog posts',
      collections: d.labelCollections || 'Collections',
      queries: d.labelQueries || 'Suggestions',
      viewAll: d.labelViewAll || 'View all',
      noResults: d.labelNoResults || '',
      noProducts: d.labelNoProducts || 'No matching products.',
      hintEmpty: d.labelHintEmpty || '',
      sidebarAria: d.labelSidebarAria || 'Search results',
    };
  }, [mount]);

  const searchUrl = mount?.dataset.searchUrl || '/search';
  const rootPath = mount?.dataset.rootUrl ?? '/';

  const emptyState = useMemo(() => {
    const d = mount?.dataset ?? {};
    return {
      title: d.emptyTitle || '',
      topSearches: (d.emptyTopSearches || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      collectionTitle: d.emptyCollectionTitle || '',
      collectionUrl: d.emptyCollectionUrl || '',
    };
  }, [mount]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      setResults({});
      setLoading(false);
      setError(null);
      return;
    }

    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetchPredictiveSearchResults(debouncedQuery, { signal: ac.signal, rootPath })
      .then((normalized) => {
        setResults({
          queries: normalized.queries,
          products: normalized.products,
          collections: normalized.collections,
          pages: normalized.pages,
          articles: normalized.articles,
        });
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message || 'Search failed');
        setResults({});
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [debouncedQuery, rootPath]);

  const clearQuery = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setResults({});
    setError(null);
    inputRef.current?.focus();
  }, []);

  const closeDrawer = useCallback(() => {
    const header = document.querySelector('header-component');
    if (header && typeof header.closeSearchDrawer === 'function') {
      header.closeSearchDrawer();
    }
  }, []);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      clearQuery();
      closeDrawer();
    }
  }, [clearQuery, closeDrawer]);

  return html`
    <div className="ps-root" data-predictive-search="">
      <div className="ps-input-row">
        <div className="ps-input-wrap">
          <label htmlFor=${inputId} className="visually-hidden">${labels.search}</label>
          <input
            ref=${inputRef}
            id=${inputId}
            type="text"
            autoComplete="off"
            placeholder=${labels.placeholder}
            value=${query}
            onChange=${(e) => setQuery(e.target.value)}
            onKeyDown=${onKeyDown}
            className="ps-input"
            role="combobox"
            aria-expanded=${Boolean(debouncedQuery && !loading)}
            aria-controls="predictive-search-results-panel"
          />
          <button
            type="button"
            className="ps-clear-btn"
            aria-label=${labels.clear}
            onClick=${clearQuery}
            disabled=${!query}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M17 7.00004L7 17M6.99996 7L16.9999 17" stroke="currentColor" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <div id="predictive-search-results-panel" className="ps-results-panel">
        <${ResultsPanel}
          labels=${labels}
          query=${debouncedQuery}
          results=${results}
          loading=${loading}
          error=${error}
          searchUrl=${searchUrl}
          emptyState=${emptyState}
        />
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

const container = document.getElementById('predictive-search');
if (container) {
  const root = createRoot(container);
  root.render(html`<${PredictiveSearch} />`);
}
