/**
 * Zendesk-backed dynamic contact form controller.
 *
 * Replicates the live ediblearrangements.com contact form behavior on top of a
 * plain HTML form: conditional fields driven by the selected reason / sub-reason,
 * client-side validation with real-time submit-button toggling, and submission to
 * the api.edible.tech proxy endpoint with base64-encoded image attachments.
 *
 * Config is read from the host element:
 *   data-endpoint         -> POST target URL (e.g. https://api.edible.tech/zendesk/v1/postTicket)
 *   data-subscription-key -> ocp-apim-subscription-key header
 *   data-brand-id         -> x-brand-id header
 *   data-group-id         -> x-group-id header
 * The reason tree is read from a <script type="application/json" data-reasons> child.
 *
 * Visibility rules (mirror docs/contact-us-form-flows.md S3):
 *   subCategory shown  <=> reason.subs.length > 0
 *   requestedBy shown  <=> reason.requestedBy
 *   orderNumber shown  <=> (hasSub ? selectedSub.orderNumber : reason.orderNumber)
 *   attachments shown  <=> (hasSub ? selectedSub.photo      : reason.image)
 */

const NAME_RE = /^[a-z ,.'-]+$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/u;
const MESSAGE_MAX = 3800;
const MESSAGE_SOFT_MAX = 3500;
const MESSAGE_MAX_LINES = 15;
const ALLOWED_FILE_TYPES = ['image/png', 'image/jpeg'];
const MAX_FILES = 1;
const REQUEST_TIMEOUT_MS = 30000;

class ZendeskContactForm extends HTMLElement {
  connectedCallback() {
    this.endpoint = this.dataset.endpoint?.trim() || '';
    this.subscriptionKey = this.dataset.subscriptionKey?.trim() || '';
    this.brandId = this.dataset.brandId?.trim() || '';
    this.groupId = this.dataset.groupId?.trim() || '';

    this.sessionId = this.generateSessionId();

    const reasonsEl = this.querySelector('[data-reasons]');
    try {
      this.reasons = JSON.parse(reasonsEl?.textContent || '[]');
    } catch {
      this.reasons = [];
    }

    this.form = this.querySelector('[data-form]');
    this.successEl = this.querySelector('[data-success]');
    this.messagesEl = this.querySelector('[data-messages]');
    this.submitBtn = this.querySelector('[data-submit]');

    this.categorySelect = this.field('category');
    this.subCategorySelect = this.field('subCategory');
    this.requestedBySelect = this.field('requestedBy');
    this.orderNumberInput = this.field('orderNumber');
    this.firstNameInput = this.field('firstName');
    this.lastNameInput = this.field('lastName');
    this.phoneInput = this.field('phone');
    this.emailInput = this.field('email');
    this.messageInput = this.field('message');
    this.fileInput = this.field('attachments');
    this.previewsEl = this.querySelector('[data-file-previews]');

    this.populateCategories();
    this.bindEvents();
    this.applyVisibility();
    this.updateSubmitState();
  }

  field(key) {
    return this.querySelector(`[data-field="${key}"]`);
  }

  row(key) {
    return this.querySelector(`[data-row="${key}"]`);
  }

  /* ---------- setup ---------- */

  populateCategories() {
    if (!this.categorySelect) return;
    for (const reason of this.reasons) {
      const opt = document.createElement('option');
      opt.value = reason.label;
      opt.textContent = reason.label;
      this.categorySelect.appendChild(opt);
    }
  }

  bindEvents() {
    this.categorySelect?.addEventListener('change', () => {
      this.populateSubCategories();
      this.applyVisibility();
      this.updateSubmitState();
    });

    this.subCategorySelect?.addEventListener('change', () => {
      this.applyVisibility();
      this.updateSubmitState();
    });

    this.phoneInput?.addEventListener('input', () => {
      this.formatPhone();
      this.updateSubmitState();
    });

    this.messageInput?.addEventListener('input', () => {
      this.sanitizeMessage();
      this.updateSubmitState();
    });

    this.fileInput?.addEventListener('change', () => {
      this.validateFiles();
      this.renderFilePreviews();
      this.updateSubmitState();
    });

    this.firstNameInput?.addEventListener('input', () => this.updateSubmitState());
    this.lastNameInput?.addEventListener('input', () => this.updateSubmitState());
    this.emailInput?.addEventListener('input', () => this.updateSubmitState());
    this.orderNumberInput?.addEventListener('input', () => this.updateSubmitState());
    this.requestedBySelect?.addEventListener('change', () => this.updateSubmitState());

    this.form?.addEventListener('submit', (event) => this.handleSubmit(event));

    // Clear a field's error as soon as the user edits it.
    this.form?.addEventListener('input', (event) => this.clearFieldError(event.target));
    this.form?.addEventListener('change', (event) => this.clearFieldError(event.target));
  }

  /* ---------- conditional fields ---------- */

  get selectedReason() {
    return this.reasons.find((r) => r.label === this.categorySelect?.value) || null;
  }

  get selectedSub() {
    const reason = this.selectedReason;
    if (!reason || !reason.subs?.length) return null;
    return reason.subs.find((s) => s.label === this.subCategorySelect?.value) || null;
  }

  populateSubCategories() {
    if (!this.subCategorySelect) return;
    const reason = this.selectedReason;
    // reset to placeholder
    this.subCategorySelect.length = 1;
    if (!reason?.subs?.length) return;
    for (const sub of reason.subs) {
      const opt = document.createElement('option');
      opt.value = sub.label;
      opt.textContent = sub.label;
      this.subCategorySelect.appendChild(opt);
    }
  }

  applyVisibility() {
    const reason = this.selectedReason;
    const hasSub = !!reason?.subs?.length;
    const sub = this.selectedSub;

    const showSub = hasSub;
    const showRequestedBy = !!reason?.requestedBy;
    const showOrder = hasSub ? !!sub?.orderNumber : !!reason?.orderNumber;
    const showFiles = hasSub ? !!sub?.photo : !!reason?.image;

    this.toggleRow('subCategory', showSub, true);
    this.toggleRow('requestedBy', showRequestedBy, true);
    this.toggleRow('orderNumber', showOrder, true);
    this.toggleRow('attachments', showFiles, false); // attachments are optional even when shown

    this.renderFilePreviews();
    this.updateSubmitState();
  }

  /**
   * Show/hide a conditional row and keep its control out of submission + validation
   * when hidden (disabled inputs are neither validated nor included).
   */
  toggleRow(key, visible, required) {
    const row = this.row(key);
    const input = this.field(key);
    if (!row || !input) return;

    row.hidden = !visible;
    input.disabled = !visible;
    input.required = visible && required;

    if (!visible) {
      if (input.tagName === 'SELECT') {
        input.selectedIndex = 0;
      } else {
        input.value = '';
      }
      input.setCustomValidity('');
    }
  }

  /* ---------- formatting + validation ---------- */

  formatPhone() {
    const digits = this.phoneInput.value.replace(/\D/g, '').slice(0, 10);
    let out = digits;
    if (digits.length > 6) {
      out = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    } else if (digits.length > 3) {
      out = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    }
    this.phoneInput.value = out;
  }

  sanitizeMessage() {
    let value = this.messageInput.value.replace(/[<>]/g, '').replace(EMOJI_RE, '');
    const lines = value.split('\n');
    if (lines.length > MESSAGE_MAX_LINES) {
      value = lines.slice(0, MESSAGE_MAX_LINES).join('\n');
    }
    if (value.length > MESSAGE_MAX) {
      value = value.slice(0, MESSAGE_MAX);
    }
    if (value !== this.messageInput.value) {
      this.messageInput.value = value;
    }
  }

  /**
   * @param {boolean} report - if true, calls reportValidity() on the file input (default true).
   *   Pass false for silent validation (e.g. during updateSubmitState).
   */
  validateFiles(report = true) {
    if (!this.fileInput) return;
    const files = Array.from(this.fileInput.files || []);
    if (files.length > MAX_FILES) {
      this.fileInput.setCustomValidity('Please attach a single image.');
    } else if (files.some((f) => !ALLOWED_FILE_TYPES.includes(f.type))) {
      this.fileInput.setCustomValidity('Only PNG or JPEG images are allowed.');
    } else {
      this.fileInput.setCustomValidity('');
    }
    if (report) {
      this.fileInput.reportValidity();
    }
  }

  /**
   * Validate every applicable field and return a list of
   * { el, message } entries — one per invalid field, in DOM order.
   */
  validateFields() {
    const errors = [];
    const REQUIRED = 'This field is required.';

    if (!this.selectedReason) {
      errors.push({ el: this.categorySelect, message: 'Please select a reason.' });
    }

    if (this.subCategorySelect && !this.subCategorySelect.disabled && !this.subCategorySelect.value) {
      errors.push({ el: this.subCategorySelect, message: REQUIRED });
    }
    if (this.orderNumberInput && !this.orderNumberInput.disabled && !this.orderNumberInput.value.trim()) {
      errors.push({ el: this.orderNumberInput, message: REQUIRED });
    }
    if (this.requestedBySelect && !this.requestedBySelect.disabled && !this.requestedBySelect.value) {
      errors.push({ el: this.requestedBySelect, message: REQUIRED });
    }

    if (this.firstNameInput) {
      if (!this.firstNameInput.value.trim()) {
        errors.push({ el: this.firstNameInput, message: REQUIRED });
      } else if (!NAME_RE.test(this.firstNameInput.value.trim())) {
        errors.push({ el: this.firstNameInput, message: 'Please enter a valid first name.' });
      }
    }
    if (this.lastNameInput) {
      if (!this.lastNameInput.value.trim()) {
        errors.push({ el: this.lastNameInput, message: REQUIRED });
      } else if (!NAME_RE.test(this.lastNameInput.value.trim())) {
        errors.push({ el: this.lastNameInput, message: 'Please enter a valid last name.' });
      }
    }
    if (this.phoneInput) {
      const digits = this.phoneInput.value.replace(/\D/g, '');
      if (!digits) {
        errors.push({ el: this.phoneInput, message: REQUIRED });
      } else if (digits.length !== 10) {
        errors.push({ el: this.phoneInput, message: 'Please enter a valid 10-digit phone number.' });
      }
    }
    if (this.emailInput) {
      if (!this.emailInput.value.trim()) {
        errors.push({ el: this.emailInput, message: REQUIRED });
      } else if (!EMAIL_RE.test(this.emailInput.value.trim())) {
        errors.push({ el: this.emailInput, message: 'Please enter a valid email address.' });
      }
    }
    if (this.messageInput && !this.messageInput.value.trim()) {
      errors.push({ el: this.messageInput, message: REQUIRED });
    }

    if (this.fileInput && !this.fileInput.disabled) {
      this.validateFiles(false);
      if (this.fileInput.validationMessage) {
        errors.push({ el: this.fileInput, message: this.fileInput.validationMessage });
      }
    }

    return errors;
  }

  /**
   * Reflect current validity in the submit button's appearance without
   * natively disabling it — a disabled button can't receive the click that
   * surfaces field-level errors. Called on every input/change event.
   */
  updateSubmitState() {
    if (!this.submitBtn) return;
    const invalid = this.validateFields().length > 0;
    this.submitBtn.setAttribute('aria-disabled', invalid ? 'true' : 'false');
  }

  /* ---------- field error display ---------- */

  markFieldErrors(errors) {
    this.clearFieldErrors();
    for (const { el, message } of errors) {
      if (!el) continue;
      el.classList.add('contact-form-custom__input--error');
      el.setAttribute('aria-invalid', 'true');
      const field = el.closest('.contact-form-custom__field');
      if (field && !field.querySelector('[data-field-error]')) {
        const note = document.createElement('span');
        note.className = 'contact-form-custom__field-error';
        note.setAttribute('data-field-error', '');
        note.textContent = message;
        field.appendChild(note);
      }
    }
    errors[0]?.el?.focus();
  }

  clearFieldErrors() {
    this.querySelectorAll('[data-field-error]').forEach((note) => note.remove());
    this.querySelectorAll('.contact-form-custom__input--error').forEach((el) => {
      el.classList.remove('contact-form-custom__input--error');
      el.removeAttribute('aria-invalid');
    });
  }

  /** Clear the error state for a single field as the user edits it. */
  clearFieldError(el) {
    if (!el || !el.classList?.contains('contact-form-custom__input--error')) return;
    el.classList.remove('contact-form-custom__input--error');
    el.removeAttribute('aria-invalid');
    el.closest('.contact-form-custom__field')?.querySelector('[data-field-error]')?.remove();
  }

  /* ---------- file handling ---------- */

  /**
   * Render a thumbnail per selected file, each with a remove button.
   * Object URLs are revoked before re-render to avoid leaks.
   */
  renderFilePreviews() {
    if (!this.previewsEl || !this.fileInput) return;

    this.previewsEl.querySelectorAll('img[data-object-url]').forEach((img) => {
      URL.revokeObjectURL(img.src);
    });
    this.previewsEl.replaceChildren();

    const files = Array.from(this.fileInput.files || []);
    if (!files.length) {
      this.previewsEl.hidden = true;
      return;
    }
    this.previewsEl.hidden = false;

    files.forEach((file, index) => {
      const item = document.createElement('li');
      item.className = 'contact-form-custom__preview';

      const img = document.createElement('img');
      img.className = 'contact-form-custom__preview-image';
      img.alt = file.name;
      img.setAttribute('data-object-url', '');
      img.src = URL.createObjectURL(file);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'contact-form-custom__preview-remove';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => this.removeFile(index));

      item.append(img, remove);
      this.previewsEl.appendChild(item);
    });
  }

  /** Remove a single selected file by index and re-sync the input + previews. */
  removeFile(index) {
    if (!this.fileInput) return;
    const dt = new DataTransfer();
    Array.from(this.fileInput.files || []).forEach((file, i) => {
      if (i !== index) dt.items.add(file);
    });
    this.fileInput.files = dt.files;
    this.validateFiles(false);
    this.renderFilePreviews();
    this.updateSubmitState();
  }

  /**
   * Read selected files as base64 data URIs.
   * @returns {Promise<Array<{name: string, dataUri: string}>>}
   */
  async readFilesAsBase64() {
    const files = Array.from(this.fileInput?.files || []);
    if (!files.length || this.fileInput.disabled) return [];

    const validFiles = files.slice(0, MAX_FILES).filter((f) => ALLOWED_FILE_TYPES.includes(f.type));

    const results = [];
    for (const file of validFiles) {
      const dataUri = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
        reader.readAsDataURL(file);
      });
      results.push({ name: file.name, dataUri });
    }
    return results;
  }

  /* ---------- submission ---------- */

  /** Generate a per-session id (e.g. "session_a1b2c3d4") for the request payload. */
  generateSessionId() {
    const rand = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 12);
    return `session_${rand}`;
  }

  /**
   * Dev mode is toggled via localStorage: `localStorage.setItem('devmode', 'true')`.
   * When on, the form logs the request payload to the console instead of calling Zendesk.
   */
  isDevMode() {
    try {
      return localStorage.getItem('devmode') === 'true';
    } catch {
      return false;
    }
  }

  async handleSubmit(event) {
    event.preventDefault();

    const errors = this.validateFields();
    if (errors.length) {
      this.markFieldErrors(errors);
      return;
    }
    this.clearFieldErrors();

    if (!this.endpoint) {
      this.showMessage('error', 'This form is not configured yet. Please try again later.');
      return;
    }

    this.setSubmitting(true);
    this.clearMessage();

    try {
      await this.createRequest();
      this.showSuccess();
    } catch (err) {
      console.error('[zendesk-contact-form] submission failed', err);
      const message = err?.name === 'AbortError'
        ? 'The request timed out. Please check your connection and try again.'
        : 'Something went wrong submitting your request. Please try again.';
      this.showMessage('error', message);
      this.setSubmitting(false);
    }
  }

  async createRequest() {
    const reason = this.selectedReason;
    const sub = this.selectedSub;
    const get = (key) => this.field(key)?.value.trim() || '';

    const orderNumber = this.orderNumberInput && !this.orderNumberInput.disabled ? get('orderNumber') : '';
    const requestedByLabel = this.requestedBySelect && !this.requestedBySelect.disabled
      ? this.requestedBySelect.options[this.requestedBySelect.selectedIndex]?.text || ''
      : '';

    // Always send the seven questions in this fixed order (matches the live API),
    // with empty answers for fields not applicable to the selected reason.
    const fields = [
      { type: 'text', question: 'Order Number', answer: orderNumber },
      { type: 'text', question: 'Are you the recipient or customer?', answer: requestedByLabel },
      { type: 'text', question: 'First Name', answer: get('firstName') },
      { type: 'text', question: 'Last Name', answer: get('lastName') },
      { type: 'text', question: 'Phone Number', answer: get('phone') },
      { type: 'text', question: 'Email Address', answer: get('email') },
      { type: 'text', question: 'Message', answer: get('message') },
    ];

    // Append the selected image (if any) as a file_upload field entry.
    const images = await this.readFilesAsBase64();
    for (const img of images) {
      fields.push({ type: 'file_upload', question: img.name, answer: img.dataUri });
    }

    const formData = {
      sessionId: this.sessionId,
      subCategory: sub?.label || '',
      timestamp: new Date().toISOString(),
      category: reason?.label || '',
      subOption: '',
      fields,
    };

    // The live API expects both a `formData` envelope and the same keys at the root.
    const payload = { formData, ...formData };

    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.subscriptionKey) {
      headers['ocp-apim-subscription-key'] = this.subscriptionKey;
    }
    if (this.brandId) {
      headers['x-brand-id'] = this.brandId;
    }
    if (this.groupId) {
      headers['x-group-id'] = this.groupId;
    }

    // Dev mode: set localStorage.devmode = 'true' to skip the Zendesk API call
    // and log the full request payload to the console instead.
    if (this.isDevMode()) {
      console.group('[zendesk-contact-form] DEV MODE — request NOT sent');
      console.log('endpoint:', this.endpoint);
      console.log('headers:', headers);
      console.log('payload:', payload);
      console.log('payload (JSON):', JSON.stringify(payload, null, 2));
      console.groupEnd();
      return { devMode: true, payload };
    }

    // Abort the request if it hangs so the UI can recover instead of stalling.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  }

  /* ---------- ui state ---------- */

  setSubmitting(state) {
    if (!this.submitBtn) return;
    this.submitBtn.disabled = state;
    this.submitBtn.dataset.loading = state ? 'true' : 'false';
    if (!state) {
      this.updateSubmitState();
    }
  }

  showMessage(type, text) {
    if (!this.messagesEl) return;
    this.messagesEl.hidden = false;
    this.messagesEl.dataset.type = type;
    this.messagesEl.querySelector('[data-message-text]').textContent = text;
    this.messagesEl.focus();
  }

  clearMessage() {
    if (!this.messagesEl) return;
    this.messagesEl.hidden = true;
  }

  showSuccess() {
    if (this.form) this.form.hidden = true;
    if (this.successEl) {
      this.successEl.hidden = false;
      this.successEl.focus({ preventScroll: true });
    }
    // Scroll the window to the top so the confirmation is visible.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

if (!customElements.get('zendesk-contact-form')) {
  customElements.define('zendesk-contact-form', ZendeskContactForm);
}
