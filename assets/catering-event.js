// @ts-nocheck
// Theme JS runs without a tsconfig; type annotations would require build tooling
// not available in this Shopify context.
/**
 * Catering Event Drawer — standalone ES module.
 * Manages the 5-step catering event flow:
 *   Step 1: Zip + date + guest count
 *   Step 2: Pickup/Delivery (revealed when zip + date are filled)
 *   Step 3: Store selection (revealed when "Select Store" is clicked)
 *   Step 4: Time selection (revealed when a store is selected)
 *   Step 5: Instructions — required textarea; pickup adds a curbside toggle that,
 *           when on, reveals required Vehicle model + Vehicle color fields
 *           (revealed when a time is selected)
 *
 * "Start Adding Products" is enabled only once every step is complete.
 * Dispatches `catering:event:saved` on document when complete.
 */

// ── Static store data ─────────────────────────────────────────────────────────
// TODO: Replace with a real store-locator API call inside fetchStoresByZip.
// This is placeholder data for development/staging only.

const STORE_DATA = {
  '89101': {
    pickup: [
      {
        name: 'Edible Arrangements - 300 S 4th St',
        address: '300 S 4th St',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89101',
        phone: '(702) 555-0101',
        distance: '0.5 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–7:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–5:00pm' },
        features: ['Curbside', 'Smoothies', 'Catering'],
      },
      {
        name: 'Edible Arrangements - 512 Fremont St',
        address: '512 Fremont St',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89101',
        phone: '(702) 555-0102',
        distance: '1.2 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '9:00am–6:00pm', weekendRange: 'Sun', weekendTimes: '10:00am–4:00pm' },
        features: ['Curbside', 'Kosher'],
      },
      {
        name: 'Edible Arrangements - 900 E Charleston Blvd',
        address: '900 E Charleston Blvd',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89101',
        phone: '(702) 555-0103',
        distance: '2.4 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–6:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–3:00pm' },
        features: ['Curbside', 'Smoothies'],
      },
    ],
    delivery: [
      {
        name: 'Edible Arrangements - 300 S 4th St',
        address: '300 S 4th St',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89101',
        phone: '(702) 555-0101',
        distance: '0.5 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–7:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–5:00pm' },
        features: ['Delivery', 'Catering'],
      },
      {
        name: 'Edible Arrangements - 512 Fremont St',
        address: '512 Fremont St',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89101',
        phone: '(702) 555-0102',
        distance: '1.2 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '9:00am–6:00pm', weekendRange: 'Sun', weekendTimes: '10:00am–4:00pm' },
        features: ['Delivery'],
      },
    ],
  },
  '89102': {
    pickup: [
      {
        name: 'Edible Arrangements - 2000 S Las Vegas Blvd',
        address: '2000 S Las Vegas Blvd',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0201',
        distance: '1.1 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–8:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–6:00pm' },
        features: ['Curbside', 'Smoothies', 'Catering', 'Kosher'],
      },
      {
        name: 'Edible Arrangements - 1428 W Sahara Ave',
        address: '1428 W Sahara Ave',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0202',
        distance: '2.3 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '9:00am–7:00pm', weekendRange: 'Sun', weekendTimes: '10:00am–5:00pm' },
        features: ['Curbside', 'Smoothies'],
      },
      {
        name: 'Edible Arrangements - 3200 S Valley View Blvd',
        address: '3200 S Valley View Blvd',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0203',
        distance: '3.7 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–6:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–4:00pm' },
        features: ['Curbside'],
      },
      {
        name: 'Edible Arrangements - 4750 W Flamingo Rd',
        address: '4750 W Flamingo Rd',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0204',
        distance: '5.2 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–7:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–3:00pm' },
        features: ['Curbside', 'Catering'],
      },
    ],
    delivery: [
      {
        name: 'Edible Arrangements - 2000 S Las Vegas Blvd',
        address: '2000 S Las Vegas Blvd',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0201',
        distance: '1.1 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '8:00am–8:00pm', weekendRange: 'Sun', weekendTimes: '9:00am–6:00pm' },
        features: ['Delivery', 'Catering'],
      },
      {
        name: 'Edible Arrangements - 1428 W Sahara Ave',
        address: '1428 W Sahara Ave',
        city: 'Las Vegas',
        state: 'NV',
        zip: '89102',
        phone: '(702) 555-0202',
        distance: '2.3 mi',
        hours: { weekdayRange: 'Mon–Sat', weekdayTimes: '9:00am–7:00pm', weekendRange: 'Sun', weekendTimes: '10:00am–5:00pm' },
        features: ['Delivery'],
      },
    ],
  },
};

// ── Module state ──────────────────────────────────────────────────────────────

// ZIP validation lifecycle: 'idle' | 'loading' | 'valid' | 'invalid'
let zipValidState = 'idle';
let lastValidatedZip = '';
let selectedStoreIndex = -1;
let _lastSavedEvent = null; // Persists event details across drawer open/close cycles

// ZIP_CACHE maps zip → { pickup: StoreList, delivery: StoreList } | null
const ZIP_CACHE = {};

// Cached DOM references — set in init() once the DOM is ready
let _drawer = null;
let _overlay = null;
let _step1 = null;
let _step2 = null;
let _step3 = null;
let _step4 = null;
let _step5 = null;
let _step3Footer = null;
let _storeList = null;
let _drawerLoader = null;

// ── Utilities ─────────────────────────────────────────────────────────────────
// NOTE: escapeHtml is also defined in catering-cart.js. Until these modules
// share a common utility file, keep both copies in sync.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/**
 * Read all Step 1 + Step 2 form values in a single pass.
 * Centralises the repeated querySelector calls that were scattered across
 * saveAndClose, showStep3, selectStoreBtn handler, and validateZip.
 */
function readFormValues() {
  const zip      = document.querySelector('[data-drawer-zip]')?.value?.trim()   || '';
  const date     = document.querySelector('[data-drawer-date]')?.value?.trim()  || '';
  const guests   = document.querySelector('[data-drawer-guests]')?.value?.trim() || '';
  const checked  = document.querySelector('[name="catering_order_type"]:checked');
  const orderType = checked ? checked.value : 'Pickup';
  const time     = document.querySelector('[data-drawer-time]')?.value           || '';
  return { zip, date, guests, orderType, time };
}

function getActiveStores() {
  const { zip, orderType } = readFormValues();
  const cached = ZIP_CACHE[zip];
  return (cached && cached[orderType.toLowerCase()]) || [];
}

// ── ZIP validation state ──────────────────────────────────────────────────────

/**
 * Reset ZIP validation to idle. Centralised so all call sites stay in sync.
 */
function resetZipValidationState() {
  zipValidState = 'idle';
  lastValidatedZip = '';
  clearZipFeedback();
  hideDrawerLoader();
}

// ── Drawer open/close ─────────────────────────────────────────────────────────

function openDrawer() {
  if (!_drawer || !_overlay) return;
  _overlay.classList.remove('tw-hidden');
  requestAnimationFrame(() => _drawer.classList.remove('tw-translate-x-full'));
  document.body.style.overflow = 'hidden';

  if (_lastSavedEvent) {
    prefillFromSaved(_lastSavedEvent);
    revealStep2();
    showStep3(_lastSavedEvent);
  }
  // No saved event: the form was already reset when the drawer last closed, so
  // there's nothing to do — it opens on a clean step 1.
}

function closeDrawer() {
  if (!_drawer || !_overlay) return;
  _drawer.classList.add('tw-translate-x-full');
  setTimeout(() => {
    _overlay.classList.add('tw-hidden');
    // Reset off-screen, after the slide-out completes, so the user never sees the
    // fields clear / steps collapse mid-animation.
    resetDrawerForm();
  }, 300);
  document.body.style.overflow = '';
}

/**
 * Reset the whole drawer back to a clean step 1. Runs on close: the step-1 inputs
 * are cleared and steps 2–5 are hidden if they were left visible. The in-memory
 * _lastSavedEvent is deliberately NOT touched here — it's only set by "Start
 * Adding Products" (saveAndClose) and is what openDrawer prefills from, so a saved
 * event survives closes while an unsaved one was never stored.
 */
function resetDrawerForm() {
  resetStep1Inputs();
  hideAllStepsExceptFirst();
}

// ── Step visibility ───────────────────────────────────────────────────────────

/**
 * Clear the Step 1 inputs (zip, date, guests) and their visual "has-value"
 * states. Part of the full drawer reset performed on close, so the flow always
 * restarts from a clean step 1 rather than a stale half-filled state.
 */
function resetStep1Inputs() {
  const zip    = document.querySelector('[data-drawer-zip]');
  const date   = document.querySelector('[data-drawer-date]');
  const guests = document.querySelector('[data-drawer-guests]');

  if (zip) {
    zip.value = '';
    const zipWrap = zip.closest('.catering-drawer__zip-wrap');
    if (zipWrap) zipWrap.classList.remove('has-value');
  }
  if (date) {
    date.value = '';
    const dateWrap = date.closest('.catering-drawer__date-wrap');
    if (dateWrap) dateWrap.classList.remove('has-value');
    const display = document.querySelector('[data-date-display]');
    if (display) display.textContent = '';
  }
  if (guests) guests.value = '';
}

/**
 * Hide every step except step 1: collapses steps 2–5 and the sticky footer if
 * they're visible, leaving step 1 shown. Also resets the related UI/validation
 * state (ZIP validation, selected store, order type, time). Field values are
 * cleared separately by resetStep1Inputs.
 */
function hideAllStepsExceptFirst() {
  if (_step1) _step1.classList.remove('tw-hidden');
  // Force display:none on every step. The show* functions set inline
  // display:flex, which overrides the tw-hidden class, so the class alone won't
  // re-hide a step that was previously revealed — the inline none must win.
  if (_step2) { _step2.classList.add('tw-hidden'); _step2.style.display = 'none'; _step2.style.maxHeight = '0'; }
  if (_step3) { _step3.classList.add('tw-hidden'); _step3.style.display = 'none'; }
  if (_step4) { _step4.classList.add('tw-hidden'); _step4.style.display = 'none'; }
  hideStep5();
  if (_step3Footer) _step3Footer.classList.add('tw-hidden');

  // Reset all form and validation state when returning to step 1
  resetZipValidationState();
  selectedStoreIndex = -1;

  document.querySelectorAll('[name="catering_order_type"]').forEach((r) => {
    r.checked = r.value === 'Pickup';
  });
  const timeSelect = document.querySelector('[data-drawer-time]');
  if (timeSelect) timeSelect.value = '';
  updateOrderTypeUI('Pickup');
  updateSelectStoreBtn();
}

function revealStep2() {
  if (!_step2) return;
  _step2.classList.remove('tw-hidden');
  _step2.style.display = 'flex';
  requestAnimationFrame(() => { _step2.style.maxHeight = '600px'; });
  // Ensure the "Select Store" CTA is visible whenever step 2 appears. Its initial
  // markup is tw-hidden; the reset un-hides it, but the reset only runs on close —
  // so on the very first open (no prior close) it would otherwise stay hidden.
  updateSelectStoreBtn();
}

function hideStep2() {
  if (!_step2) return;
  _step2.style.maxHeight = '0';
  setTimeout(() => _step2.classList.add('tw-hidden'), 300);
}

function hideStep3() {
  if (_step3) { _step3.classList.add('tw-hidden'); _step3.style.display = 'none'; }
  if (_step3Footer) { _step3Footer.classList.add('tw-hidden'); _step3Footer.style.display = ''; }
  selectedStoreIndex = -1;
  hideStep4();
}

function showStep3(saved) {
  // Hide the "Select Store" button — it's superseded by the visible store list
  const selectWrap = document.querySelector('[data-select-store-wrap]');
  if (selectWrap) selectWrap.classList.add('tw-hidden');

  if (_step3) { _step3.classList.remove('tw-hidden'); _step3.style.display = 'flex'; }
  if (_step3Footer) _step3Footer.classList.remove('tw-hidden');

  populateStep3Summary(saved);
  renderStoreList();

  // Step 4 (time selection) only appears once a store is selected. When reopening
  // a saved event, populateStep3Summary restores the selection, so reveal it here.
  if (selectedStoreIndex >= 0) showStep4();
  else hideStep4();

  // Step 5 (instructions) follows a chosen time — relevant only when reopening a
  // saved event, where prefillFromSaved has already restored the time + step 5 data.
  const hasTime = !!document.querySelector('[data-drawer-time]')?.value;
  if (selectedStoreIndex >= 0 && hasTime) showStep5();

  updateStartAddingBtn();
}

function showStep4() {
  if (_step4) { _step4.classList.remove('tw-hidden'); _step4.style.display = 'flex'; }
}

/**
 * Bring the time-selection step into view and focus it, so the user is clearly
 * prompted to complete the final step. Deferred a frame so the just-revealed
 * step has layout before we scroll; `preventScroll` keeps focus() from fighting
 * the smooth scroll.
 */
function focusTimeStep() {
  if (!_step4) return;
  requestAnimationFrame(() => {
    _step4.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timeSelect = document.querySelector('[data-drawer-time]');
    if (timeSelect) timeSelect.focus({ preventScroll: true });
  });
}

function hideStep4() {
  if (_step4) { _step4.classList.add('tw-hidden'); _step4.style.display = 'none'; }
  const timeSelect = document.querySelector('[data-drawer-time]');
  if (timeSelect) timeSelect.value = '';
  hideStep5();
}

/**
 * Reveal the instructions step. Curbside toggle + vehicle fields are pickup-only;
 * the heading/placeholder reflect the order type. Field values are NOT reset here
 * (prefillFromSaved relies on that when reopening a saved event) — hideStep5 owns
 * the reset.
 */
function showStep5() {
  if (!_step5) return;
  _step5.classList.remove('tw-hidden');
  _step5.style.display = 'flex';

  const { orderType } = readFormValues();
  const isPickup = orderType === 'Pickup';

  const curbsideWrap = document.querySelector('[data-curbside-wrap]');
  if (curbsideWrap) curbsideWrap.classList.toggle('tw-hidden', !isPickup);

  const heading = document.querySelector('[data-instruction-heading]');
  if (heading) heading.textContent = isPickup ? 'Pickup instruction' : 'Delivery instruction';

  const instruction = document.querySelector('[data-instruction]');
  if (instruction) instruction.placeholder = isPickup ? 'Add pickup instructions' : 'Add delivery instructions';

  const hint = document.querySelector('[data-instruction-hint]');
  if (hint) {
    hint.textContent = isPickup
      ? 'Provide details to make your pickup as convenient as possible. (Ex: pickup timeframe, accessibility requirements, etc.)'
      : 'Provide details to help us deliver your treats to the right place. (Ex: crossroads, landmarks, info for gated communities, etc.)';
  }
}

function hideStep5() {
  if (_step5) { _step5.classList.add('tw-hidden'); _step5.style.display = 'none'; }

  const instruction = document.querySelector('[data-instruction]');
  if (instruction) instruction.value = '';

  const toggle = document.querySelector('[data-curbside-toggle]');
  if (toggle) toggle.checked = false;

  setVehicleFieldsVisible(false);
  const model = document.querySelector('[data-vehicle-model]');
  const color = document.querySelector('[data-vehicle-color]');
  if (model) model.value = '';
  if (color) color.value = '';

  updateInstructionCount();
}

/**
 * Toggle the vehicle model/color row. Uses an inline display alongside tw-hidden
 * to match the show/hide pattern used by the step containers (avoids the
 * tw-hidden vs tw-grid display-utility conflict).
 */
function setVehicleFieldsVisible(visible) {
  const fields = document.querySelector('[data-vehicle-fields]');
  if (!fields) return;
  fields.classList.toggle('tw-hidden', !visible);
  fields.style.display = visible ? 'grid' : '';
}

function updateInstructionCount() {
  const instruction = document.querySelector('[data-instruction]');
  const counter = document.querySelector('[data-instruction-count]');
  if (instruction && counter) counter.textContent = `${instruction.value.length}/250`;
}

/**
 * Step 5 is complete when the instruction is non-empty and — for a curbside
 * pickup — both vehicle fields are filled.
 */
function isStep5Complete() {
  const instruction = document.querySelector('[data-instruction]')?.value?.trim() || '';
  if (!instruction) return false;

  const { orderType } = readFormValues();
  if (orderType === 'Pickup' && document.querySelector('[data-curbside-toggle]')?.checked) {
    const model = document.querySelector('[data-vehicle-model]')?.value?.trim() || '';
    const color = document.querySelector('[data-vehicle-color]')?.value?.trim() || '';
    if (!model || !color) return false;
  }
  return true;
}

/**
 * Reveal the instructions step and scroll it into view so the user is prompted to
 * finish. We don't auto-focus the textarea — that would pop the mobile keyboard
 * and hide the curbside toggle.
 */
function revealStep5AndScroll() {
  showStep5();
  if (_step5) requestAnimationFrame(() => _step5.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

/**
 * Fill the read-only summary fields shown at the top of step 3.
 */
function populateStep3Summary(saved) {
  const zip    = (saved && saved.zipCode)    || document.querySelector('[data-drawer-zip]')?.value  || '';
  const date   = (saved && saved.date)       || document.querySelector('[data-drawer-date]')?.value || '';
  const guests = (saved && saved.guestCount) || document.querySelector('[data-drawer-guests]')?.value || '';

  let dateFormatted = date;
  if (date) {
    try {
      // Append T00:00:00 to force local-timezone parse; a bare "YYYY-MM-DD" string
      // is treated as UTC midnight and shifts the displayed date by the user's offset.
      const d = new Date(date + 'T00:00:00');
      dateFormatted = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    } catch { /* keep raw string on parse failure */ }
  }

  const zipEl    = document.querySelector('[data-step3-zip-value]');
  const dateEl   = document.querySelector('[data-step3-date-value]');
  const guestsEl = document.querySelector('[data-step3-guests]');

  if (zipEl)    zipEl.textContent  = zip;
  if (dateEl)   dateEl.textContent = dateFormatted;
  if (guestsEl) guestsEl.value     = guests;

  // Restore a previously selected store within the current ZIP + order-type list
  if (saved && saved.store) {
    const type = (saved.orderType || 'Pickup').toLowerCase();
    const stores = (STORE_DATA[saved.zipCode] && STORE_DATA[saved.zipCode][type]) || [];
    selectedStoreIndex = stores.findIndex((s) => s.name === saved.store.name);
  } else {
    selectedStoreIndex = -1;
  }
}

// ── Store list rendering ──────────────────────────────────────────────────────

const EMPTY_STORE_LIST_HTML = '<p class="tw-m-0 tw-text-sm" style="color:#464646;">No locations found for this ZIP code. Please try a different ZIP.</p>';

/**
 * Return the HTML string for a single store card.
 */
function buildStoreCardHtml(store, i, isSelected) {
  const selectedClass = isSelected ? ' catering-store-card--selected' : '';
  const tagsText = store.features.join(' | ');

  return `
    <div data-store-card="${i}" class="catering-store-card${selectedClass}">

      <div class="catering-store-card__header">
        <span class="catering-store-card__name">${escapeHtml(store.address)}, ${escapeHtml(store.city)}, ${escapeHtml(store.state)}</span>
        <span class="catering-store-card__distance">${escapeHtml(store.distance)}</span>
      </div>

      <div class="catering-store-card__groups">
        <div class="catering-store-card__info">
          <span class="catering-store-card__text">${escapeHtml(store.city)}, ${escapeHtml(store.state)} ${escapeHtml(store.zip)}</span>
          <span class="catering-store-card__text">${escapeHtml(store.phone)}</span>
          <span class="catering-store-card__text">${escapeHtml(tagsText)}</span>
        </div>
        <div class="catering-store-card__days">
          <span class="catering-store-card__text">${escapeHtml(store.hours.weekdayRange)}</span>
          <span class="catering-store-card__text">${escapeHtml(store.hours.weekendRange)}</span>
        </div>
        <div class="catering-store-card__times">
          <span class="catering-store-card__text">${escapeHtml(store.hours.weekdayTimes)}</span>
          <span class="catering-store-card__text">${escapeHtml(store.hours.weekendTimes)}</span>
        </div>
      </div>

      <div class="catering-store-card__mobile">
        <span class="catering-store-card__view-details">View details</span>
      </div>

    </div>
  `;
}

function renderStoreList() {
  if (!_storeList) return;
  const stores = getActiveStores();
  if (stores.length === 0) {
    _storeList.innerHTML = EMPTY_STORE_LIST_HTML;
    return;
  }
  _storeList.innerHTML = stores
    .map((store, i) => buildStoreCardHtml(store, i, i === selectedStoreIndex))
    .join('');
}

// ── Button / UI state helpers ─────────────────────────────────────────────────

function updateSelectStoreBtn() {
  const wrap = document.querySelector('[data-select-store-wrap]');
  if (!wrap) return;
  // Time has moved to step 4, so the button only needs an order type chosen
  // (Pickup is checked by default, so it's shown as soon as step 2 reveals).
  const hasRadio = !!document.querySelector('[name="catering_order_type"]:checked');
  wrap.classList.toggle('tw-hidden', !hasRadio);
}

function updateStartAddingBtn() {
  const btn = document.querySelector('[data-start-adding-btn]');
  if (!btn) return;
  // Enabled only once a store (step 3), a time (step 4) and the instructions
  // (step 5 — incl. vehicle details for a curbside pickup) are all complete.
  const hasTime = !!(document.querySelector('[data-drawer-time]')?.value);
  btn.disabled = !(selectedStoreIndex >= 0 && hasTime && isStep5Complete());
}

/**
 * Sync the order-type pill border highlights and the time-select placeholder text
 * whenever the selected order type changes.
 */
function updateOrderTypeUI(orderType) {
  const isDelivery = orderType === 'Delivery';
  const timeText   = isDelivery ? 'Select Delivery Time' : 'Select Pickup Time';

  const timeLabel = document.querySelector('[data-time-label]');
  if (timeLabel) timeLabel.textContent = timeText;

  const timeSelect = document.querySelector('[data-drawer-time]');
  if (timeSelect) {
    const firstOption = timeSelect.querySelector('option[value=""]');
    if (firstOption) firstOption.textContent = timeText;
  }

  const timeHeading = document.querySelector('[data-time-heading]');
  if (timeHeading) {
    timeHeading.textContent = isDelivery ? 'Select a delivery time' : 'Select a pickup time';
  }

  const storeHeading = document.querySelector('[data-store-heading]');
  if (storeHeading) {
    storeHeading.textContent = isDelivery
      ? 'Which store do you want to deliver from?'
      : 'Which store do you want to pick up from?';
  }

  document.querySelectorAll('[data-order-type-label]').forEach((label) => {
    const radio = label.querySelector('input[type="radio"]');
    label.style.borderColor = (radio && radio.checked) ? '#1D1D1D' : '#DBDBDB';
  });
}

// ── Prefill & save ────────────────────────────────────────────────────────────

function prefillFromSaved(saved) {
  clearZipFeedback();
  hideDrawerLoader();

  if (saved.zipCode && STORE_DATA[saved.zipCode]) {
    ZIP_CACHE[saved.zipCode] = STORE_DATA[saved.zipCode];
    zipValidState    = 'valid';
    lastValidatedZip = saved.zipCode;
  }

  const zipInput    = document.querySelector('[data-drawer-zip]');
  const dateInput   = document.querySelector('[data-drawer-date]');
  const guestsInput = document.querySelector('[data-drawer-guests]');

  if (zipInput) {
    zipInput.value = saved.zipCode || '';
    const wrap = zipInput.closest('.catering-drawer__zip-wrap');
    if (wrap) wrap.classList.toggle('has-value', !!saved.zipCode);
  }
  if (dateInput) {
    dateInput.value = saved.date || '';
    const wrap = dateInput.closest('.catering-drawer__date-wrap');
    if (wrap) wrap.classList.toggle('has-value', !!saved.date);
    // The native date text is transparent; the visible value is the custom
    // [data-date-display] span (normally filled by initDatePlaceholder on
    // input/change). Setting .value programmatically fires neither, so populate
    // it here to match — format YYYY-MM-DD → MM/DD/YYYY.
    const display = wrap && wrap.querySelector('[data-date-display]');
    if (display) {
      const p = saved.date ? saved.date.split('-') : [];
      display.textContent = p.length === 3 ? `${p[1]}/${p[2]}/${p[0]}` : (saved.date || '');
    }
  }
  if (guestsInput) guestsInput.value = saved.guestCount || '';

  if (saved.orderType) {
    document.querySelectorAll('[name="catering_order_type"]').forEach((r) => {
      r.checked = r.value === saved.orderType;
    });
    updateOrderTypeUI(saved.orderType);
  }

  const timeSelect = document.querySelector('[data-drawer-time]');
  if (timeSelect && saved.time) timeSelect.value = saved.time;

  // Restore step 5 (instructions + curbside / vehicle details)
  const instruction = document.querySelector('[data-instruction]');
  if (instruction) instruction.value = saved.instruction || '';
  updateInstructionCount();

  const isCurbside = saved.orderType === 'Pickup' && !!saved.curbside;
  const toggle = document.querySelector('[data-curbside-toggle]');
  if (toggle) toggle.checked = isCurbside;
  setVehicleFieldsVisible(isCurbside);

  const model = document.querySelector('[data-vehicle-model]');
  const color = document.querySelector('[data-vehicle-color]');
  if (model) model.value = saved.vehicleModel || '';
  if (color) color.value = saved.vehicleColor || '';
}

function saveAndClose() {
  const { zip, date, guests, orderType, time } = readFormValues();
  const store = selectedStoreIndex >= 0 ? getActiveStores()[selectedStoreIndex] : null;
  if (!store || !isStep5Complete()) return;

  const instruction = document.querySelector('[data-instruction]')?.value?.trim() || '';
  const curbside    = orderType === 'Pickup' && !!document.querySelector('[data-curbside-toggle]')?.checked;
  const vehicleModel = curbside ? (document.querySelector('[data-vehicle-model]')?.value?.trim() || '') : '';
  const vehicleColor = curbside ? (document.querySelector('[data-vehicle-color]')?.value?.trim() || '') : '';

  const eventData = {
    zipCode: zip,
    date,
    guestCount: guests,
    orderType,
    time,
    instruction,
    curbside,
    vehicleModel,
    vehicleColor,
    store: {
      name: store.name,
      city: store.city,
      state: store.state,
      zip: store.zip,
      phone: store.phone,
    },
  };

  // This is the ONLY place the in-memory event is stored — i.e. only when the
  // user has completed every step and clicked "Start Adding Products". Typing in
  // the steps never persists; closing without reaching here keeps it unset.
  _lastSavedEvent = eventData;
  closeDrawer();
  document.dispatchEvent(new CustomEvent('catering:event:saved', { detail: eventData }));
}

// ── ZIP validation ────────────────────────────────────────────────────────────

async function fetchStoresByZip(zip) {
  if (ZIP_CACHE[zip] !== undefined) return ZIP_CACHE[zip];
  // TODO: Replace this simulated delay with a real store-locator API call.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const result = STORE_DATA[zip] || null;
  ZIP_CACHE[zip] = result;
  return result;
}

function showDrawerLoader() {
  if (_drawerLoader) _drawerLoader.style.display = 'flex';
}

function hideDrawerLoader() {
  if (_drawerLoader) _drawerLoader.style.display = 'none';
}

function showZipFeedback(type, msg) {
  const el = document.querySelector('[data-zip-feedback]');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? '#E10600' : '#464646';
  el.classList.remove('tw-hidden');
}

function clearZipFeedback() {
  const el = document.querySelector('[data-zip-feedback]');
  if (el) { el.textContent = ''; el.classList.add('tw-hidden'); }
}

async function validateZip(zip) {
  zipValidState    = 'loading';
  lastValidatedZip = zip;
  showZipFeedback('info', 'Checking ZIP code…');
  showDrawerLoader();
  hideStep2();
  hideStep3();
  const timeSelect = document.querySelector('[data-drawer-time]');
  if (timeSelect) timeSelect.value = '';

  const result = await fetchStoresByZip(zip);

  // Guard against stale responses: user may have edited the ZIP while in-flight.
  const currentZip = document.querySelector('[data-drawer-zip]')?.value?.trim();
  if (currentZip !== zip) return;

  hideDrawerLoader();
  console.log("zipValidState==1==>",zipValidState)

  if (result) {
    zipValidState = 'valid';
    console.log("zipValidState==2==>",zipValidState)
    clearZipFeedback();
    checkZipDateFilled();
  } else {
    zipValidState = 'invalid';
    console.log("zipValidState==3==>",zipValidState)
    showZipFeedback('error', 'No Store found for this ZIP code. Please try another one.');
  }
}

function checkZipDateFilled() {
  const { zip, date } = readFormValues();
  if (zip && date && zipValidState === 'valid') {
    revealStep2();
  } else {
    hideStep2();
  }
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindDrawerEvents() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-catering-drawer]')) {
      e.preventDefault();
      openDrawer();
    }
  });

  // Allow other modules (e.g. the catering cart's Add-to-cart gate) to open the
  // event-details drawer.
  document.addEventListener('catering:open-event-drawer', () => openDrawer());

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-catering-drawer-close]')) { closeDrawer(); return; }
    if (e.target.matches('[data-catering-drawer-overlay]')) closeDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

function bindStep1Events() {
  const zipInput  = document.querySelector('[data-drawer-zip]');
  const dateInput = document.querySelector('[data-drawer-date]');

  if (zipInput) {
    zipInput.addEventListener('input', (e) => {
      const cleaned = e.target.value.replace(/\D/g, '').slice(0, 5);
      if (e.target.value !== cleaned) e.target.value = cleaned;

      if (cleaned.length < 5) {
        // ZIP fell below 5 digits. If it had already been validated, the whole
        // flow downstream is now stale, so collapse steps 2–5 and reset the
        // store/time/validation state. Keeps zip/date/guests intact.
        if (zipValidState !== 'idle') {
          hideAllStepsExceptFirst();
        }
        return;
      }

      // Reached 5 digits — reset steps/store/time before (re)validating so nothing
      // stale lingers while the lookup runs, then validate. (Keeps the date/guests
      // so step 2 can reveal once the new ZIP is confirmed.)
      hideAllStepsExceptFirst();
      validateZip(cleaned);
    });
  }

  if (dateInput) {
    dateInput.addEventListener('input', checkZipDateFilled);
    dateInput.addEventListener('change', checkZipDateFilled);
  }

  // Clearing the ZIP via the in-field "×" invalidates the whole flow, so do a full
  // reset back to a clean step 1 — clear every field (zip/date/guests) and collapse
  // steps 2–5. (initZipClear in the snippet also clears the input visually + removes
  // the × icon; this owns the field + step reset.)
  const zipClear = document.querySelector('[data-zip-clear]');
  if (zipClear) {
    zipClear.addEventListener('click', () => { resetDrawerForm(); });
  }
}

function bindStep2Events() {
  const orderTypeRadios = document.querySelectorAll('[name="catering_order_type"]');
  for (const radio of orderTypeRadios) {
    radio.addEventListener('change', () => {
      updateOrderTypeUI(radio.value);

      // Changing order type invalidates any store selection (step 3) and the
      // time chosen for it (step 4); hideStep3 collapses both and resets the time.
      if (_step3 && !_step3.classList.contains('tw-hidden')) {
        hideStep3();
      }

      updateSelectStoreBtn();
    });
  }
  // Apply initial Pickup pill highlight on load
  updateOrderTypeUI('Pickup');

  const drawerTime = document.querySelector('[data-drawer-time]');
  if (drawerTime) {
    drawerTime.addEventListener('change', () => {
      // Choosing a time reveals step 5 (instructions); clearing it hides step 5.
      if (drawerTime.value) revealStep5AndScroll();
      else hideStep5();
      updateStartAddingBtn();
    });
  }

  const selectStoreBtn = document.querySelector('[data-select-store-btn]');
  if (selectStoreBtn) {
    selectStoreBtn.addEventListener('click', () => {
      const { zip, date, guests, orderType, time } = readFormValues();
      const selectWrap = document.querySelector('[data-select-store-wrap]');
      if (selectWrap) selectWrap.classList.add('tw-hidden');
      showStep3({ zipCode: zip, date, guestCount: guests, orderType, time });
      // Bring the store-list section into view so the user sees their next choice.
      if (_step3) requestAnimationFrame(() => _step3.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    });
  }
}

function bindStep3Events() {
  if (_storeList) {
    _storeList.addEventListener('click', (e) => {
      const card = e.target.closest('[data-store-card]');
      if (!card) return;
      const newIndex = parseInt(card.dataset.storeCard, 10);

      if (newIndex === selectedStoreIndex) return;

      selectedStoreIndex = newIndex;
      renderStoreList();
      // Selecting OR switching a store resets the time back to its default so the
      // user re-confirms it for the chosen store, then reveals step 4, scrolls to
      // it, and focuses the dropdown. Resetting the time also invalidates step 5,
      // so collapse it. "Start Adding Products" stays disabled until everything is
      // re-completed.
      const timeSelect = document.querySelector('[data-drawer-time]');
      if (timeSelect) timeSelect.value = '';
      hideStep5();
      showStep4();
      focusTimeStep();
      updateStartAddingBtn();
    });
  }

  const startBtn = document.querySelector('[data-start-adding-btn]');
  if (startBtn) startBtn.addEventListener('click', saveAndClose);

  // "Edit" button on the event-summary pill resets back to steps 1+2
  const editSummaryBtn = document.querySelector('[data-edit-summary]');
  if (editSummaryBtn) {
    editSummaryBtn.addEventListener('click', () => {
      hideAllStepsExceptFirst();
      checkZipDateFilled();
    });
  }
}

function bindStep5Events() {
  const instruction = document.querySelector('[data-instruction]');
  if (instruction) {
    instruction.addEventListener('input', () => {
      updateInstructionCount();
      updateStartAddingBtn();
    });
  }

  const toggle = document.querySelector('[data-curbside-toggle]');
  if (toggle) {
    toggle.addEventListener('change', () => {
      setVehicleFieldsVisible(toggle.checked);
      // Clear vehicle fields when curbside is turned off so stale values can't
      // satisfy the completion check after the fields are hidden.
      if (!toggle.checked) {
        const model = document.querySelector('[data-vehicle-model]');
        const color = document.querySelector('[data-vehicle-color]');
        if (model) model.value = '';
        if (color) color.value = '';
      }
      updateStartAddingBtn();
    });
  }

  ['[data-vehicle-model]', '[data-vehicle-color]'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener('input', updateStartAddingBtn);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  // Cache static DOM references once; these elements exist for the page lifetime
  _drawer      = document.querySelector('[data-catering-drawer]');
  _overlay     = document.querySelector('[data-catering-drawer-overlay]');
  _step1       = document.querySelector('[data-step-1]');
  _step2       = document.querySelector('[data-step-2]');
  _step3       = document.querySelector('[data-step-3]');
  _step4       = document.querySelector('[data-step-4]');
  _step5       = document.querySelector('[data-step-5]');
  _step3Footer = document.querySelector('[data-step3-footer]');
  _storeList   = document.querySelector('[data-store-list]');
  _drawerLoader = document.querySelector('[data-drawer-loader]');

  bindDrawerEvents();
  bindStep1Events();
  bindStep2Events();
  bindStep3Events();
  bindStep5Events();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
