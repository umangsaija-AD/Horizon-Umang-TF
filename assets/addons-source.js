/**
 * Shared data layer for product add-ons and upgrades.
 *
 * Pure utility module — no DOM manipulation, no custom element.
 * Normalizes variant-level metafield JSON into ordered groups,
 * fetches live product data from the Storefront API, and resolves
 * groups with hydrated product objects.
 *
 * Exports: buildAddonGroups, collectRefs, fetchAddonProducts, resolveGroups
 */

/** @type {Map<string, object>} Module-level cache keyed by Storefront GID */
const productCache = new Map();

const BATCH_SIZE = 100;

const PRODUCT_FRAGMENT = `
  ... on Product {
    id
    title
    handle
    availableForSale
    featuredImage { url altText }
    variants(first: 100) {
      nodes {
        id
        title
        price { amount currencyCode }
        availableForSale
      }
    }
  }
`;

/**
 * Normalize raw metafield arrays into ordered addon groups.
 *
 * @param {Array} [upgrades] - Raw upgrades metafield array.
 *   Each entry: { shopify_upgrade: { id: "gid://..." }, price: "..." }
 * @param {Array} [addons] - Raw addons metafield array.
 *   Each entry: { addon: "Group Name", selection: "1"|"2", products: [{ shopify_addon: { id: "gid://..." }, price: "..." }] }
 * @returns {Array<{ type: string, name: string, single: boolean, products: Array<{ gid: string, price: string }> }>}
 */
export function buildAddonGroups(upgrades, addons) {
  const groups = [];

  // Upgrades group (first)
  if (Array.isArray(upgrades) && upgrades.length > 0) {
    const seen = new Set();
    const products = [];
    for (const entry of upgrades) {
      const gid = entry?.shopify_upgrade?.id;
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      products.push({ gid, price: entry.price ?? '' });
    }
    if (products.length > 0) {
      groups.push({
        type: 'upgrade',
        name: 'Upgrades',
        single: false,
        products,
      });
    }
  }

  // Addon groups (in source order)
  if (Array.isArray(addons)) {
    for (const group of addons) {
      if (!group || !Array.isArray(group.products)) continue;
      const seen = new Set();
      const products = [];
      for (const entry of group.products) {
        const gid = entry?.shopify_addon?.id;
        if (!gid || seen.has(gid)) continue;
        seen.add(gid);
        products.push({ gid, price: entry.price ?? '' });
      }
      if (products.length > 0) {
        groups.push({
          type: 'addon',
          name: group.addon ?? '',
          single: group.selection === '2',
          products,
        });
      }
    }
  }

  return groups;
}

/**
 * Collect all unique Storefront GIDs from an array of groups.
 *
 * @param {Array<{ products: Array<{ gid: string }> }>} groups
 * @returns {string[]} Deduped array of GID strings.
 */
export function collectRefs(groups) {
  const seen = new Set();
  for (const group of groups) {
    for (const product of group.products) {
      if (product.gid) seen.add(product.gid);
    }
  }
  return [...seen];
}

/**
 * Fetch live product data from the Storefront API.
 *
 * Batches requests (~100 IDs per query), caches results in a
 * module-level Map, and drops unavailable products.
 *
 * @param {string[]} refs - Array of Shopify product GIDs.
 * @param {{ token: string }} options - Storefront API access token.
 * @returns {Promise<Map<string, object>>} Map of GID → hydrated product.
 */
export async function fetchAddonProducts(refs, { token } = {}) {
  if (!token || !refs || refs.length === 0) {
    return new Map();
  }

  // Filter to only uncached refs
  const uncached = refs.filter((gid) => !productCache.has(gid));

  if (uncached.length > 0) {
    // Chunk into batches
    const batches = [];
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      batches.push(uncached.slice(i, i + BATCH_SIZE));
    }

    const endpoint = `${window.location.origin}/api/2025-01/graphql.json`;

    await Promise.all(
      batches.map(async (batch) => {
        const query = `
          query addonProducts($ids: [ID!]!) {
            nodes(ids: $ids) {
              ${PRODUCT_FRAGMENT}
            }
          }
        `;

        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Storefront-Access-Token': token,
            },
            body: JSON.stringify({ query, variables: { ids: batch } }),
          });

          if (!response.ok) {
            console.warn(`[addons-source] Storefront API ${response.status}`);
            return;
          }

          const json = await response.json();
          const nodes = json?.data?.nodes;

          if (!Array.isArray(nodes)) return;

          for (const node of nodes) {
            if (!node || node.availableForSale === false) continue;

            const product = {
              id: node.id,
              title: node.title,
              handle: node.handle,
              url: `/products/${node.handle}`,
              availableForSale: node.availableForSale,
              featuredImage: node.featuredImage
                ? { url: node.featuredImage.url, altText: node.featuredImage.altText }
                : null,
              variants: (node.variants?.nodes ?? []).map((v) => ({
                id: v.id,
                title: v.title,
                price: Math.round(parseFloat(v.price.amount) * 100),
                currencyCode: v.price.currencyCode,
                availableForSale: v.availableForSale,
              })),
            };

            productCache.set(node.id, product);
          }
        } catch (err) {
          console.warn('[addons-source] Fetch failed:', err);
        }
      })
    );
  }

  // Build result from cache for all requested refs
  const result = new Map();
  for (const gid of refs) {
    const cached = productCache.get(gid);
    if (cached) result.set(gid, cached);
  }

  return result;
}

/**
 * Replace GID references in groups with live product objects.
 *
 * Filters out products not found in the Map and drops groups
 * that end up with zero resolved products.
 *
 * @param {Array<{ type: string, name: string, single: boolean, products: Array<{ gid: string }> }>} groups
 * @param {Map<string, object>} products - Map from fetchAddonProducts.
 * @returns {Array} Filtered groups with hydrated product objects.
 */
export function resolveGroups(groups, products) {
  const resolved = [];

  for (const group of groups) {
    const hydrated = [];
    for (const entry of group.products) {
      const product = products.get(entry.gid);
      if (product) {
        hydrated.push({ ...product, metafieldPrice: entry.price });
      }
    }
    if (hydrated.length > 0) {
      resolved.push({
        type: group.type,
        name: group.name,
        single: group.single,
        products: hydrated,
      });
    }
  }

  return resolved;
}
