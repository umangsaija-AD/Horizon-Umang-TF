/**
 * CYO Board Preview — standalone ES module.
 *
 * Listens for `cyo:slots-update` on `document` and updates the board preview
 * cells inside `[data-cyo-board-preview]`. Each cell has `[data-cyo-slot="N"]`
 * with a hidden `[data-cyo-slot-image]` <img> that is revealed when a selection
 * fills that slot.
 *
 * No dependency on @theme/component — this is a plain document-level listener.
 */

document.addEventListener('cyo:slots-update', (event) => {
  const { slots } = event.detail;
  if (!slots) return;

  const boardEl = document.querySelector('[data-cyo-board-preview]');
  if (!boardEl) return;

  for (const slot of slots) {
    const cellEl = boardEl.querySelector(`[data-cyo-slot="${slot.index}"]`);
    if (!cellEl) continue;

    const imgEl = cellEl.querySelector('[data-cyo-slot-image]');
    if (!imgEl) continue;

    if (slot.imageUrl) {
      imgEl.src = slot.imageUrl;
      imgEl.alt = slot.productTitle || '';
      cellEl.dataset.filled = 'true';
    } else {
      imgEl.removeAttribute('src');
      imgEl.alt = '';
      cellEl.dataset.filled = 'false';
    }
  }

  // Show/hide the clear button
  const clearBtn = boardEl.querySelector('[data-cyo-clear]');
  if (clearBtn) {
    const hasSelections = slots.some((s) => s.imageUrl != null);
    clearBtn.style.display = hasSelections ? '' : 'none';
  }
});
