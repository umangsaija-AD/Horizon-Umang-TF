import { Component } from '@theme/component';

/**
 * @typedef {Object} TextReadMoreRefs
 * @property {HTMLElement} content
 * @property {HTMLButtonElement} toggle
 */

class TextReadMore extends Component {
  requiredRefs = ['content', 'toggle'];

  #originalHTML = '';

  #isUpdating = false;

  #isAnimating = false;

  #collapsedTextLength = 200;

  connectedCallback() {
    super.connectedCallback();

    if (this.dataset.enabled !== 'true') {
      this.refs.toggle.hidden = true;
      return;
    }

    this.#collapsedTextLength = this.#getCollapsedTextLength();
    this.#originalHTML = this.refs.content.innerHTML;
    requestAnimationFrame(this.#updateToggleVisibility);
  }

  #getCollapsedTextLength = () => {
    const collapsedTextLength = Number(this.dataset.collapsedTextLength);

    if (Number.isFinite(collapsedTextLength) && collapsedTextLength > 0) {
      return collapsedTextLength;
    }

    return this.#collapsedTextLength;
  };

  #updateToggleVisibility = () => {
    if (this.#isUpdating || this.#isAnimating) return;

    const { content, toggle } = /** @type {TextReadMoreRefs} */ (this.refs);

    this.#isUpdating = true;

    const expanded = this.dataset.expanded === 'true';
    const shouldCollapse = this.#shouldCollapseContent();

    toggle.hidden = !shouldCollapse;

    if (expanded || !shouldCollapse) {
      content.innerHTML = this.#originalHTML;
    } else {
      this.#applyCollapsedContent();
    }

    this.#isUpdating = false;
  };

  #shouldCollapseContent = () => {
    const { content } = /** @type {TextReadMoreRefs} */ (this.refs);

    content.innerHTML = this.#originalHTML;

    return (
      (content.textContent || '').trim().length > this.#collapsedTextLength
    );
  };

  #applyCollapsedContent = () => {
    const { content } = /** @type {TextReadMoreRefs} */ (this.refs);

    content.innerHTML = this.#originalHTML;
    this.#truncateContent(this.#collapsedTextLength);
  };

  /**
   * @param {number} maxLength
   */
  #truncateContent = (maxLength) => {
    const { content } = /** @type {TextReadMoreRefs} */ (this.refs);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();
    let remainingLength = maxLength;

    while (currentNode) {
      const text = currentNode.textContent || '';

      if (text.length > remainingLength) {
        const truncatedText = this.#truncateTextAtWord(text, remainingLength);
        currentNode.textContent = `${truncatedText}...`;

        const range = document.createRange();
        range.setStartAfter(currentNode);
        range.setEndAfter(content.lastChild || currentNode);
        range.deleteContents();
        range.detach();

        return;
      }

      remainingLength -= text.length;
      currentNode = walker.nextNode();
    }
  };

  /**
   * @param {string} text
   * @param {number} maxLength
   */
  #truncateTextAtWord = (text, maxLength) => {
    const slicedText = text.slice(0, maxLength).trimEnd();
    const lastSpaceIndex = slicedText.search(/\s+\S*$/);

    if (lastSpaceIndex > 0) {
      return slicedText.slice(0, lastSpaceIndex).trimEnd();
    }

    return slicedText;
  };

  /**
   * @param {number} previousHeight
   */
  #animateContentHeight = (previousHeight) => {
    const { content } = /** @type {TextReadMoreRefs} */ (this.refs);
    const nextHeight = content.offsetHeight;
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    if (prefersReducedMotion || previousHeight === nextHeight) return;

    this.#isAnimating = true;
    content.style.height = `${previousHeight}px`;
    content.style.overflow = 'hidden';
    content.style.transition = 'none';

    requestAnimationFrame(() => {
      content.style.transition =
        'height var(--animation-speed) var(--animation-easing)';
      content.style.height = `${nextHeight}px`;
    });

    const handleTransitionEnd = (event) => {
      if (event.target !== content || event.propertyName !== 'height') return;

      content.removeEventListener('transitionend', handleTransitionEnd);
      content.style.height = '';
      content.style.overflow = '';
      content.style.transition = '';
      this.#isAnimating = false;
    };

    content.addEventListener('transitionend', handleTransitionEnd);
  };

  /**
   * @param {Event} event
   */
  toggle = (event) => {
    event.preventDefault();

    if (this.dataset.enabled !== 'true' || this.#isAnimating) return;

    const previousHeight = this.refs.content.offsetHeight;
    const expanded = this.dataset.expanded === 'true';
    this.dataset.expanded = expanded ? 'false' : 'true';
    this.refs.toggle.setAttribute('aria-expanded', String(!expanded));
    this.#updateToggleVisibility();
    this.#animateContentHeight(previousHeight);
  };
}

if (!customElements.get('text-read-more')) {
  customElements.define('text-read-more', TextReadMore);
}
