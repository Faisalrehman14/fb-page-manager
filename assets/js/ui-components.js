/**
 * assets/js/ui-components.js
 * ═════════════════════════════════════════════════════════════
 * Production-grade UI component library
 * 
 * Includes:
 * - Toast notifications
 * - Modal dialogs
 * - Loading states
 * - Form validation
 * - Tooltips
 * - Spinners
 */

class UIComponents {
  /**
   * Show toast notification
   * @param {string} message - Notification message
   * @param {string} type - 'success', 'error', 'warning', 'info'
   * @param {number} duration - Auto-hide after ms (0 = manual dismiss)
   */
  static showToast(message, type = 'info', duration = 4000) {
    const toastContainer = this._ensureToastContainer();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    
    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };
    
    toast.innerHTML = `
      <div class="toast-content">
        <i class="fas ${icons[type] || 'fa-info-circle'}"></i>
        <span>${this._escapeHtml(message)}</span>
      </div>
      <button class="toast-close" aria-label="Close notification">
        <i class="fas fa-times"></i>
      </button>
    `;
    
    toastContainer.appendChild(toast);
    
    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    });
    
    if (duration > 0) {
      setTimeout(() => {
        if (toast.parentElement) {
          toast.classList.add('toast-exit');
          setTimeout(() => toast.remove(), 300);
        }
      }, duration);
    }
    
    return toast;
  }
  
  /**
   * Show modal dialog
   * @param {Object} options - { title, content, buttons, closable }
   */
  static showModal(options = {}) {
    const { title, content, buttons = [], closable = true } = options;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    if (title) modal.setAttribute('aria-labelledby', 'modal-title');
    
    let buttonsHTML = '';
    if (Array.isArray(buttons)) {
      buttonsHTML = buttons.map(btn => `
        <button class="modal-btn modal-btn-${btn.variant || 'secondary'}" 
                data-action="${btn.action || ''}">
          ${this._escapeHtml(btn.text)}
        </button>
      `).join('');
    }
    
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          ${title ? `<h2 id="modal-title">${this._escapeHtml(title)}</h2>` : ''}
          ${closable ? '<button class="modal-close" aria-label="Close dialog"><i class="fas fa-times"></i></button>' : ''}
        </div>
        <div class="modal-body">
          ${typeof content === 'string' ? content : ''}
        </div>
        ${buttonsHTML ? `<div class="modal-footer">${buttonsHTML}</div>` : ''}
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close on close button
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeModal(modal));
    }
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closeModal(modal);
    });
    
    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        this._closeModal(modal);
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
    
    // Handle button clicks
    modal.querySelectorAll('.modal-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.closest('.modal-btn').dataset.action;
        const callback = options[action];
        if (callback) callback();
        if (options.closeOnAction !== false) this._closeModal(modal);
      });
    });
    
    return modal;
  }
  
  /**
   * Show loading spinner overlay
   * @param {string} message - Optional message
   */
  static showLoading(message = '') {
    const loader = document.createElement('div');
    loader.className = 'loader-overlay';
    loader.innerHTML = `
      <div class="loader-content">
        <div class="spinner"></div>
        ${message ? `<p class="loader-message">${this._escapeHtml(message)}</p>` : ''}
      </div>
    `;
    
    document.body.appendChild(loader);
    return loader;
  }
  
  static hideLoading() {
    const loader = document.querySelector('.loader-overlay');
    if (loader) {
      loader.classList.add('loader-exit');
      setTimeout(() => loader.remove(), 300);
    }
  }
  
  /**
   * Validate form field
   * @param {HTMLElement} field - Input element
   * @param {string} rule - Validation rule (email, required, url, number, etc.)
   */
  static validateField(field, rule = '') {
    const value = (field.value || '').trim();
    let isValid = true;
    let errorMsg = '';
    
    if (rule === 'required' || field.required) {
      if (!value) {
        isValid = false;
        errorMsg = 'This field is required';
      }
    }
    
    if (isValid && rule === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (value && !emailRegex.test(value)) {
        isValid = false;
        errorMsg = 'Enter a valid email address';
      }
    }
    
    if (isValid && rule === 'url') {
      try {
        new URL(value);
      } catch {
        if (value) {
          isValid = false;
          errorMsg = 'Enter a valid URL';
        }
      }
    }
    
    if (isValid && rule === 'number') {
      if (value && isNaN(value)) {
        isValid = false;
        errorMsg = 'Enter a valid number';
      }
    }
    
    if (isValid && rule === 'minLength') {
      const minLength = parseInt(field.getAttribute('minlength'), 10);
      if (minLength && value.length < minLength) {
        isValid = false;
        errorMsg = `Must be at least ${minLength} characters`;
      }
    }
    
    // Update UI
    field.classList.toggle('field-error', !isValid);
    field.classList.toggle('field-valid', isValid && value);
    
    const errorEl = field.nextElementSibling;
    if (errorEl && errorEl.classList.contains('field-error-msg')) {
      errorEl.textContent = errorMsg;
      errorEl.style.display = isValid ? 'none' : 'block';
    }
    
    return isValid;
  }
  
  /**
   * Show tooltip
   */
  static showTooltip(element, text) {
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    
    const rect = element.getBoundingClientRect();
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top = (rect.top - 10) + 'px';
    
    element.addEventListener('mouseleave', () => {
      tooltip.classList.add('tooltip-fade');
      setTimeout(() => tooltip.remove(), 200);
    });
  }
  
  /**
   * Create skeleton loader
   */
  static createSkeleton(rows = 3) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-loader';
    
    for (let i = 0; i < rows; i++) {
      const line = document.createElement('div');
      line.className = 'skeleton-line';
      skeleton.appendChild(line);
    }
    
    return skeleton;
  }
  
  /**
   * Show confirmation dialog
   */
  static confirm(message, options = {}) {
    return new Promise((resolve) => {
      this.showModal({
        title: options.title || 'Confirm',
        content: message,
        closable: true,
        buttons: [
          {
            text: options.cancelText || 'Cancel',
            action: 'onCancel',
            variant: 'secondary'
          },
          {
            text: options.okText || 'OK',
            action: 'onOk',
            variant: 'primary'
          }
        ],
        closeOnAction: true,
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      });
    });
  }
  
  // Private helpers
  
  static _ensureToastContainer() {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }
  
  static _closeModal(modal) {
    modal.classList.add('modal-exit');
    setTimeout(() => modal.remove(), 300);
  }
  
  static _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Global shorthand
window.UI = UIComponents;
