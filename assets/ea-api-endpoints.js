/**
 * Centralised Celigo App Proxy endpoint paths.
 *
 * Every path is relative to the shop origin and routed through Shopify's
 * App Proxy (`/apps/celigo/...`). The proxy attaches authentication
 * server-side — browser code must NEVER send a bearer token.
 *
 * @readonly
 */
export const AVAILABILITY_API = Object.freeze({
  /** Product availability by arrangement / variant / date / ZIP. */
  product: '/apps/celigo/product-availability',

  /** Store locations for a given ZIP / country. */
  storeLocation: '/apps/celigo/store-location',

  /** Arrangement data (sizes, images, metadata). */
  arrangements: '/apps/celigo/arrangements',

  /** Cart-level validation / pricing. */
  cart: '/apps/celigo/cart',

  /** Printable product catalogue. */
  printables: '/apps/celigo/printables',

  /** Add-on products for a given arrangement. */
  addons: '/apps/celigo/addons',

  /** Upgrade products for a given arrangement. */
  upgrades: '/apps/celigo/upgrades',

  /** Carrier-calculated shipping rates. */
  carrierRates: '/apps/celigo/carrier-rates',
});
