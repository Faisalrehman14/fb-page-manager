/**
 * Facebook Page Inbox - Customer Support Demo
 * Main JavaScript Module
 */

// =============================================================================
// Global State & Configuration
// =============================================================================

const App = {
    csrfToken: null,
    currentPageId: null,
    currentThreadId: null,
    recipientId: null,
    participantName: null,
    
    // Rate limiting state
    lastMessageTime: 0,
    RATE_LIMIT_MS: 3000,
    
    // Max message length
    MAX_MESSAGE_LENGTH: 2000
};

// =============================================================================
// Utility Functions
// =============================================================================

async function fetchWithAuth(url, options = {}) {
    const defaultOptions = {
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            ...(App.csrfToken ? { 'X-CSRF-Token': App.csrfToken } : {})
        }
    };
    
    const response = await fetch(url, { ...defaultOptions, ...options });
    
    if (response.status === 401) {
        const data = await response.json();
        if (data.redirect) {
            window.location.href = data.redirect;
            return null;
        }
    }
    
    return response;
}

function showError(message, containerId = 'error-container') {
    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = `
            <div class="alert alert-danger">
                <strong>Error:</strong> ${escapeHtml(message)}
            </div>
        `;
        container.classList.remove('hidden');
    }
}

function hideError(containerId = 'error-container') {
    const container = document.getElementById(containerId);
    if (container) {
        container.classList.add('hidden');
    }
}

function showLoading(containerId) {
    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
                <span>Loading...</span>
            </div>
        `;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
}

function formatMessageTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function getUrlParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
}

// =============================================================================
// Authentication Functions
// =============================================================================

async function initCsrfToken() {
    try {
        const response = await fetch('/api/csrf-token', { credentials: 'same-origin' });
        const data = await response.json();
        App.csrfToken = data.csrfToken;
    } catch (error) {
        console.error('Failed to get CSRF token:', error);
    }
}

async function checkAuthStatus() {
    try {
        const response = await fetchWithAuth('/api/auth/status');
        if (!response) return null;
        return await response.json();
    } catch (error) {
        console.error('Auth check failed:', error);
        return { authenticated: false };
    }
}

async function handleFacebookLogin() {
    try {
        const response = await fetchWithAuth('/api/auth/login');
        if (!response) return;
        
        const data = await response.json();
        if (data.authUrl) {
            window.location.href = data.authUrl;
        }
    } catch (error) {
        showError('Failed to initiate login: ' + error.message);
    }
}

async function handleLogout() {
    try {
        const response = await fetchWithAuth('/api/auth/logout', { method: 'POST' });
        if (!response) return;
        
        const data = await response.json();
        if (data.redirect) {
            window.location.href = data.redirect;
        }
    } catch (error) {
        console.error('Logout failed:', error);
        window.location.href = '/';
    }
}

// =============================================================================
// Home Page Functions
// =============================================================================

async function initHomePage() {
    await initCsrfToken();
    
    // Check for error in URL
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');
    if (error) {
        showError(decodeURIComponent(error));
    }
    
    // Check if already logged in
    const authStatus = await checkAuthStatus();
    if (authStatus?.authenticated) {
        window.location.href = '/dashboard.html';
        return;
    }
    
    // Setup login button
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleFacebookLogin);
    }
}

// =============================================================================
// Dashboard Page Functions
// =============================================================================

async function initDashboardPage() {
    await initCsrfToken();
    
    const authStatus = await checkAuthStatus();
    if (!authStatus?.authenticated) {
        window.location.href = '/';
        return;
    }
    
    // Display user name
    const userNameEl = document.getElementById('user-name');
    if (userNameEl && authStatus.userName) {
        userNameEl.textContent = `Welcome, ${authStatus.userName}`;
    }
    
    // Setup logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Setup refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadPages);
    }
    
    // Load pages
    await loadPages();
}

async function loadPages() {
    const listContainer = document.getElementById('page-list');
    showLoading('page-list');
    hideError();
    
    try {
        const response = await fetchWithAuth('/api/pages');
        if (!response) return;
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        if (!data.pages || data.pages.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                    </svg>
                    <h3>No Pages Found</h3>
                    <p>You don't have admin access to any Facebook Pages, or permissions haven't been granted.</p>
                </div>
            `;
            return;
        }
        
        listContainer.innerHTML = data.pages.map(page => `
            <a href="/inbox.html?page_id=${page.id}" class="page-item">
                <img src="${page.picture || '/img/default-page.png'}" 
                     alt="${escapeHtml(page.name)}" 
                     class="page-avatar"
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 font-size=%2232%22>📄</text></svg>'">
                <div class="page-info">
                    <div class="page-name">${escapeHtml(page.name)}</div>
                    <div class="page-id">ID: ${page.id}</div>
                </div>
                <span class="page-arrow">→</span>
            </a>
        `).join('');
        
    } catch (error) {
        console.error('Failed to load pages:', error);
        showError(error.message);
        listContainer.innerHTML = '';
    }
}

// =============================================================================
// Inbox Page Functions
// =============================================================================

async function initInboxPage() {
    await initCsrfToken();
    
    const pageId = getUrlParam('page_id');
    if (!pageId) {
        window.location.href = '/dashboard.html';
        return;
    }
    
    App.currentPageId = pageId;
    
    const authStatus = await checkAuthStatus();
    if (!authStatus?.authenticated) {
        window.location.href = '/';
        return;
    }
    
    // Setup logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Setup refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadConversations);
    }
    
    // Load conversations
    await loadConversations();
}

async function loadConversations() {
    const listContainer = document.getElementById('conversation-list');
    showLoading('conversation-list');
    hideError();
    
    try {
        const response = await fetchWithAuth(`/api/pages/${App.currentPageId}/conversations`);
        if (!response) return;
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        if (!data.conversations || data.conversations.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <h3>No Conversations</h3>
                    <p>This page doesn't have any conversations yet, or no conversations are available for reply.</p>
                </div>
            `;
            return;
        }
        
        listContainer.innerHTML = data.conversations.map(conv => `
            <a href="/thread.html?thread_id=${conv.id}&page_id=${App.currentPageId}&participant_id=${conv.participantId}&participant_name=${encodeURIComponent(conv.participantName)}" 
               class="conversation-item">
                <div class="conversation-avatar">${getInitials(conv.participantName)}</div>
                <div class="conversation-content">
                    <div class="conversation-header">
                        <span class="conversation-name">${escapeHtml(conv.participantName)}</span>
                        <span class="conversation-time">${formatRelativeTime(conv.updatedTime)}</span>
                    </div>
                    <div class="conversation-snippet">${escapeHtml(conv.snippet)}</div>
                </div>
            </a>
        `).join('');
        
    } catch (error) {
        console.error('Failed to load conversations:', error);
        showError(error.message);
        listContainer.innerHTML = '';
    }
}

// =============================================================================
// Thread Page Functions
// =============================================================================

async function initThreadPage() {
    await initCsrfToken();
    
    const threadId = getUrlParam('thread_id');
    const pageId = getUrlParam('page_id');
    const participantId = getUrlParam('participant_id');
    const participantName = getUrlParam('participant_name');
    
    if (!threadId || !pageId) {
        window.location.href = '/dashboard.html';
        return;
    }
    
    App.currentThreadId = threadId;
    App.currentPageId = pageId;
    App.recipientId = participantId;
    App.participantName = participantName ? decodeURIComponent(participantName) : 'Customer';
    
    const authStatus = await checkAuthStatus();
    if (!authStatus?.authenticated) {
        window.location.href = '/';
        return;
    }
    
    // Display participant name
    const participantEl = document.getElementById('participant-name');
    if (participantEl) {
        participantEl.textContent = App.participantName;
    }
    
    // Setup back link
    const backLink = document.getElementById('back-link');
    if (backLink) {
        backLink.href = `/inbox.html?page_id=${pageId}`;
    }
    
    // Setup message input
    setupMessageInput();
    
    // Load messages
    await loadMessages();
}

async function loadMessages() {
    const container = document.getElementById('messages-container');
    showLoading('messages-container');
    hideError('compose-error');
    
    try {
        const response = await fetchWithAuth(
            `/api/threads/${App.currentThreadId}/messages?pageId=${App.currentPageId}`
        );
        if (!response) return;
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        if (!data.messages || data.messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <h3>No Messages</h3>
                    <p>This conversation doesn't have any messages yet.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = data.messages.map(msg => `
            <div class="message ${msg.isFromPage ? 'message-outgoing' : 'message-incoming'}">
                <div class="message-text">${escapeHtml(msg.text)}</div>
                <div class="message-time">${formatMessageTime(msg.createdTime)}</div>
            </div>
        `).join('');
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
        
    } catch (error) {
        console.error('Failed to load messages:', error);
        showError(error.message);
        container.innerHTML = '';
    }
}

function setupMessageInput() {
    const textarea = document.getElementById('message-input');
    const charCount = document.getElementById('char-count');
    const sendBtn = document.getElementById('send-btn');
    
    if (!textarea || !sendBtn) return;
    
    // Character count
    textarea.addEventListener('input', () => {
        const length = textarea.value.length;
        charCount.textContent = `${length}/${App.MAX_MESSAGE_LENGTH}`;
        
        if (length > App.MAX_MESSAGE_LENGTH) {
            charCount.classList.add('danger');
            charCount.classList.remove('warning');
        } else if (length > App.MAX_MESSAGE_LENGTH * 0.9) {
            charCount.classList.add('warning');
            charCount.classList.remove('danger');
        } else {
            charCount.classList.remove('warning', 'danger');
        }
        
        // Enable/disable send button
        sendBtn.disabled = length === 0 || length > App.MAX_MESSAGE_LENGTH;
    });
    
    // Auto-resize textarea
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });
    
    // Send on Enter (without Shift)
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) {
                sendMessage();
            }
        }
    });
    
    // Send button click
    sendBtn.addEventListener('click', sendMessage);
}

async function sendMessage() {
    const textarea = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const errorContainer = document.getElementById('compose-error');
    
    const message = textarea.value.trim();
    
    if (!message) {
        showError('Please enter a message', 'compose-error');
        return;
    }
    
    if (message.length > App.MAX_MESSAGE_LENGTH) {
        showError(`Message exceeds ${App.MAX_MESSAGE_LENGTH} characters`, 'compose-error');
        return;
    }
    
    // Client-side rate limit check
    const now = Date.now();
    const timeSinceLast = now - App.lastMessageTime;
    if (timeSinceLast < App.RATE_LIMIT_MS) {
        const waitTime = Math.ceil((App.RATE_LIMIT_MS - timeSinceLast) / 1000);
        showError(`Please wait ${waitTime} seconds before sending another message`, 'compose-error');
        return;
    }
    
    // Disable UI during send
    sendBtn.disabled = true;
    textarea.disabled = true;
    hideError('compose-error');
    
    try {
        const response = await fetchWithAuth(`/api/threads/${App.currentThreadId}/reply`, {
            method: 'POST',
            body: JSON.stringify({
                pageId: App.currentPageId,
                recipientId: App.recipientId,
                message: message
            })
        });
        
        if (!response) return;
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Success!
        App.lastMessageTime = Date.now();
        textarea.value = '';
        textarea.style.height = 'auto';
        document.getElementById('char-count').textContent = `0/${App.MAX_MESSAGE_LENGTH}`;
        
        // Add message to UI optimistically
        const container = document.getElementById('messages-container');
        const messageHtml = `
            <div class="message message-outgoing">
                <div class="message-text">${escapeHtml(message)}</div>
                <div class="message-time">Just now</div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', messageHtml);
        container.scrollTop = container.scrollHeight;
        
        // Show success briefly
        errorContainer.innerHTML = `
            <div class="alert alert-success">Message sent successfully!</div>
        `;
        errorContainer.classList.remove('hidden');
        setTimeout(() => {
            errorContainer.classList.add('hidden');
        }, 3000);
        
    } catch (error) {
        console.error('Failed to send message:', error);
        showError(error.message, 'compose-error');
    } finally {
        sendBtn.disabled = false;
        textarea.disabled = false;
        textarea.focus();
    }
}

// =============================================================================
// Initialize Based on Current Page
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    
    if (path === '/' || path === '/index.html') {
        initHomePage();
    } else if (path === '/dashboard.html') {
        initDashboardPage();
    } else if (path === '/inbox.html') {
        initInboxPage();
    } else if (path === '/thread.html') {
        initThreadPage();
    }
});
