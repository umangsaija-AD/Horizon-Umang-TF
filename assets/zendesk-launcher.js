/** Whether the launcher should currently be hidden. */
/** @type {Set<string>} */
const hideSources = new Set();

/** Original inline `display` values for elements we hide, restored on close. */
/** @type {Map<HTMLElement, string>} */
const hiddenElements = new Map();

/** @type {MutationObserver | null} */
let launcherObserver = null;

/** @type {number | null} */
let launcherHiddenRaf = null;

function cancelScheduledApplyLauncherHidden() {
  if (launcherHiddenRaf === null) return;
  cancelAnimationFrame(launcherHiddenRaf);
  launcherHiddenRaf = null;
}

function scheduleApplyLauncherHidden() {
  if (launcherHiddenRaf !== null) return;

  launcherHiddenRaf = requestAnimationFrame(() => {
    launcherHiddenRaf = null;
    applyLauncherHidden();
  });
}

/** @returns {((...args: unknown[]) => void) | undefined} */
function getZendeskApi() {
  if (!('zE' in window)) return undefined;

  const api = Reflect.get(window, 'zE');
  return typeof api === 'function'
    ? /** @type {(...args: unknown[]) => void} */ (api)
    : undefined;
}

function hideZendeskWidgetViaApi() {
  const zE = getZendeskApi();
  if (!zE) return;

  try {
    zE('messenger', 'hide');
  } catch {
    // Ignore if the installed widget does not expose messenger APIs.
  }
}

function showZendeskWidgetViaApi() {
  const zE = getZendeskApi();
  if (!zE) return;

  try {
    zE('messenger', 'show');
  } catch {
    // Ignore if the installed widget does not expose messenger APIs.
  }
}

/**
 * The Zendesk widget launcher (injected via iframe container `#launcher`).
 * @returns {HTMLElement | null}
 */
function getZendeskLauncher() {
  const launcher = document.getElementById('launcher');
  return launcher instanceof HTMLElement ? launcher : null;
}

/**
 * Walk parent divs from the launcher up to (but not including) `body`.
 * @param {HTMLElement} launcher
 * @returns {HTMLDivElement[]}
 */
function getParentDivsUntilBody(launcher) {
  /** @type {HTMLDivElement[]} */
  const parents = [];
  let current = launcher.parentElement;

  while (current && current !== document.body) {
    if (current instanceof HTMLDivElement) {
      parents.push(current);
    }
    current = current.parentElement;
  }

  return parents;
}

/**
 * Hide a parent when its inline style sets `visibility: visible`.
 * @param {HTMLDivElement} element
 */
function hideParentIfVisibilityVisible(element) {
  if (element.style.getPropertyValue('visibility') !== 'visible') return;

  if (!hiddenElements.has(element)) {
    hiddenElements.set(element, element.style.getPropertyValue('display'));
  }

  if (element.style.getPropertyValue('display') === 'none') return;

  element.style.setProperty('display', 'none', 'important');
}

/** Hide launcher ancestors that Zendesk exposes via inline `visibility: visible`. */
function applyLauncherHidden() {
  if (hideSources.size === 0) return;

  hideZendeskWidgetViaApi();

  const launcher = getZendeskLauncher();
  if (!launcher) return;

  for (const parent of getParentDivsUntilBody(launcher)) {
    hideParentIfVisibilityVisible(parent);
  }
}

/** Re-apply when Zendesk mutates styles or injects the launcher after open. */
function startLauncherObserver() {
  launcherObserver?.disconnect();
  cancelScheduledApplyLauncherHidden();

  launcherObserver = new MutationObserver(() => scheduleApplyLauncherHidden());
  launcherObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
    subtree: true,
  });
}

/**
 * Hide the Zendesk launcher while an overlay is open.
 *
 * Zendesk wraps the launcher in parent divs with inline `visibility: visible`.
 * Walk that chain and set `display: none` on matching parents instead of
 * fighting Zendesk's z-index. Multiple overlays can suppress the launcher; each
 * must pass the same `source` to `restoreZendeskLauncher`.
 *
 * @param {string} [source]
 */
export function hideZendeskLauncher(source = 'overlay') {
  const wasHidden = hideSources.size > 0;
  hideSources.add(source);
  applyLauncherHidden();
  if (!wasHidden) {
    hideZendeskWidgetViaApi();
    startLauncherObserver();
  }
}

/**
 * Restore hidden parent divs once an overlay closes.
 * @param {string} [source]
 */
export function restoreZendeskLauncher(source = 'overlay') {
  if (!hideSources.delete(source)) return;

  if (hideSources.size > 0) {
    applyLauncherHidden();
    return;
  }

  launcherObserver?.disconnect();
  launcherObserver = null;
  cancelScheduledApplyLauncherHidden();

  showZendeskWidgetViaApi();

  for (const [element, originalDisplay] of hiddenElements) {
    if (originalDisplay) {
      element.style.setProperty('display', originalDisplay);
    } else {
      element.style.removeProperty('display');
    }
  }

  hiddenElements.clear();
}
