/**
 * Shared Add to Cart button gating registry.
 *
 * Multiple independent systems (availability, CYO) can block the same ATC
 * button for different reasons.  Each reason is tracked in a per-element Set
 * inside a WeakMap so entries are garbage-collected when the DOM element is
 * removed (e.g. after a variant:update morph replaces the button).
 *
 * CRITICAL guard: when block=false, the button is re-enabled ONLY when
 *   1. Set.delete(reason) returns true  (we owned this reason on THIS element)
 *   2. The Set is now empty              (no other blockers remain)
 *
 * This prevents re-enabling a natively disabled (sold-out) button after a DOM
 * morph creates a fresh element whose WeakMap entry is empty.
 */

/** @type {WeakMap<HTMLButtonElement, Set<string>>} */
const gates = new WeakMap();

/**
 * Reason constants.  Each value doubles as the data-attribute name set on the
 * button so CSS / other JS can detect the block source.
 */
export const ATC_BLOCK = Object.freeze({
  availability: 'data-pdp-availability-blocked',
  cyo: 'data-cyo-incomplete',
});

/**
 * Add or remove a blocking reason on an ATC button.
 *
 * @param {HTMLButtonElement} btn    The button element to gate.
 * @param {string}           reason One of the ATC_BLOCK values (used as both
 *                                  the Set key and the data-attribute name).
 * @param {boolean}          block  true = add the block, false = release it.
 */
export function setAtcBlock(btn, reason, block) {
  if (!btn) return;

  if (block) {
    let reasons = gates.get(btn);
    if (!reasons) {
      reasons = new Set();
      gates.set(btn, reasons);
    }
    reasons.add(reason);
    btn.setAttribute(reason, '');
    btn.disabled = true;
    return;
  }

  // --- release path ---
  const reasons = gates.get(btn);
  if (!reasons) return; // fresh element we never gated — leave it alone

  const had = reasons.delete(reason);
  if (!had) return; // we never owned this reason on this element

  btn.removeAttribute(reason);

  if (reasons.size === 0) {
    btn.disabled = false;
  }
}
