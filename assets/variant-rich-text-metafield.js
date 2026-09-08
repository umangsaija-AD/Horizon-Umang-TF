import { Component } from '@theme/component';
import { ThemeEvents, VariantUpdateEvent } from '@theme/events';
import { morph } from '@theme/morph';

/**
 * A custom element that displays selected variant rich text metafield content.
 *
 * @extends {Component}
 */
class VariantRichTextMetafield extends Component {
  /** @type {Element | null} */
  #closestSection = null;

  connectedCallback() {
    super.connectedCallback();
    this.#closestSection = this.closest('.shopify-section, dialog');
    this.#closestSection?.addEventListener(ThemeEvents.variantUpdate, this.updateContent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#closestSection?.removeEventListener(ThemeEvents.variantUpdate, this.updateContent);
    this.#closestSection = null;
  }

  /**
   * @param {VariantUpdateEvent} event
   */
  updateContent = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    const newContent = event.detail.data.html.querySelector(
      `variant-rich-text-metafield[data-block-id="${this.dataset.blockId}"]`
    );

    if (!newContent) return;

    morph(this, newContent, { childrenOnly: true });
    this.hidden = newContent.hasAttribute('hidden');
  };
}

if (!customElements.get('variant-rich-text-metafield')) {
  customElements.define('variant-rich-text-metafield', VariantRichTextMetafield);
}
