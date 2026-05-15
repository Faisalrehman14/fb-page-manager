/**
 * UI Integration Examples for FBCast Pro
 * ═════════════════════════════════════════════════════════════
 * 
 * This file shows how to integrate the UI component library
 * into your existing web_ui.js and other JavaScript code.
 * 
 * Just copy these patterns into your code!
 */

// ─────────────────────────────────────────────────────────────
// 1. SHOW TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

// After successful login
function onLoginSuccess(user) {
  UI.showToast(`Welcome back, ${user.name}!`, 'success');
  loadDashboard();
}

// On error
function onLoginFailed(error) {
  UI.showToast(`Login failed: ${error.message}`, 'error');
}

// During processing
function startBroadcast() {
  UI.showToast('Broadcast starting...', 'info', 2000);
  // Then update to completion
  setTimeout(() => {
    UI.showToast('✅ Broadcast complete! 150 messages sent', 'success');
  }, 5000);
}

// Warning
function onRateLimited() {
  UI.showToast(
    'You\'ve reached your message limit for this hour. Upgrade to Pro for unlimited.',
    'warning',
    0  // Manual dismiss
  );
}

// ─────────────────────────────────────────────────────────────
// 2. LOADING STATES
// ─────────────────────────────────────────────────────────────

// Fetch pages from Facebook
async function refreshPages() {
  UI.showLoading('Loading your Facebook pages...');
  
  try {
    const pages = await FB.getPages();
    UI.hideLoading();
    renderPages(pages);
  } catch (error) {
    UI.hideLoading();
    UI.showToast('Failed to load pages: ' + error.message, 'error');
  }
}

// Send messages
async function sendMessages(recipients) {
  const totalCount = recipients.length;
  UI.showLoading(`Sending to ${totalCount} recipients...`);
  
  try {
    let sent = 0;
    for (const recipient of recipients) {
      await sendMessageTo(recipient);
      sent++;
      // Update loading message
      UI.hideLoading();
      UI.showLoading(`Sending (${sent}/${totalCount})...`);
    }
    
    UI.hideLoading();
    UI.showToast(`✅ Sent ${sent} messages successfully!`, 'success');
  } catch (error) {
    UI.hideLoading();
    UI.showToast('Error: ' + error.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// 3. CONFIRMATION DIALOGS
// ─────────────────────────────────────────────────────────────

// Confirm before deleting
async function deleteConversation(conversationId) {
  const confirmed = await UI.confirm(
    'Delete this conversation? This cannot be undone.',
    {
      title: 'Delete Conversation',
      okText: 'Yes, Delete',
      cancelText: 'No, Keep It'
    }
  );
  
  if (!confirmed) return;
  
  UI.showLoading('Deleting...');
  try {
    await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' });
    UI.hideLoading();
    UI.showToast('Conversation deleted', 'success');
  } catch (error) {
    UI.hideLoading();
    UI.showToast('Failed to delete: ' + error.message, 'error');
  }
}

// Confirm before cancelling subscription
async function cancelSubscription() {
  const confirmed = await UI.confirm(
    'Your subscription will be cancelled. You\'ll keep access until the end of your billing cycle.',
    {
      title: 'Cancel Subscription?',
      okText: 'Yes, Cancel',
      cancelText: 'No, Keep It'
    }
  );
  
  if (!confirmed) return;
  
  UI.showLoading('Processing cancellation...');
  try {
    await fetch('/api/subscription/cancel', { method: 'POST' });
    UI.hideLoading();
    UI.showToast('Subscription cancelled', 'success');
    setTimeout(() => location.reload(), 2000);
  } catch (error) {
    UI.hideLoading();
    UI.showToast('Failed to cancel: ' + error.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// 4. FORM VALIDATION
// ─────────────────────────────────────────────────────────────

// Setup form with validation
function setupMessageForm() {
  const form = document.getElementById('messageForm');
  const messageField = document.getElementById('message');
  const recipientField = document.getElementById('recipient');
  
  // Real-time validation
  messageField.addEventListener('blur', () => {
    UI.validateField(messageField, 'required');
  });
  
  recipientField.addEventListener('blur', () => {
    UI.validateField(recipientField, 'email');
  });
  
  // On submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    // Validate all fields
    const messageValid = UI.validateField(messageField, 'required');
    const recipientValid = UI.validateField(recipientField, 'email');
    
    if (!messageValid || !recipientValid) {
      UI.showToast('Please fix the errors above', 'error');
      return;
    }
    
    // Submit
    sendMessage(messageField.value, recipientField.value);
  });
}

// ─────────────────────────────────────────────────────────────
// 5. MODALS
// ─────────────────────────────────────────────────────────────

// Show help modal
function showHelpModal() {
  UI.showModal({
    title: '❓ How to Use',
    content: `
      <h3>Getting Started</h3>
      <ol>
        <li>Connect your Facebook account</li>
        <li>Select a page to broadcast from</li>
        <li>Write your message</li>
        <li>Click "Start Broadcast"</li>
      </ol>
      <p>Messages will be sent with a delay to avoid rate limits.</p>
    `,
    closable: true,
    buttons: [
      {
        text: 'Got it',
        action: 'onClose',
        variant: 'primary'
      }
    ],
    onClose: () => console.log('Help closed')
  });
}

// Show upgrade modal
function showUpgradeModal() {
  UI.showModal({
    title: '🚀 Upgrade to Pro',
    content: `
      <p>Get access to:</p>
      <ul>
        <li>500,000 messages/month</li>
        <li>Auto All Pages mode</li>
        <li>Priority support</li>
        <li>Advanced analytics</li>
      </ul>
      <p style="margin-top: 16px; color: #60a5fa;">Only $40/month</p>
    `,
    buttons: [
      {
        text: 'Learn More',
        action: 'onLearnMore',
        variant: 'secondary'
      },
      {
        text: 'Upgrade Now',
        action: 'onUpgrade',
        variant: 'primary'
      }
    ],
    onUpgrade: () => {
      location.href = '/upgrade?plan=pro';
    },
    onLearnMore: () => {
      location.href = '/#pricing';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 6. PAYMENT INTEGRATION
// ─────────────────────────────────────────────────────────────

// Handle payment in your code
async function processPayment(plan) {
  try {
    UI.showLoading(`Preparing ${plan} plan payment...`);
    
    // Get payment intent
    const response = await fetch('/create_checkout.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, csrf_token: window.APP_CONFIG.csrfToken })
    });
    
    const { clientSecret } = await response.json();
    
    UI.hideLoading();
    
    // Redirect to payment confirmation page
    window.location.href = `/payment_status.html?payment_intent_client_secret=${clientSecret}`;
    
  } catch (error) {
    UI.hideLoading();
    UI.showToast('Payment setup failed: ' + error.message, 'error');
  }
}

// Handle successful payment return
function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('payment') === 'success') {
    UI.showToast('✅ Payment successful! Your plan is now active', 'success');
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  }
}

// ─────────────────────────────────────────────────────────────
// 7. ERROR HANDLING
// ─────────────────────────────────────────────────────────────

// Global error handler
window.addEventListener('error', (event) => {
  console.error('Error:', event.error);
  UI.showToast('An unexpected error occurred', 'error', 0);
});

// API error handler
async function apiCall(url, options = {}) {
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      if (response.status === 429) {
        UI.showToast('Too many requests. Please try again later.', 'warning');
      } else if (response.status === 401) {
        UI.showToast('Your session expired. Please login again.', 'error');
        location.href = '/';
      } else if (response.status === 403) {
        UI.showToast('Access denied. Please check your permissions.', 'error');
      } else {
        const data = await response.json();
        UI.showToast(data.error || 'Request failed', 'error');
      }
      throw new Error(`API error: ${response.status}`);
    }
    
    return await response.json();
    
  } catch (error) {
    console.error('API error:', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────
// 8. BROADCAST STATE WITH UI
// ─────────────────────────────────────────────────────────────

class BroadcastWithUI {
  constructor() {
    this.isRunning = false;
    this.isPaused = false;
    this.total = 0;
    this.sent = 0;
    this.failed = 0;
  }
  
  async start(recipients, message) {
    this.total = recipients.length;
    this.sent = 0;
    this.failed = 0;
    this.isRunning = true;
    this.isPaused = false;
    
    UI.showLoading(`Starting broadcast to ${this.total} recipients...`);
    
    for (let i = 0; i < recipients.length; i++) {
      if (!this.isRunning) break;
      
      if (this.isPaused) {
        // Wait while paused
        await this.waitForResume();
        if (!this.isRunning) break;
      }
      
      const recipient = recipients[i];
      
      try {
        await this.sendMessage(recipient, message);
        this.sent++;
      } catch (error) {
        this.failed++;
        UI.showToast(`Failed to send to ${recipient.name}: ${error.message}`, 'warning', 2000);
      }
      
      // Update progress
      const progress = Math.round((this.sent / this.total) * 100);
      UI.hideLoading();
      UI.showLoading(`Progress: ${this.sent}/${this.total} (${progress}%)`);
      
      // Delay between messages
      await this.delay(1200);
    }
    
    UI.hideLoading();
    
    if (this.isRunning) {
      UI.showToast(
        `✅ Broadcast complete! Sent: ${this.sent}, Failed: ${this.failed}`,
        this.failed === 0 ? 'success' : 'warning'
      );
    }
    
    this.isRunning = false;
  }
  
  pause() {
    this.isPaused = true;
    UI.showToast('Broadcast paused', 'info');
  }
  
  resume() {
    this.isPaused = false;
    UI.showToast('Broadcast resumed', 'info');
  }
  
  stop() {
    this.isRunning = false;
    UI.showToast('Broadcast stopped', 'warning');
  }
  
  async sendMessage(recipient, message) {
    // Your send logic here
    return fetch('/fb_proxy.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient_id: recipient.id,
        message: message,
        csrf_token: window.APP_CONFIG.csrfToken
      })
    }).then(r => r.json());
  }
  
  async waitForResume() {
    return new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (!this.isPaused) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Usage:
// const broadcast = new BroadcastWithUI();
// await broadcast.start(recipients, messageText);

// ─────────────────────────────────────────────────────────────
// 9. COMPLETE EXAMPLE: SEND BROADCAST
// ─────────────────────────────────────────────────────────────

async function executeBroadcast() {
  // Validate inputs
  const pageSelect = document.getElementById('pageSelect');
  const messageText = document.getElementById('messageText');
  
  if (!pageSelect.value) {
    UI.showToast('Please select a page', 'warning');
    return;
  }
  
  if (!UI.validateField(messageText, 'required')) {
    UI.showToast('Please enter a message', 'error');
    return;
  }
  
  // Confirm action
  const recipients = await getRecipients(pageSelect.value);
  const confirmed = await UI.confirm(
    `Send message to ${recipients.length} recipients?`,
    {
      title: 'Confirm Broadcast',
      okText: 'Send',
      cancelText: 'Cancel'
    }
  );
  
  if (!confirmed) return;
  
  // Execute
  const broadcast = new BroadcastWithUI();
  await broadcast.start(recipients, messageText.value);
}

// ─────────────────────────────────────────────────────────────
// 10. INTEGRATION CHECKLIST
// ─────────────────────────────────────────────────────────────

/**
 * To integrate UI components into your app:
 * 
 * ✅ 1. Ensure ui-components.css is loaded in index.php
 * ✅ 2. Ensure ui-components.js is loaded before web_ui.js
 * ✅ 3. Copy patterns from this file into your code
 * ✅ 4. Test all error scenarios
 * ✅ 5. Test on mobile
 * ✅ 6. Test with screen reader
 * ✅ 7. Monitor console for errors
 * ✅ 8. Gather user feedback
 * ✅ 9. Iterate and improve
 * ✅ 10. Deploy to production!
 */

// ─────────────────────────────────────────────────────────────
// END OF EXAMPLES
// ─────────────────────────────────────────────────────────────
