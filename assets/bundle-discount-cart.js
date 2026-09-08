/**
 * EA bundle discount — cart helpers for Horizon / theme assets.
 *
 * Adds cart lines tagged with `_item_type: "bundle_line_item"` so the discount
 * function can qualify them (still requires eligible products + >= 2 lines).
 *
 * Load in theme (e.g. theme.liquid before </body>):
 *   {{ 'bundle-discount-cart.js' | asset_url | script_tag }}
 *
 * Browser console:
 *   await EABundleDiscount.addBundleToCart([401234567890, 401234567891])
 *   await EABundleDiscount.addBundleLineItem(401234567890, 2)
 */
(function () {
  const PROPERTY_KEY = '_item_type';
  const BUNDLE_ITEM_TYPE = 'bundle_line_item';

  /** @returns {Record<string, string>} */
  function bundleLineProperties() {
    return {
      [PROPERTY_KEY]: BUNDLE_ITEM_TYPE,
    };
  }

  /**
   * @param {number|string|Array<number|string>} variantIds
   * @param {number} [quantity=1] per variant
   * @returns {Array<{ id: number, quantity: number, properties: Record<string, string> }>}
   */
  function toBundleCartItems(variantIds, quantity = 1) {
    const ids = Array.isArray(variantIds) ? variantIds : [variantIds];
    const qty = Math.max(1, Number(quantity) || 1);

    return ids.map((id) => ({
      id: Number(id),
      quantity: qty,
      properties: bundleLineProperties(),
    }));
  }

  /**
   * POST JSON to Cart AJAX API.
   * @param {string} path e.g. "cart/add.js"
   * @param {object} body
   */
  async function cartFetch(path, body) {
    const root =
      (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) ||
      '/';

    const response = await fetch(`${root}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let data;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const message =
        (data && typeof data === 'object' && data.description) ||
        (typeof data === 'string' ? data : response.statusText);
      throw new Error(message || 'Cart request failed');
    }

    return data;
  }

  /**
   * Add one bundle line item.
   * @param {number|string} variantId
   * @param {number} [quantity=1]
   * @returns {Promise<object>}
   */
  async function addBundleLineItem(variantId, quantity = 1) {
    return cartFetch('cart/add.js', {
      items: toBundleCartItems(variantId, quantity),
    });
  }

  /**
   * Add multiple bundle line items in one request (typical bundle builder).
   * @param {Array<number|string>} variantIds
   * @param {number} [quantity=1] quantity applied to each variant
   * @returns {Promise<object>}
   *
   * @example
   * await EABundleDiscount.addBundleToCart([401234567890, 401234567891])
   */
  async function addBundleToCart(variantIds, quantity = 1) {
    if (!Array.isArray(variantIds) || variantIds.length === 0) {
      throw new Error('addBundleToCart expects a non-empty array of variant IDs');
    }

    return cartFetch('cart/add.js', {
      items: toBundleCartItems(variantIds, quantity),
    });
  }

  window.EABundleDiscount = {
    PROPERTY_KEY,
    BUNDLE_ITEM_TYPE,
    addBundleLineItem,
    addBundleToCart,
    toBundleCartItems,
  };
})();
