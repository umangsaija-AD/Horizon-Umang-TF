import { Component } from '@theme/component';
import {
  onDocumentLoaded,
  changeMetaThemeColor,
  setHeaderMenuStyle,
} from '@theme/utilities';
import { hideZendeskLauncher, restoreZendeskLauncher } from '@theme/zendesk-launcher';

const ZENDESK_HIDE_SOURCE = 'mobile-nav';

const MENU_TYPES = {
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
};

class HeaderComponent extends Component {
  currentOpenMenuType = null;

  /** @type {number} */
  #lockedScrollY = 0;

  /**
   * Locks page scroll while nav overlay / search drawer is active.
   * Uses `html[scroll-lock]` (see base.css) plus `position: fixed` on `body` with preserved
   * scroll offset (same workaround pattern as `dialog.js`).
   */
  #lockScroll() {
    if (document.documentElement.hasAttribute('scroll-lock')) return;

    this.#lockedScrollY = window.scrollY;
    document.documentElement.setAttribute('scroll-lock', '');

    requestAnimationFrame(() => {
      document.body.style.width = '100%';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${this.#lockedScrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
    });
  }

  /** Restores scroll after {@link #lockScroll}. */
  #unlockScroll() {
    if (!document.documentElement.hasAttribute('scroll-lock')) return;

    document.documentElement.removeAttribute('scroll-lock');
    document.body.style.width = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    window.scrollTo({ top: this.#lockedScrollY, behavior: 'instant' });
    this.#lockedScrollY = 0;
  }

  connectedCallback() {
    super.connectedCallback();

    const navTriggers = this.querySelectorAll('.js-nav-trigger');
    const searchDrawerTrigger = this.querySelector('.js-search-trigger');
    const backdrop = this.querySelector('.js-nav-backdrop');

    const mobileNavTrigger = this.querySelector('.js-mobile-nav-trigger');
    const mobileMenuItems = this.querySelectorAll('.js-mobile-menu-item');
    const mobileSubmenuBackBtns = this.querySelectorAll(
      '.js-mobile-submenu-back-btn',
    );

    navTriggers.forEach((navTrigger) => {
      navTrigger.addEventListener('mouseenter', (e) =>
        this.handleNavTriggerMouseEnter(e),
      );
    });

    mobileNavTrigger?.addEventListener('click', (e) => {
      if (mobileNavTrigger.classList.contains('--is-open')) {
        this.closeCurrentNav();
      } else {
        this.openMobileNav(e);
      }
    });

    mobileMenuItems.forEach((mobileMenuItem) => {
      mobileMenuItem.addEventListener('click', (e) =>
        this.openMobileSubmenu(e),
      );
    });

    backdrop?.addEventListener('mouseenter', () => this.closeCurrentNav());

    backdrop?.addEventListener('click', () => {
      this.closeSearchUI();
      this.closeCurrentNav();
      this.closeBackdrop();
    });

    mobileSubmenuBackBtns.forEach((mobileSubmenuBackBtn) => {
      mobileSubmenuBackBtn.addEventListener('click', (e) =>
        this.mobileSubmenuBack(e),
      );
    });

    searchDrawerTrigger?.addEventListener('click', (e) =>
      this.toggleSearchDrawer(e),
    );
  }

  /**
   * Closes the search drawer UI only (classes). Does not change backdrop;
   * callers coordinate with openBackdrop / closeBackdrop.
   */
  closeSearchUI() {
    const searchDrawer = this.querySelector('.js-search-drawer');
    const searchDrawerTrigger = this.querySelector('.js-search-trigger');
    searchDrawer?.classList.remove('--is-open', 'tw---is-open');
    searchDrawerTrigger?.classList.remove('--is-open');
  }

  toggleSearchDrawer(event) {
    const searchDrawerTrigger = event.currentTarget;
    const searchDrawer = this.querySelector('.js-search-drawer');
    if (!searchDrawer) return;

    const willOpen = !searchDrawer.classList.contains('--is-open');

    if (willOpen) {
      this.closeCurrentNav();
    }

    searchDrawer.classList.toggle('--is-open');
    searchDrawer.classList.toggle('tw---is-open');

    searchDrawerTrigger.classList.toggle('--is-open');

    if (searchDrawer.classList.contains('--is-open')) {
      this.openBackdrop();
    } else {
      this.closeBackdrop();
    }
  }

  /**
   * Closes the header search drawer (used by React predictive search close control).
   * @param {Event} [event]
   */
  closeSearchDrawer(event) {
    event?.preventDefault();
    this.closeSearchUI();
    this.closeBackdrop();
  }

  disconnectedCallback() {
    this.#unlockScroll();
    super.disconnectedCallback();
  }

  openMobileNav(event) {
    const mobileNav = this.querySelector('.js-mobile-nav');
    if (!mobileNav) return;

    this.closeSearchUI();

    event.currentTarget.classList.add('--is-open');
    mobileNav.classList.add('--is-open', 'tw---is-open');

    const topSpacing = Math.min(0, window.scrollY - 33) + 33;
    mobileNav.style.setProperty('--height-exclude-top-bar', `${topSpacing}px`);
    this.currentOpenMenuType = MENU_TYPES.MOBILE;
    hideZendeskLauncher(ZENDESK_HIDE_SOURCE);
    this.openBackdrop();
  }

  openMobileSubmenu(event) {
    const submenu = event.currentTarget;
    if (!submenu) return;

    const { hasSubmenu, triggerId } = submenu.dataset;
    const mobileSubmenu = this.querySelector(`#mobile-submenu-${triggerId}`);
    if (hasSubmenu === 'true') {
      mobileSubmenu.classList.add('--is-open', 'tw---is-open');
      // mobileSubmenu?.scrollIntoView({ behavior: 'instant' });
    } else {
      mobileSubmenu.classList.remove('--is-open', 'tw---is-open');
    }
  }

  mobileSubmenuBack(event) {
    const submenu = event.target;
    if (!submenu) return;

    const mobileSubNav = submenu.closest('.js-mobile-submenu');
    mobileSubNav.classList.remove('--is-open', 'tw---is-open');
  }

  handleNavTriggerMouseEnter(event) {
    const details = event.target;
    if (!details) return;

    const { hasSubmenu } = details.dataset;
    if (hasSubmenu === 'true') {
      this.closeSearchUI();
      details.open = true;
      this.currentOpenMenuType = MENU_TYPES.DESKTOP;
      this.openBackdrop();
    } else {
      const openNav = this.querySelector('.js-nav-trigger[open]');
      this.closeSearchUI();
      if (openNav) openNav.open = false;
      this.closeBackdrop();
    }
  }

  closeCurrentNav() {
    const desktopNav = this.querySelector('.js-nav-trigger[open]');
    const mobileNav = this.querySelector('.js-mobile-nav.--is-open');

    const openNav =
      this.currentOpenMenuType === MENU_TYPES.DESKTOP ? desktopNav : mobileNav;

    if (!openNav) return;

    if (this.currentOpenMenuType === MENU_TYPES.DESKTOP) {
      desktopNav.open = false;
    } else {
      const mobileNavTrigger = this.querySelector('.js-mobile-nav-trigger');

      mobileNav.classList.remove('--is-open', 'tw---is-open');
      mobileNavTrigger.classList.remove('--is-open');
      restoreZendeskLauncher(ZENDESK_HIDE_SOURCE);
      const mobileSubmenusBackBtn = document.querySelector(
        '.js-mobile-submenu.--is-open > .js-mobile-submenu-back-btn',
      );
      this.mobileSubmenuBack({ target: mobileSubmenusBackBtn });
    }

    this.closeBackdrop();
  }

  openBackdrop() {
    const backdrop = this.querySelector('.js-nav-backdrop');
    if (!backdrop) return;

    const wasOpen = backdrop.classList.contains('open');
    backdrop.classList.add('open');
    if (!wasOpen) this.#lockScroll();
  }

  closeBackdrop() {
    const backdrop = this.querySelector('.js-nav-backdrop');
    if (!backdrop) return;

    const wasOpen = backdrop.classList.contains('open');
    backdrop.classList.remove('open');
    this.currentOpenMenuType = null;
    if (wasOpen) this.#unlockScroll();
  }
}

if (!customElements.get('header-component')) {
  customElements.define('header-component', HeaderComponent);
}
