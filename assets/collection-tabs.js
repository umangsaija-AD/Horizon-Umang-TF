import { Component } from '@theme/component';

/**
 * @typedef {Object} CollectionTabsRefs
 * @property {HTMLElement[]} panels
 */

/** @extends {Component<CollectionTabsRefs>} */
export class CollectionTabsComponent extends Component {
  #active = 0;
  /** @type {HTMLElement[]} */
  #tabs = [];
  /** @type {AbortController | null} */
  #abort = null;
  #activeColor = '';
  #inactiveColor = '';

  connectedCallback() {
    super.connectedCallback();

    const { panels } = this.refs;
    if (!panels?.length) return;

    const nav = document.createElement('div');
    nav.className = 'collection-tabs__nav';
    nav.setAttribute('role', 'tablist');

    const preset = this.dataset.tabPreset || 'h3';
    const fontSize = this.dataset.tabFontSize;
    const activeColor = this.dataset.tabActiveColor || '';
    const inactiveColor = this.dataset.tabInactiveColor || '';
    this.#activeColor = activeColor;
    this.#inactiveColor = inactiveColor;

    this.#tabs = panels.map((panel, i) => {
      const btn = document.createElement('button');
      btn.className = 'collection-tabs__tab';
      btn.classList.add(preset);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(i === 0));
      btn.setAttribute('aria-controls', panel.id);
      btn.setAttribute('tabindex', '0');
      btn.textContent = panel.dataset.tabTitle || `Tab ${i + 1}`;
      btn.style.fontWeight = i === 0 ? '600' : '400';
      btn.style.color = i === 0 ? activeColor : inactiveColor;
      if (fontSize) btn.style.fontSize = fontSize;
      nav.appendChild(btn);
      return btn;
    });

    const firstPanel = panels[0];
    if (firstPanel) firstPanel.before(nav);

    panels.forEach((panel, i) => {
      panel.toggleAttribute('inert', i !== 0);
    });

    this.setAttribute('data-initialized', '');
    this.#setupEventListeners();
  }

  #setupEventListeners() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const opts = { signal: this.#abort.signal };

    for (const [i, tab] of this.#tabs.entries()) {
      tab.addEventListener('click', (e) => this.#handleTabClick(e, i), opts);
    }

    this.addEventListener('keydown', (e) => this.#handleKeydown(e), opts);
  }

  /** @param {MouseEvent} e @param {number} index */
  #handleTabClick(e, index) {
    e.preventDefault();
    this.#activate(index);
  }

  /** @param {KeyboardEvent} e */
  #handleKeydown(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.getAttribute('role') !== 'tab') return;

    const tabs = this.#tabs;
    if (!tabs.length) return;

    const i = tabs.indexOf(target);
    /** @type {Record<string, number>} */
    const navMap = {
      ArrowLeft: -1,
      ArrowRight: 1,
      Home: -i,
      End: tabs.length - 1 - i,
    };

    const offset = navMap[e.key];
    if (offset !== undefined) {
      e.preventDefault();
      const nextIndex = (i + offset + tabs.length) % tabs.length;
      tabs[nextIndex]?.focus();
    }
  }

  /** @param {number} index */
  #activate(index) {
    const tabs = this.#tabs;
    if (!tabs.length || index === this.#active || index < 0 || index >= tabs.length) return;

    this.#active = index;
    this.#updateActiveTab();
  }

  #updateActiveTab() {
    const tabs = this.#tabs;
    const { panels } = this.refs;

    for (const [i, tab] of tabs.entries()) {
      const isActive = i === this.#active;
      tab.setAttribute('aria-selected', String(isActive));
      tab.style.fontWeight = isActive ? '600' : '400';
      tab.style.color = isActive
        ? this.#activeColor || ''
        : this.#inactiveColor || '';
    }

    for (const [i, panel] of panels?.entries() ?? []) {
      const isActive = i === this.#active;
      panel.toggleAttribute('inert', !isActive);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abort?.abort();
  }
}

customElements.define('collection-tabs-component', CollectionTabsComponent);
