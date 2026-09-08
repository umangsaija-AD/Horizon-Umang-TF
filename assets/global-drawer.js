import { DialogComponent } from '@theme/dialog';

class GlobalDrawer extends DialogComponent {
  requiredRefs = ['dialog', 'title', 'content', 'close'];

  connectedCallback() {
    super.connectedCallback();
    window.GlobalDrawer = this;
    this.init();
  }

  init() {
    this.initTriggers();
  }

  initTriggers(root = document) {
    const triggers = [
      ...(root instanceof Element &&
      root.matches('[data-global-drawer-trigger]')
        ? [root]
        : []),
      ...root.querySelectorAll('[data-global-drawer-trigger]'),
    ];

    triggers.forEach((trigger) => {
      if (trigger.dataset.globalDrawerReady === 'true') return;

      trigger.dataset.globalDrawerReady = 'true';
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        this.openDrawer({
          content: trigger.dataset.content || '',
          title: trigger.dataset.drawerTitle || '',
          drawerStyle: this.parseStyle(trigger.dataset.drawerStyle || ''),
          titleStyle: this.parseStyle(trigger.dataset.drawerTitleStyle || ''),
          closeStyle: this.parseStyle(trigger.dataset.drawerCloseStyle || ''),
        });
      });
    });
  }

  openDrawer({
    title = '',
    drawerStyle = {},
    titleStyle = {},
    closeStyle = {},
    content = '',
    showBack = false,
  } = {}) {
    if (this.refs.dialog.open || !this.loadDrawer(content)) return;

    this.loadDrawerStyle(drawerStyle);
    this.loadTitle(title, titleStyle);
    this.loadClose(closeStyle);
    this.loadBack(showBack);
    this.showDialog();
  }

  loadBack(show) {
    if (this.refs.back) this.refs.back.hidden = !show;
    this.refs.dialog.classList.toggle('global-drawer__dialog--with-back', Boolean(show));
  }

  closeDrawer() {
    this.closeDialog();
  }

  loadDrawer(content) {
    if (!content) return false;

    /*
     * Content is safely rendered from trusted Shopify/Liquid sources.
     * Sanitize before injection if untrusted/user-generated content is introduced in the future.
     */
    this.refs.content.innerHTML = content;

    return true;
  }

  parseStyle(style) {
    if (!style) return {};

    try {
      return JSON.parse(style);
    } catch {
      return {};
    }
  }

  loadTitle(title, { preset = 'h4', color = '#464646', weight = '600' } = {}) {
    this.refs.title.textContent = title;
    this.refs.title.className = [
      'global-drawer__title',
      preset,
      'custom-font-weight',
    ]
      .filter(Boolean)
      .join(' ');
    this.refs.title.style.setProperty('--color', color);
    this.refs.title.style.setProperty('--font-weight', weight);
  }

  loadDrawerStyle({ width = '358px', desktopWidth = '512px' } = {}) {
    this.refs.dialog.style.setProperty('--drawer-width', width);
    this.refs.dialog.style.setProperty('--drawer-width-desktop', desktopWidth);
  }

  loadClose({ size = '24px', desktopSize = size } = {}) {
    this.refs.close.style.setProperty('--drawer-close-icon-size', size);
    this.refs.close.style.setProperty(
      '--drawer-close-icon-size-desktop',
      desktopSize,
    );
  }
}

if (!customElements.get('global-drawer')) {
  customElements.define('global-drawer', GlobalDrawer);
}

function getGlobalDrawer() {
  const drawer = document.querySelector('global-drawer');

  if (drawer instanceof GlobalDrawer) {
    window.GlobalDrawer = drawer;
    return drawer;
  }

  return null;
}

getGlobalDrawer()?.initTriggers();

document.addEventListener('shopify:section:load', (event) => {
  getGlobalDrawer()?.initTriggers(event.target);
});
