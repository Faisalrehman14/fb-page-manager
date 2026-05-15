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
    socket: null,
    pollInterval: null,
    lastMessageDate: null,
    isConnected: false,
    socketConnectedOnce: false,

    initSocket(pageId, threadId) {
        if (this.socket) {
            if (pageId) this.socket.emit('join_page', pageId);
            if (threadId) this.socket.emit('join_thread', threadId);
            return;
        }
        if (typeof io === 'undefined') return;

        console.log('Socket: Initializing connection...');
        this.socket = io({
            transports: ['websocket', 'polling'],
            upgrade: true,
            reconnection: true,
            reconnectionAttempts: 50,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        this.socket.on('connect_error', () => {
            this.isConnected = false;
            this.updateConnectionStatus(false);
        });

        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.updateConnectionStatus(false);
        });

        this.socket.on('reconnect_failed', () => {
            this.isConnected = false;
            this.updateConnectionStatus(false);
        });

        this.socket.on('connect', () => {
            this.isConnected = true;
            this.updateConnectionStatus(true);

            if (pageId) this.socket.emit('join_page', pageId);
            if (threadId) this.socket.emit('join_thread', threadId);

            if (this.currentThreadId) {
                loadMessages(true);
            } else if (window.location.pathname.includes('inbox.html')) {
                // On reconnect only: refresh badges/snippets without full re-render
                // (avoids race where stale DB data wipes socket-set badge)
                if (this.socketConnectedOnce) refreshUnreadIndicators();
                this.socketConnectedOnce = true;
            }
        });

        this.socket.on('new_message', (msg) => {
            // Only play sound for INCOMING customer messages when NOT viewing this thread
            if (!msg.isFromPage && this.currentThreadId !== msg.threadId) {
                playNotificationSound();
            }

            // If we're viewing this thread, append the message and mark as read
            if (this.currentThreadId === msg.threadId) {
                appendMessage(msg);
                fetchWithAuth(`/api/threads/${msg.threadId}/read`, {
                    method: 'POST',
                    body: JSON.stringify({ pageId: App.currentPageId })
                }).catch(() => {});
            }
        });

        this.socket.on('conversation_updated', (data) => {
            const item = document.querySelector(`[data-conv-id="${data.id}"]`);

            // Show toast and play sound only when NOT viewing this conversation
            if (!data.isRead && data.isLive && this.currentThreadId !== data.id) {
                showToast(`New message from ${data.participantName || 'Customer'}`);
                playNotificationSound();
            }

            // Update browser tab title with notification badge
            if (!document.hasFocus() && !data.isRead) {
                let unreadCount = parseInt(document.title.match(/\((\d+)\)/)?.[1] || '0');
                document.title = `(${unreadCount + 1}) Page Inbox - New Messages`;
            }

            if (item) {
                // Only update snippet and time when a new message arrived (data.snippet present)
                if (data.snippet != null) {
                    const snippet = item.querySelector('.conversation-snippet');
                    if (snippet) snippet.textContent = data.snippet;

                    const time = item.querySelector('.conversation-time');
                    if (time) time.textContent = 'Just now';
                }

                // Update Unread State
                if (!data.isRead) {
                    item.classList.add('unread');
                    // Update or create unread count badge
                    let badge = item.querySelector('.unread-badge');
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.className = 'unread-badge';
                        item.appendChild(badge);
                    }
                    const count = data.unreadCount || 0;
                    badge.textContent = count > 0 ? count : '•';
                    // Flash animation for new message notification
                    item.style.animation = 'highlightNew 1s ease';
                    setTimeout(() => item.style.animation = '', 1000);
                } else if (!data.fromEcho) {
                    // Only clear badge when support agent explicitly reads the conversation
                    // (mark-as-read or reply via our app). Echo events from auto-replies or
                    // native FB UI must NOT clear the badge — agent hasn't read it yet.
                    item.classList.remove('unread');
                    const badge = item.querySelector('.unread-badge');
                    if (badge) badge.remove();
                }

                // Update Badge to LIVE
                const badge = item.querySelector('.badge');
                if (badge) {
                    badge.className = 'badge badge-live';
                    badge.textContent = 'Live';
                }

                // Prepend to list for sorting
                const container = document.getElementById('conversation-list');
                if (container && container.firstChild !== item) {
                    item.style.animation = 'highlightNew 1.5s ease';
                    container.prepend(item);
                }
            } else if (window.location.pathname.includes('inbox.html')) {
                const container = document.getElementById('conversation-list');
                if (container && data.participantId) {
                    // Inject directly from socket data — no spinner, no API call
                    const isUnread = !data.isRead;
                    const count = data.unreadCount || 0;
                    const newItem = document.createElement('a');
                    newItem.href = `/thread.html?page_id=${App.currentPageId}&thread_id=${data.id}&participant=${encodeURIComponent(data.participantName || 'Customer')}&recipient=${data.participantId}`;
                    newItem.className = `conversation-item${isUnread ? ' unread' : ''}`;
                    newItem.dataset.convId = data.id;
                    newItem.innerHTML = `
                        <div class="conversation-avatar">${(data.participantName || 'C').charAt(0).toUpperCase()}</div>
                        <div class="conversation-details">
                            <div class="conversation-header">
                                <span class="conversation-name">${escapeHtml(data.participantName || 'Customer')}<span class="badge badge-live">Live</span></span>
                                <span class="conversation-time">Just now</span>
                            </div>
                            <div class="conversation-snippet">${escapeHtml(data.snippet || '')}</div>
                        </div>
                        ${isUnread ? `<div class="unread-badge">${count > 0 ? count : '•'}</div>` : ''}
                    `;
                    newItem.style.animation = 'highlightNew 1.5s ease';
                    container.insertBefore(newItem, container.firstChild);
                } else {
                    // Fallback if we somehow have no participantId
                    refreshUnreadIndicators();
                }
            } else if (window.location.pathname.includes('thread.html')) {
                // Only notify if it's a different conversation and it's unread
                if (data.id !== App.currentThreadId && !data.isRead) {
                    showToast(`New message in another conversation`);
                }
            }

            // If not in this thread, update badge
            if (this.currentThreadId !== data.id && !data.isRead) {
                // DOM is already updated above — getUnreadCount() includes the new item
                const headerTitle = document.querySelector('.header h1');
                if (headerTitle && !headerTitle.textContent.includes('(')) {
                    headerTitle.textContent = `Page Inbox (${getUnreadCount()})`;
                }
            }
        });
    },

    updateConnectionStatus(online) {
        let statusDot = document.getElementById('connection-status-dot');
        if (!statusDot) {
            statusDot = document.createElement('div');
            statusDot.id = 'connection-status-dot';
            document.body.appendChild(statusDot);
        }
        statusDot.className = online ? 'status-online' : 'status-offline';
        statusDot.title = online ? 'Connected' : 'Reconnecting...';
    },
    
    // Rate limiting state
    lastMessageTime: 0,
    RATE_LIMIT_MS: 3000,
    
    // Max message length
    MAX_MESSAGE_LENGTH: 2000
};

// Reset tab title when user focuses window
window.addEventListener('focus', () => {
    document.title = 'Page Inbox';
});

// Clean up polling intervals to prevent memory leaks
window.addEventListener('beforeunload', () => {
    if (App.pollInterval) clearInterval(App.pollInterval);
    if (App.unreadPollInterval) clearInterval(App.unreadPollInterval);
});

let lastSoundTime = 0;
function playNotificationSound() {
    const now = Date.now();
    // 3-second cooldown to prevent sound spam
    if (now - lastSoundTime < 3000) return;
    lastSoundTime = now;
    
    try {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3');
        audio.volume = 0.4;
        audio.play().catch(() => {}); // Browser might block if no user interaction
    } catch (e) {}
}

function showToast(msg) {
    // Remove any existing toast first
    const existingToast = document.querySelector('.toast-notification');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.innerHTML = `
        <div class="toast-icon">🔔</div>
        <div class="toast-content">
            <strong>New Message</strong>
            <p>${msg}</p>
        </div>
    `;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto dismiss after 5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

// =============================================================================
// Utility Functions
// =============================================================================

async function fetchWithAuth(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const mergedOptions = {
            credentials: 'same-origin',
            signal: controller.signal,
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(App.csrfToken ? { 'X-CSRF-Token': App.csrfToken } : {}),
                ...(options.headers || {})
            }
        };

        const response = await fetch(url, mergedOptions);
        clearTimeout(timeoutId);

        if (response.status === 401) {
            const data = await response.json();
            if (data.redirect) {
                window.location.href = data.redirect;
                return null;
            }
        }

        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error(`fetchWithAuth: timeout — ${url}`);
            throw new Error('Request timed out. Please check your connection.');
        }
        console.error(`fetchWithAuth: network error — ${url}:`, err.message);
        throw err;
    }
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

function getUnreadCount() {
    const unreadItems = document.querySelectorAll('.conversation-item.unread');
    return unreadItems.length;
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
    const loginBtn = document.getElementById('login-btn');
    if (!loginBtn) return;

    const originalText = loginBtn.innerHTML;
    loginBtn.disabled = true;
    loginBtn.innerHTML = `
        <div class="loading-spinner" style="width:16px; height:16px; border-width:2px; display:inline-block; vertical-align:middle; margin-right:8px;"></div>
        Connecting...
    `;

    try {
        const response = await fetchWithAuth('/api/auth/login');
        if (!response) {
            loginBtn.disabled = false;
            loginBtn.innerHTML = originalText;
            return;
        }

        const data = await response.json();
        if (data.authUrl) {
            window.location.href = data.authUrl;
        } else {
            throw new Error('Authentication URL not received');
        }
    } catch (error) {
        console.error('Login failed:', error);
        showError('Could not start Facebook login. Please try again.');
        loginBtn.disabled = false;
        loginBtn.innerHTML = originalText;
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

    // Setup sync all button
    const syncAllBtn = document.getElementById('sync-all-btn');
    if (syncAllBtn) {
        syncAllBtn.addEventListener('click', async () => {
            syncAllBtn.disabled = true;
            const originalText = syncAllBtn.innerHTML;
            syncAllBtn.innerHTML = 'Syncing...';
            
            try {
                const response = await fetchWithAuth('/api/sync/all', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    showToast('Background sync started. Your history will appear shortly!');
                } else {
                    throw new Error(data.error);
                }
            } catch (err) {
                showError('Sync failed: ' + err.message);
            } finally {
                syncAllBtn.innerHTML = originalText;
                syncAllBtn.disabled = false;
            }
        });
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
        if (!response) {
            listContainer.innerHTML = `
                <div class="empty-state">
                    <h3>Failed to load pages</h3>
                    <p>Please refresh and try again</p>
                    <button class="btn btn-primary" onclick="location.reload()">Refresh</button>
                </div>
            `;
            return;
        }

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
        listContainer.innerHTML = `
            <div class="empty-state">
                <h3>Error</h3>
                <p>${escapeHtml(error.message)}</p>
                <button class="btn btn-primary" onclick="loadPages()">Try Again</button>
            </div>
        `;
    }
}

// =============================================================================
// Inbox Page Functions
// =============================================================================

async function refreshUnreadIndicators() {
    if (!App.currentPageId) return;
    try {
        const response = await fetchWithAuth(`/api/pages/${App.currentPageId}/conversations`);
        if (!response) return;
        const data = await response.json();
        if (!data.conversations) return;

        const container = document.getElementById('conversation-list');
        if (!container) return;

        const domItems = {};
        container.querySelectorAll('[data-conv-id]').forEach(item => {
            domItems[item.dataset.convId] = item;
        });

        data.conversations.forEach(conv => {
            const isUnread = !conv.isRead;
            const existing = domItems[conv.id];

            if (existing) {
                // Always sync snippet from DB (keeps it fresh)
                const snippetEl = existing.querySelector('.conversation-snippet');
                if (snippetEl && conv.snippet) snippetEl.textContent = conv.snippet;

                // POLL ONLY ADDS unread badges — never removes them.
                // Removal is handled exclusively by socket events (thread open / reply)
                // so the poll can never race against a pending background DB write.
                if (isUnread) {
                    existing.classList.add('unread');
                    let badge = existing.querySelector('.unread-badge');
                    if (!badge) {
                        badge = document.createElement('div');
                        badge.className = 'unread-badge';
                        existing.appendChild(badge);
                    }
                    // Prefer a real count, fallback to bullet so badge is always visible
                    badge.textContent = conv.unreadCount > 0 ? conv.unreadCount : '•';
                }
                // isRead === true: do nothing — trust the current DOM state
            } else if (isUnread) {
                // Unread conversation not in DOM yet — inject it
                const timeStr = formatRelativeTime(conv.updatedTime);
                const count = conv.unreadCount || 0;
                const newItem = document.createElement('a');
                newItem.href = `/thread.html?page_id=${conv.pageId}&thread_id=${conv.id}&participant=${encodeURIComponent(conv.participantName || 'Customer')}&recipient=${conv.participantId}`;
                newItem.className = 'conversation-item unread';
                newItem.dataset.convId = conv.id;
                newItem.innerHTML = `
                    <div class="conversation-avatar">${(conv.participantName || 'C').charAt(0).toUpperCase()}</div>
                    <div class="conversation-details">
                        <div class="conversation-header">
                            <span class="conversation-name">${escapeHtml(conv.participantName || 'Customer')}<span class="badge badge-live">Live</span></span>
                            <span class="conversation-time">${timeStr}</span>
                        </div>
                        <div class="conversation-snippet">${escapeHtml(conv.snippet || '')}</div>
                    </div>
                    <div class="unread-badge">${count > 0 ? count : '•'}</div>
                `;
                container.insertBefore(newItem, container.firstChild);
            }
        });
    } catch (e) {
        console.warn('refreshUnreadIndicators error:', e.message);
    }
}

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
    
    // Load conversations
    await loadConversations();

    // Refresh unread indicators after first load
    await refreshUnreadIndicators();

    // Poll every 15 seconds as socket fallback for unread marks
    App.unreadPollInterval = setInterval(() => {
        if (!document.hidden) refreshUnreadIndicators();
    }, 15000);

    // Real-time inbox updates
    App.initSocket(pageId);
}

async function loadConversations(silent = false) {
    const listContainer = document.getElementById('conversation-list');
    if (!silent) {
        showLoading('conversation-list');
        hideError();
    }

    try {
        const response = await fetchWithAuth(`/api/pages/${App.currentPageId}/conversations`);
        if (!response) return;

        const data = await response.json();

        if (data.error) {
            if (data.tokenMissing && !silent) {
                listContainer.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <h3>Session Expired</h3>
                        <p>Please reload your pages from dashboard.</p>
                        <a href="/dashboard.html" class="btn btn-primary" style="text-decoration:none; margin-top:12px;">Go to Dashboard</a>
                    </div>
                `;
            } else if (!silent) {
                listContainer.innerHTML = `
                    <div class="empty-state">
                        <h3>Error</h3>
                        <p>${escapeHtml(data.error)}</p>
                        <button class="btn btn-primary" onclick="loadConversations()">Try Again</button>
                    </div>
                `;
            }
            return;
        }

        if (!data.conversations || data.conversations.length === 0) {
            if (!silent) {
                listContainer.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        <h3>No Conversations</h3>
                        <p>This page doesn't have any conversations yet.</p>
                    </div>
                `;
            }
            return;
        }

        // Capture socket-set state before re-rendering to survive stale DB cache
        // (webhook background writes take a few ms; DB may still show old data)
        const socketState = new Map();
        document.querySelectorAll('.conversation-item[data-conv-id]').forEach(el => {
            const timeEl = el.querySelector('.conversation-time');
            const justNow = timeEl?.textContent === 'Just now';
            const unread = el.classList.contains('unread');
            if (justNow || unread) {
                const badge = el.querySelector('.unread-badge');
                const snippetEl = el.querySelector('.conversation-snippet');
                socketState.set(el.dataset.convId, {
                    justNow,
                    unread,
                    badgeText: badge?.textContent || null,
                    snippet: justNow && snippetEl ? snippetEl.textContent : null
                });
            }
        });

        const fromCache = data.fromCache || false;
        const html = data.conversations.map(conv => {
            const isUnread = !conv.isRead;
            const count = conv.unreadCount || 0;
            const timeStr = formatRelativeTime(conv.updatedTime);

            // Build snippet - only show "You:" when page sent the last message
            let snippetText = conv.snippet || 'No messages';
            let senderPrefix = '';
            if (conv.lastMessageFromPage) {
                senderPrefix = '<span class="sender you">You: </span>';
            }

            return `
                <a href="/thread.html?page_id=${conv.pageId}&thread_id=${conv.id}&participant=${encodeURIComponent(conv.participantName || 'Customer')}&recipient=${conv.participantId}"
                   class="conversation-item ${isUnread ? 'unread' : ''}" data-conv-id="${conv.id}">
                    <div class="conversation-avatar">
                        ${getInitials(conv.participantName)}
                    </div>
                    <div class="conversation-details">
                        <div class="conversation-header">
                            <span class="conversation-name">
                                ${escapeHtml(conv.participantName || 'Customer')}
                                <span class="badge ${fromCache ? 'badge-saved' : 'badge-live'}">
                                    ${fromCache ? 'Saved' : 'Live'}
                                </span>
                            </span>
                            <span class="conversation-time">${timeStr}</span>
                        </div>
                        <div class="conversation-snippet">${senderPrefix}${escapeHtml(snippetText)}</div>
                    </div>
                    ${isUnread ? `<div class="unread-badge">${count > 0 ? count : '•'}</div>` : ''}
                </a>
            `;
        }).join('');

        listContainer.innerHTML = html;

        // Update stats if they exist on the page
        const totalEl = document.getElementById('total-count');
        const unreadEl = document.getElementById('unread-count');
        if (totalEl && unreadEl) {
            totalEl.textContent = data.conversations.length;
            let unread = 0;
            data.conversations.forEach(c => { if (!c.isRead) unread++; });
            unreadEl.textContent = unread;
        }

        // Restore socket-set state that DB hasn't persisted yet
        socketState.forEach((state, id) => {
            const el = document.querySelector(`[data-conv-id="${id}"]`);
            if (!el) return;
            if (state.justNow) {
                const t = el.querySelector('.conversation-time');
                if (t) t.textContent = 'Just now';
                if (state.snippet) {
                    const s = el.querySelector('.conversation-snippet');
                    if (s) s.textContent = state.snippet;
                }
            }
            if (state.unread) {
                el.classList.add('unread');
                let badge = el.querySelector('.unread-badge');
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'unread-badge';
                    el.appendChild(badge);
                }
                if (state.badgeText) badge.textContent = state.badgeText;
            }
        });

    } catch (error) {
        console.error('Failed to load conversations:', error);
        if (!silent) {
            listContainer.innerHTML = `
                <div class="empty-state">
                    <h3>Error</h3>
                    <p>${escapeHtml(error.message)}</p>
                    <button class="btn btn-primary" onclick="loadConversations()">Try Again</button>
                </div>
            `;
        }
    }
}

// =============================================================================
// Thread Page Functions
// =============================================================================

async function initThreadPage() {
    await initCsrfToken();
    
    const threadId = getUrlParam('thread_id');
    const pageId = getUrlParam('page_id');
    const participantId = getUrlParam('recipient');
    const participantName = getUrlParam('participant');
    
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

    // Mark as read and clear inbox badge via socket
    fetchWithAuth(`/api/threads/${threadId}/read`, {
        method: 'POST',
        body: JSON.stringify({ pageId })
    }).catch(() => {});

    // Load messages
    await loadMessages();

    // Real-time updates
    App.initSocket(pageId, threadId);

    // Polling fallback: refresh messages every 15 seconds (socket handles real-time)
    App.pollInterval = setInterval(pollNewMessages, 15000);
}

function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    // Avoid duplicates
    if (msg.id && document.querySelector(`[data-msg-id="${msg.id}"]`)) return;

    // Date Separation
    if (msg.createdTime && msg.createdTime !== 'Just now') {
        const msgDate = new Date(msg.createdTime).toLocaleDateString();
        if (msgDate !== App.lastMessageDate) {
            const dateDiv = document.createElement('div');
            dateDiv.className = 'date-separator';
            dateDiv.innerHTML = `<span>${formatDateLabel(msg.createdTime)}</span>`;
            container.appendChild(dateDiv);
            App.lastMessageDate = msgDate;
        }
    }

    const div = document.createElement('div');
    div.className = `message ${msg.isFromPage ? 'message-outgoing' : 'message-incoming'}`;
    if (msg.id) div.dataset.msgId = msg.id;
    const senderLabel = msg.isFromPage ? 'You' : (App.participantName || 'Customer');
    const senderPrefix = msg.isFromPage ? 'You: ' : `${senderLabel}: `;

    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
        attachmentsHtml = msg.attachments.map(a => {
            if (a.t === 'image') {
                return `<div class="msg-attachment"><img src="${escapeHtml(a.u)}" class="msg-img" loading="lazy" onerror="this.style.display='none'" onclick="window.open('${escapeHtml(a.u)}','_blank')"></div>`;
            }
            if (a.t === 'video') {
                return `<div class="msg-attachment"><video src="${escapeHtml(a.u)}" controls class="msg-video" preload="metadata"></video></div>`;
            }
            const label = a.n ? escapeHtml(a.n) : escapeHtml(a.t || 'File');
            return `<div class="msg-attachment"><a href="${escapeHtml(a.u)}" target="_blank" rel="noopener" class="msg-file">📎 ${label}</a></div>`;
        }).join('');
    }

    const textHtml = msg.text && msg.text !== `[${(msg.attachments || [])[0]?.t}]`
        ? `<div class="message-text"><strong>${escapeHtml(senderPrefix)}</strong>${escapeHtml(msg.text)}</div>`
        : (attachmentsHtml ? `<div class="message-text message-text-small"><strong>${escapeHtml(senderPrefix)}</strong></div>` : `<div class="message-text"><strong>${escapeHtml(senderPrefix)}</strong>${escapeHtml(msg.text)}</div>`);

    div.innerHTML = `
        <div class="message-sender">${escapeHtml(senderLabel)}</div>
        ${textHtml}
        ${attachmentsHtml}
        <div class="message-time">${msg.createdTime === 'Just now' ? 'Just now' : formatMessageTime(msg.createdTime)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function formatDateLabel(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toLocaleDateString() === today.toLocaleDateString()) return 'Today';
    if (date.toLocaleDateString() === yesterday.toLocaleDateString()) return 'Yesterday';
    
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

async function pollNewMessages() {
    try {
        const response = await fetchWithAuth(
            `/api/threads/${App.currentThreadId}/messages?pageId=${App.currentPageId}`
        );
        if (!response) return;
        const data = await response.json();
        if (!data.messages) return;

        data.messages.forEach(msg => appendMessage(msg));
    } catch (e) {
        console.warn('pollNewMessages error:', e.message);
    }
}

async function loadMessages(silent = false) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    if (!silent) {
        showLoading('messages-container');
    }
    
    try {
        const response = await fetchWithAuth(
            `/api/threads/${App.currentThreadId}/messages?pageId=${App.currentPageId}`
        );
        if (!response) return;
        
        const data = await response.json();
        
        if (data.error) {
            return;
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
        
        container.innerHTML = '';
        App.lastMessageDate = null; // Reset for new thread
        data.messages.forEach(msg => appendMessage(msg));
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

        // Optimistically show message (socket will also receive it but dedup handles it)
        appendMessage({
            id: data.messageId || `local_${Date.now()}`,
            text: message,
            isFromPage: true,
            createdTime: 'Just now'
        });

        // Mark conversation as read after sending reply
        fetchWithAuth(`/api/threads/${App.currentThreadId}/read`, {
            method: 'POST',
            body: JSON.stringify({ pageId: App.currentPageId })
        }).catch(() => {});

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
        // New unified inbox has its own Inbox controller — skip legacy init to prevent
        // duplicate sockets, duplicate event listeners, and redundant API calls.
        if (typeof Inbox === 'undefined') {
            initInboxPage();
        }
    } else if (path === '/thread.html') {
        initThreadPage();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Inbox Controller — extracted from inbox.html inline script
// Integrated into main site: auth via fb-token bridge, no page redirects
// ═══════════════════════════════════════════════════════════════════════════
const EMOJIS = ['😊','😂','❤️','👍','🙏','😭','🔥','✅','⭐','🎉','😅','👋','💯','🤔','😍','🙌','💪','😁','🥰','😎','👏','🤝','😢','💔','😡','🤣','😮','🤩','💡','📌','✨','🎯','🚀','💬','📞','⚡','🛡️','📊','🔔','💎','🙄','😴','🤦','🤷'];

// ── Favicon badge (shows unread count on browser tab icon) ──
let _faviconCanvas = null, _faviconCtx = null, _faviconImg = null, _faviconLoaded = false, _lastBadge = -1;
function updateFaviconBadge(count) {
    if (count === _lastBadge) return;
    _lastBadge = count;
    if (!_faviconCanvas) {
        _faviconCanvas = document.createElement('canvas');
        _faviconCanvas.width = _faviconCanvas.height = 32;
        _faviconCtx = _faviconCanvas.getContext('2d');
        _faviconImg = new Image();
        _faviconImg.src = '/favicon.ico';
        _faviconImg.onload = () => { _faviconLoaded = true; updateFaviconBadge(_lastBadge); };
    }
    if (!_faviconLoaded && count > 0) return;
    const ctx = _faviconCtx;
    ctx.clearRect(0, 0, 32, 32);
    if (_faviconLoaded) ctx.drawImage(_faviconImg, 0, 0, 32, 32);
    if (count > 0) {
        const label = count > 99 ? '99+' : String(count);
        const r = label.length > 2 ? 10 : 8;
        ctx.beginPath(); ctx.arc(24, 8, r, 0, 2 * Math.PI);
        ctx.fillStyle = '#e53935'; ctx.fill();
        ctx.font = `bold ${r < 10 ? 11 : 9}px sans-serif`;
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, 24, 8);
    }
    let link = document.querySelector("link[rel~='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = count > 0 ? _faviconCanvas.toDataURL() : '/favicon.ico';
    document.title = count > 0 ? `(${count}) Page Inbox` : 'Page Inbox';
}


const Inbox = {
    pages: [],
    selectedPageId: null,
    conversations: [],
    selectedConvId: null,
    participantName: 'Customer',
    participantId: null,
    socket: null,
    filter: 'all',
    searchQuery: '',
    cannedReplies: [],
    soundEnabled: true,
    atBottom: true,
    newMsgCount: 0,
    _editingCannedId: null,
    _lastTempMsgId: null,
    _msgCache: {},
    _cacheTime: {},
    _convOffset: {},
    _convHasMore: {},
    _convObserver: null,
    _searchResults: null,
    _searchTimer: null,

    async init() {
        this.soundEnabled = localStorage.getItem('sound') !== 'false';
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        if (!this.soundEnabled) document.getElementById('sound-btn')?.classList.remove('active');

        await initCsrfToken();
        const auth = await checkAuthStatus();
        if (!auth?.authenticated) { if (window.location.pathname.includes('inbox.html')) window.location.href = '/'; return; }

        document.getElementById('logout-btn')?.addEventListener('click', handleLogout);

        document.getElementById('conv-search')?.addEventListener('input', e => {
            const q = e.target.value.trim();
            this.searchQuery = q.toLowerCase();
            clearTimeout(this._searchTimer);
            if (!q) {
                this._searchResults = null;
                this.renderConversations();
                return;
            }
            // Show local matches instantly, then fetch server results after 300ms
            this.renderConversations();
            this._searchTimer = setTimeout(() => this._serverSearch(q), 300);
        });

        this.initSocket();
        await this.loadPages();
        await this.loadCannedReplies();

        // Close dropdowns on outside click
        document.addEventListener('click', e => {
            if (!e.target.closest('#emoji-picker') && !e.target.closest('.compose-icon-btn[data-emoji]'))
                this.hideEmoji();
            if (!e.target.closest('#canned-panel') && !e.target.closest('#message-input') && !e.target.closest('[data-canned]'))
                this.hideCannedPanel();
            if (!e.target.closest('.canned-item-more-wrap'))
                document.querySelectorAll('.canned-dropdown').forEach(d => d.classList.add('hidden'));
        });

        // Keyboard shortcut: Escape closes panels
        // Global keyboard shortcuts
        document.addEventListener('keydown', e => {
            const tag = document.activeElement?.tagName;
            const inInput = tag === 'TEXTAREA' || tag === 'INPUT';

            if (e.key === 'Escape') {
                this.hideEmoji(); this.hideCannedPanel(); this.hideSavedReplyPreview();
                return;
            }
            if (inInput) return; // don't hijack shortcuts while typing

            if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault(); this._navigateConv(1);
            } else if (e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault(); this._navigateConv(-1);
            } else if (e.key === 'r') {
                document.getElementById('message-input')?.focus();
            } else if (e.key === '/') {
                e.preventDefault(); document.getElementById('conv-search')?.focus();
            } else if (e.key === 'u') {
                // u = mark current as unread
                if (this.selectedConvId) this.markUnread(this.selectedConvId);
            } else if (e.key === 'e') {
                // e = archive current
                if (this.selectedConvId) this.archiveConv(this.selectedConvId);
            }
        });

        // Auto-refresh conversations when tab regains focus
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.selectedPageId) {
                this._refreshConversations(this.selectedPageId);
                if (this.selectedConvId) this._silentRefresh(this.selectedConvId);
            }
        });

        // Request browser notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Show bulk-bar when there are unread conversations
        this._updateBulkBar();
    },

    _updateBulkBar() {
        const hasUnread = this.conversations.some(c => !c.isRead);
        const bar = document.getElementById('bulk-bar');
        if (bar) bar.style.display = hasUnread ? 'flex' : 'none';
    },

    _navigateConv(dir) {
        const list = this.getFiltered();
        if (!list.length) return;
        const idx = list.findIndex(c => c.id === this.selectedConvId);
        const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
        if (next && next.id !== this.selectedConvId) {
            this.selectConv(next.id, encodeURIComponent(next.participantName || 'Customer'), next.participantId || '');
            document.querySelector(`.conv-item[data-conv-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
        }
    },

    initSocket() {
        if (typeof io === 'undefined') return;
        this.socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 50, reconnectionDelay: 1000 });

        this.socket.on('connect', () => {
            if (this.selectedPageId) this.socket.emit('join_page', this.selectedPageId);
            if (this.selectedConvId) {
                this.socket.emit('join_thread', this.selectedConvId);
                // Pick up any messages that arrived while disconnected
                if (this._msgCache[this.selectedConvId]) this._silentRefresh(this.selectedConvId);
            }
            this.setSyncStatus('connected');
        });

        this.socket.on('disconnect', () => this.setSyncStatus('disconnected'));

        this.socket.on('new_message', msg => {
            if (!msg.isFromPage) {
                // Sound
                if (this.soundEnabled && this.selectedConvId !== msg.threadId) {
                    try { playNotificationSound(); } catch(e) {}
                }
                // Browser notification (only when tab is hidden or different conv active)
                if (document.hidden || this.selectedConvId !== msg.threadId) {
                    this._showBrowserNotif(msg);
                }
                // Favicon badge
                const totalUnread = this.conversations.filter(c => !c.isRead).length + 1;
                updateFaviconBadge(totalUnread);
            }
            if (this.selectedConvId === msg.threadId) {
                if (msg.isFromPage && this._lastTempMsgId) {
                    const tempEl = document.querySelector(`[data-msg-id="${this._lastTempMsgId}"]`);
                    if (tempEl) {
                        if (msg.id) tempEl.setAttribute('data-msg-id', msg.id);
                        this._lastTempMsgId = null;
                    } else {
                        this.appendMessage(msg);
                    }
                } else {
                    this.appendMessage(msg);
                }
                fetchWithAuth(`/api/threads/${msg.threadId}/read`, {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ pageId: this.selectedPageId })
                }).catch(() => {});
            }
        });

        this.socket.on('conversation_updated', data => {
            if (data.pageId === this.selectedPageId) this.handleConvUpdate(data);
            if (data.pageId) this.updatePageBadge(data.pageId);
        });

        this.socket.on('agent_typing', data => {
            if (data.threadId !== this.selectedConvId) return;
            const el = document.getElementById('typing-indicator');
            const lbl = document.getElementById('typing-label');
            if (!el) return;
            if (data.typing) {
                if (lbl) lbl.textContent = `${data.agentName || 'Agent'} is typing...`;
                el.classList.add('visible');
                clearTimeout(this._typingHideTimer);
                this._typingHideTimer = setTimeout(() => el.classList.remove('visible'), 5000);
            } else {
                el.classList.remove('visible');
            }
        });

        this.socket.on('note_added', data => {
            if (data.threadId === this.selectedConvId) this.loadNotes(data.threadId);
        });
        this.socket.on('note_deleted', data => {
            if (data.threadId === this.selectedConvId) {
                document.querySelector(`.note-item[data-note-id="${data.noteId}"]`)?.remove();
            }
        });

        this.socket.on('all_read', data => {
            if (data.pageId === this.selectedPageId) {
                this.conversations.forEach(c => { c.isRead = true; c.unreadCount = 0; });
                this.renderConversations();
                updateFaviconBadge(0);
            }
        });

        this.socket.on('conversation_archived', data => {
            if (data.pageId === this.selectedPageId) {
                this.conversations = this.conversations.filter(c => c.id !== data.convId);
                this.renderConversations();
                if (this.selectedConvId === data.convId) this.showEmpty();
            }
        });

        this.socket.on('sync_progress', data => {
            const wrap = document.getElementById('sync-bar-wrap');
            const fill = document.getElementById('sync-bar-fill');
            const label = document.getElementById('sync-bar-label');
            if (!wrap || !fill || !label) return;

            if (data.phase === 'done') {
                wrap.style.display = 'none';
                fill.style.width = '0%';
                // Reload conversation list for current page after sync completes
                if (this.selectedPageId) this.loadConversations();
                return;
            }

            wrap.style.display = 'flex';
            const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
            fill.style.width = pct + '%';
            if (data.phase === 'conversations') {
                label.textContent = 'Loading chats...';
            } else {
                label.textContent = `${data.done}/${data.total} synced`;
                // Refresh conv list periodically as messages come in
                if (data.done > 0 && data.done % 5 === 0 && data.pageId === this.selectedPageId) {
                    this.loadConversations();
                }
            }
        });
    },

    _showBrowserNotif(msg) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const conv = this.conversations.find(c => c.id === msg.threadId);
        const name = conv?.participantName || 'Customer';
        const text = msg.text || '📎 Attachment';
        const notif = new Notification(name, {
            body: text.length > 80 ? text.slice(0, 77) + '...' : text,
            icon: '/favicon.ico',
            tag: msg.threadId,
            renotify: true
        });
        notif.onclick = () => {
            window.focus();
            if (conv) this.selectConv(conv.id, encodeURIComponent(conv.participantName || 'Customer'), conv.participantId || '');
            notif.close();
        };
        setTimeout(() => notif.close(), 6000);
    },

    async _silentRefresh(convId) {
        try {
            const res = await fetchWithAuth(`/api/threads/${convId}/messages?pageId=${this.selectedPageId}&limit=200`);
            if (!res || convId !== this.selectedConvId) return;
            const data = await res.json();
            const messages = data.messages || [];
            this._msgCache[convId] = messages;
            for (const msg of messages) {
                if (msg.id && !document.querySelector(`[data-msg-id="${msg.id}"]`)) {
                    this.appendMessage(msg);
                }
            }
        } catch(e) {}
    },

    setSyncStatus(state) {
        const pill = document.getElementById('sync-status');
        if (!pill) return;
        if (state === 'connected') { pill.className = 'sync-pill'; pill.querySelector('span:last-child').textContent = 'Live'; }
        else if (state === 'disconnected') { pill.className = 'sync-pill'; pill.querySelector('span:last-child').textContent = 'Offline'; }
        else if (state === 'syncing') { pill.className = 'sync-pill syncing'; pill.querySelector('span:last-child').textContent = 'Syncing...'; }
    },

    async loadPages() {
        try {
            const res = await fetchWithAuth('/api/pages');
            if (!res) return;
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            this.pages = data.pages || [];
            this.renderPages();

            // Bulk load all conversations for all pages (optimization)
            if (this.pages.length > 1) {
                const pageIds = this.pages.map(p => p.id).join(',');
                const bulkRes = await fetchWithAuth(`/api/conversations/bulk?pageIds=${pageIds}`);
                if (bulkRes) {
                    const bulkData = await bulkRes.json();
                    this._cachedConversations = bulkData.conversations || {};
                    const now = Date.now();
                    Object.keys(this._cachedConversations).forEach(pid => { this._cacheTime[pid] = now; });
                }
            }

            if (this.pages.length > 0) this.selectPage(this.pages[0].id);
        } catch(e) {
            document.getElementById('pages-list').innerHTML = '<div class="no-convs">Failed to load pages</div>';
        }
    },

    renderPages() {
        const el = document.getElementById('pages-list');
        if (!this.pages.length) { el.innerHTML = '<div class="no-convs">No pages found</div>'; return; }
        el.innerHTML = this.pages.map(p => `
            <div class="page-item ${p.id === this.selectedPageId ? 'active' : ''} ${p.unreadCount ? 'has-unread' : ''}"
                 data-page-id="${p.id}" onclick="Inbox.selectPage('${p.id}')">
                ${p.picture
                    ? `<img class="page-avatar" src="${escapeHtml(p.picture)}" alt="" onerror="this.style.display='none'">`
                    : `<div class="page-avatar-icon">${getInitials(p.name)}</div>`}
                <div class="page-info">
                    <div class="page-name">${escapeHtml(p.name)}</div>
                    <div class="page-count">${p.unreadCount ? p.unreadCount + ' unread' : 'No unread'}</div>
                </div>
                ${p.unreadCount ? `<div class="unread-badge">${p.unreadCount > 99 ? '99+' : p.unreadCount}</div>` : ''}
            </div>`).join('');
    },

    async selectPage(pageId) {
        const prevPageId = this.selectedPageId;
        this.selectedPageId = pageId;
        this.selectedConvId = null;
        this.filter = 'all';
        this.searchQuery = '';
        this._searchResults = null;
        clearTimeout(this._searchTimer);
        document.getElementById('conv-search').value = '';
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
        document.querySelectorAll('.page-item').forEach(i => i.classList.toggle('active', i.dataset.pageId === pageId));
        if (this.socket) {
            if (prevPageId && prevPageId !== pageId) this.socket.emit('leave_page', prevPageId);
            this.socket.emit('join_page', pageId);
        }
        await this.loadConversations();
        this.showEmpty();
    },

    async loadConversations(append = false) {
        const el = document.getElementById('conversations-list');
        const pageId = this.selectedPageId;
        if (!pageId) return;

        if (!append) {
            this._convOffset[pageId] = 0;
            this._convHasMore[pageId] = false;
            this.conversations = [];
            if (this._convObserver) { this._convObserver.disconnect(); this._convObserver = null; }
            el.innerHTML = `<div id="conv-skeletons">${[1,2,3,4].map(() =>
                `<div class="skel-conv"><div class="skel-av skeleton"></div><div class="skel-lines"><div class="skel-line skeleton" style="width:${55+Math.random()*30|0}%"></div><div class="skel-line skeleton" style="width:${35+Math.random()*25|0}%"></div></div></div>`
            ).join('')}</div>`;

            // Use cached first batch (from bulk preload) — only if actually has data
            if (this._cachedConversations?.[pageId]?.length > 0) {
                this.conversations = this._cachedConversations[pageId];
                this._convOffset[pageId] = this.conversations.length;
                this._convHasMore[pageId] = this.conversations.length >= 100;
                this.renderConversations();
                this._setupConvScroll(pageId);
                if (Date.now() - (this._cacheTime[pageId] || 0) > 60000) this._refreshConversations(pageId);
                return;
            }
        }

        const offset = this._convOffset[pageId] || 0;
        try {
            const archivedParam = this.filter === 'archived' ? '&archived=true' : '';
            const res = await fetchWithAuth(`/api/pages/${pageId}/conversations?limit=100&offset=${offset}${archivedParam}`);
            if (!res || pageId !== this.selectedPageId) return;
            const data = await res.json();

            if (data.tokenExpired || data.tokenMissing) {
                if (!append && pageId === this.selectedPageId)
                    el.innerHTML = `<div class="no-convs" style="padding:16px;text-align:center">
                        <div style="margin-bottom:8px">⚠️ ${data.tokenMissing ? 'Page token missing' : 'Facebook session expired'}</div>
                        <a href="/dashboard.html" style="color:var(--primary-color);font-size:13px">Go to Dashboard to reconnect →</a>
                    </div>`;
                return;
            }

            const newConvs = data.conversations || [];

            if (append) {
                this.conversations = this.conversations.concat(newConvs);
                // Fast path: no filter active → just append new DOM nodes
                if (this.filter === 'all' && !this.searchQuery) {
                    this._appendConvItems(newConvs);
                } else {
                    this.renderConversations();
                }
            } else {
                this.conversations = newConvs;
                this.renderConversations();
            }

            this._convOffset[pageId] = offset + newConvs.length;
            this._convHasMore[pageId] = data.hasMore || false;

            // Update page count badge
            const total = data.total ?? this.conversations.length;
            const pi = document.querySelector(`.page-item[data-page-id="${pageId}"]`);
            if (pi) pi.querySelector('.page-count').textContent = total + ' conversation' + (total !== 1 ? 's' : '');

            this._setupConvScroll(pageId);
        } catch(e) {
            if (!append && pageId === this.selectedPageId)
                el.innerHTML = '<div class="no-convs">Failed to load conversations</div>';
        }
    },

    // Append new conv items to DOM without re-rendering everything
    _appendConvItems(newConvs) {
        const el = document.getElementById('conversations-list');
        const sentinel = document.getElementById('conv-sentinel');
        if (sentinel) sentinel.remove();
        for (const conv of newConvs) {
            const isUnread = !conv.isRead;
            const isActive = conv.id === this.selectedConvId;
            const snippet = conv.snippet || 'No messages yet';
            const pfx = conv.lastMessageFromPage ? '<span class="sender-you">You: </span>' : '';
            const div = document.createElement('div');
            div.className = `conv-item${isUnread ? ' unread' : ''}${isActive ? ' active' : ''}`;
            div.dataset.convId = conv.id;
            div.setAttribute('onclick', `Inbox.selectConv('${conv.id}','${encodeURIComponent(conv.participantName || 'Customer')}','${conv.participantId || ''}')`);
            div.innerHTML = `
                <div class="conv-avatar">
                    ${getInitials(conv.participantName)}
                    ${isUnread ? '<div class="unread-dot"></div>' : ''}
                </div>
                <div class="conv-info">
                    <div class="conv-top">
                        <span class="conv-name">${escapeHtml(conv.participantName || 'Customer')}</span>
                        <span class="conv-time">${formatRelativeTime(conv.updatedTime)}</span>
                    </div>
                    <div class="conv-snippet">${pfx}${escapeHtml(snippet)}</div>
                </div>
                ${isUnread ? `<div class="conv-badge">${conv.unreadCount > 99 ? '99+' : (conv.unreadCount || '•')}</div>` : ''}`;
            el.appendChild(div);
        }
    },

    // Set up IntersectionObserver sentinel at the bottom of conv list
    _setupConvScroll(pageId) {
        const el = document.getElementById('conversations-list');
        const old = document.getElementById('conv-sentinel');
        if (old) old.remove();
        if (this._convObserver) { this._convObserver.disconnect(); this._convObserver = null; }
        if (!this._convHasMore[pageId]) return;

        const sentinel = document.createElement('div');
        sentinel.id = 'conv-sentinel';
        sentinel.style.cssText = 'height:1px;margin-top:8px;';
        el.appendChild(sentinel);

        this._convObserver = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting && this._convHasMore[pageId] && pageId === this.selectedPageId) {
                this._convObserver.disconnect();
                this._convObserver = null;
                this.loadConversations(true);
            }
        }, { root: el, threshold: 0 });
        this._convObserver.observe(sentinel);
    },

    // Background refresh for first page (updates snippets, unread counts)
    async _refreshConversations(pageId) {
        try {
            const res = await fetchWithAuth(`/api/pages/${pageId}/conversations?limit=100&offset=0`);
            if (!res || pageId !== this.selectedPageId) return;
            const data = await res.json();
            if (data.conversations && data.conversations.length > 0) {
                // Merge: update first N conversations in-place (keep older ones loaded beyond first page)
                const fresh = data.conversations;
                const freshIds = new Set(fresh.map(c => c.id));
                this.conversations = fresh.concat(this.conversations.filter(c => !freshIds.has(c.id)));
                this.renderConversations();
                if (this._cachedConversations) this._cachedConversations[pageId] = fresh;
                this._cacheTime[pageId] = Date.now();
            }
        } catch(e) {}
    },

    async _serverSearch(query) {
        const pageId = this.selectedPageId;
        if (!pageId || !query) return;
        try {
            const res = await fetchWithAuth(
                `/api/pages/${pageId}/conversations/search?q=${encodeURIComponent(query)}`
            );
            if (!res || this.searchQuery !== query.toLowerCase()) return; // stale
            const data = await res.json();
            this._searchResults = data.conversations || [];
            this.renderConversations();
        } catch(e) {}
    },

    getFiltered() {
        // When server search results are available, use them exclusively
        if (this._searchResults !== null) return this._searchResults;
        let list = this.conversations;
        // 'archived' filter is handled server-side; just show all returned conversations
        if (this.filter === 'unread') list = list.filter(c => !c.isRead);
        else if (this.filter === 'read') list = list.filter(c => c.isRead);
        if (this.searchQuery) {
            const q = this.searchQuery;
            list = list.filter(c =>
                (c.participantName || '').toLowerCase().includes(q) ||
                (c.snippet || '').toLowerCase().includes(q)
            );
        }
        return list;
    },

    renderConversations() {
        const el = document.getElementById('conversations-list');
        const scrollTop = el.scrollTop;
        const list = this.getFiltered();
        const unread = this.conversations.filter(c => !c.isRead).length;
        const tabEl = document.getElementById('unread-count-tab');
        if (tabEl) tabEl.textContent = unread > 0 ? `(${unread})` : '';
        updateFaviconBadge(unread);
        this._updateBulkBar();
        const inSearch = this._searchResults !== null;
        const hasMore = !inSearch && this._convHasMore?.[this.selectedPageId];
        const countLabel = inSearch
            ? (list.length ? `${list.length} result${list.length !== 1 ? 's' : ''}` : '')
            : (list.length ? `${list.length}${hasMore ? '+' : ''} shown` : '');
        document.getElementById('conv-count').textContent = countLabel;

        if (!list.length) {
            const emptyMsg = this.searchQuery
                ? `No results for "${escapeHtml(this.searchQuery)}"`
                : this.filter === 'archived' ? 'No archived conversations' : 'No conversations';
            el.innerHTML = `<div class="no-convs">
                <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span>${emptyMsg}</span>
                ${this.searchQuery && !this._searchResults ? '<span style="font-size:11px;opacity:0.5">Searching all conversations...</span>' : ''}
            </div>`;
            return;
        }

        el.innerHTML = list.map(conv => {
            const isUnread = !conv.isRead;
            const isActive = conv.id === this.selectedConvId;
            const snippet = conv.snippet || 'No messages yet';
            const pfx = conv.lastMessageFromPage ? '<span class="sender-you">You: </span>' : '';
            return `
                <div class="conv-item ${isUnread ? 'unread' : ''} ${isActive ? 'active' : ''}"
                     data-conv-id="${conv.id}"
                     onclick="Inbox.selectConv('${conv.id}','${encodeURIComponent(conv.participantName || 'Customer')}','${conv.participantId || ''}')">
                    <div class="conv-avatar">
                        ${getInitials(conv.participantName)}
                        ${isUnread ? '<div class="unread-dot"></div>' : ''}
                    </div>
                    <div class="conv-info">
                        <div class="conv-top">
                            <span class="conv-name">${escapeHtml(conv.participantName || 'Customer')}</span>
                            <span class="conv-time">${formatRelativeTime(conv.updatedTime)}</span>
                        </div>
                        <div class="conv-snippet">${pfx}${escapeHtml(snippet)}</div>
                    </div>
                    ${isUnread ? `<div class="conv-badge">${conv.unreadCount > 99 ? '99+' : (conv.unreadCount || '•')}</div>` : ''}
                </div>`;
        }).join('');
        el.scrollTop = scrollTop;
    },

    applyFilter(filter) {
        const wasArchived = this.filter === 'archived';
        const isArchived  = filter === 'archived';
        this.filter = filter;
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
        // Archived view requires a separate DB fetch; switching in/out triggers reload
        if (isArchived !== wasArchived) {
            this.loadConversations();
        } else {
            this.renderConversations();
        }
    },

    async selectConv(convId, name, participantId) {
        this.selectedConvId = convId;
        this.participantName = decodeURIComponent(name);
        this.participantId = participantId;
        this.newMsgCount = 0;
        this.atBottom = true;

        document.querySelectorAll('.conv-item').forEach(i => i.classList.toggle('active', i.dataset.convId === convId));
        if (this.socket) this.socket.emit('join_thread', convId);

        await this.markAsRead(convId);
        await this.loadMessages(convId);
    },

    async markAsRead(convId) {
        try {
            await fetchWithAuth(`/api/threads/${convId}/read`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ pageId: this.selectedPageId })
            });
            const conv = this.conversations.find(c => c.id === convId);
            if (conv) { conv.isRead = true; conv.unreadCount = 0; }
            // Update DOM in-place — no full re-render so scroll position is preserved
            const item = document.querySelector(`.conv-item[data-conv-id="${convId}"]`);
            if (item) {
                item.classList.remove('unread');
                item.querySelector('.conv-badge')?.remove();
                item.querySelector('.unread-dot')?.remove();
            }
            const unread = this.conversations.filter(c => !c.isRead).length;
            const tabEl = document.getElementById('unread-count-tab');
            if (tabEl) tabEl.textContent = unread > 0 ? `(${unread})` : '';
        } catch(e) {}
    },

    async loadMessages(convId) {
        const panel = document.getElementById('messages-panel');
        const hadCache = !!this._msgCache[convId];
        if (hadCache) {
            this.renderMessages(this._msgCache[convId]);
        } else {
            panel.innerHTML = '<div class="loading-state"><div class="spin"></div><span>Loading messages...</span></div>';
        }
        try {
            const res = await fetchWithAuth(`/api/threads/${convId}/messages?pageId=${this.selectedPageId}&limit=200`);
            if (!res) return;
            const data = await res.json();
            const messages = data.messages || [];
            this._msgCache[convId] = messages;
            if (convId !== this.selectedConvId) return;
            if (!hadCache) {
                // First load — no cache was rendered, do full render
                this.renderMessages(messages);
                // Safety net: refresh once after a short delay to catch any messages
                // that arrived during the load window (socket event missed while msgs-body
                // didn't exist, or the message was saved to DB just after our fetch).
                setTimeout(() => { if (convId === this.selectedConvId) this._silentRefresh(convId); }, 1500);
            } else {
                // Cache was already rendered — only append messages not yet in DOM
                // This prevents destroying loaded <img> elements which would force image reloads
                for (const msg of messages) {
                    if (msg.id && !document.querySelector(`[data-msg-id="${msg.id}"]`)) {
                        this.appendMessage(msg);
                    }
                }
            }
        } catch(e) {
            if (!this._msgCache[convId])
                panel.innerHTML = '<div class="msgs-empty"><h3>Error loading messages</h3><p>Please try again</p></div>';
        }
    },

    renderMessages(messages) {
        const panel = document.getElementById('messages-panel');
        const totalMsg = messages.length;
        const page = this.pages.find(p => p.id === this.selectedPageId);
        const pageInitials = page ? getInitials(page.name) : 'P';

        let html = `
            <div class="msgs-header">
                <div class="msgs-header-avatar">${getInitials(this.participantName)}</div>
                <div class="msgs-header-info">
                    <div class="msgs-header-name">${escapeHtml(this.participantName)}</div>
                    <div class="msgs-header-sub" id="msgs-sub-info">${totalMsg} message${totalMsg !== 1 ? 's' : ''}</div>
                </div>
                <div class="msgs-header-actions">
                    <button class="icon-btn" title="Mark unread" onclick="Inbox.markUnread('${this.selectedConvId}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                    </button>
                    ${this.filter === 'archived'
                        ? `<button class="icon-btn" title="Unarchive — move back to inbox" onclick="Inbox.unarchiveConv('${this.selectedConvId}')" style="color:#22c55e;border-color:#22c55e">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="12" y1="12" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/></svg>
                           </button>`
                        : `<button class="icon-btn" title="Archive" onclick="Inbox.archiveConv('${this.selectedConvId}')">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                           </button>`
                    }
                    <button class="icon-btn" title="Quick replies" onclick="Inbox.openCannedModal()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </button>
                </div>
            </div>
            <div class="notes-tab-bar">
                <div class="notes-tab active" id="tab-msgs" onclick="Inbox.switchTab('msgs')">Messages</div>
                <div class="notes-tab" id="tab-notes" onclick="Inbox.switchTab('notes')">Notes</div>
            </div>
            <div id="msgs-view" style="display:flex;flex-direction:column;flex:1;overflow:hidden;position:relative">
            <div class="msgs-body" id="msgs-body">`;

        let lastDate = null;
        for (const msg of messages) {
            const d = new Date(msg.createdTime).toLocaleDateString();
            if (d !== lastDate) { lastDate = d; html += `<div class="date-sep">${formatDateLabel(msg.createdTime)}</div>`; }
            html += this.msgHtml(msg);
        }

        html += `</div>

            <!-- Scroll to bottom -->
            <button class="scroll-to-bottom hidden" id="scroll-btn" onclick="Inbox.scrollToBottom()" title="Scroll to bottom">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="new-msg-notif hidden" id="new-msg-notif" onclick="Inbox.scrollToBottom()">↓ New messages</div>

            <!-- Compose area -->
            <div class="compose-wrap">
                <!-- Emoji picker -->
                <div class="emoji-picker hidden" id="emoji-picker">
                    ${EMOJIS.map(e => `<button class="e-btn" onclick="Inbox.insertEmoji('${e}')">${e}</button>`).join('')}
                </div>

                <!-- Canned replies panel -->
                <div class="canned-panel hidden" id="canned-panel">
                    <div class="canned-ph">
                        <span class="canned-ph-title">Saved replies</span>
                        <button class="canned-add-btn" onclick="Inbox.openCannedModal()">+ Add new</button>
                    </div>
                    <div class="canned-search-wrap">
                        <svg class="canned-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" class="canned-search-input" id="canned-search-input" placeholder="Search">
                    </div>
                    <div class="canned-scroll" id="canned-list-panel"></div>
                </div>

                <!-- Saved reply preview -->
                <div class="saved-reply-preview hidden" id="saved-reply-preview" onclick="Inbox.clickSavedReplyPreview(event)">
                    <div class="srp-inner">
                        <div class="srp-label">Saved reply · Click to insert</div>
                        <div class="srp-body" id="srp-body"></div>
                    </div>
                    <button class="srp-close" onclick="event.stopPropagation(); Inbox.hideSavedReplyPreview()">✕</button>
                </div>

                <div class="compose-top-row">
                    <div class="compose-page-av">${pageInitials}</div>
                    <textarea id="message-input" class="compose-input" placeholder="Reply in Messenger..." rows="2" maxlength="2000"></textarea>
                </div>
                <div class="compose-bottom-row">
                    <input type="file" id="attach-input" accept="image/*,video/*" style="display:none" onchange="Inbox.handleFileSelect(event)">
                    <span class="compose-char-counter hidden" id="char-counter"></span>
                    <div class="compose-right-actions">
                        <button id="attach-btn" class="compose-icon-btn" title="Attachment" onclick="document.getElementById('attach-input').click()">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                        </button>
                        <button class="compose-icon-btn" data-canned="1" title="Insert saved reply" onclick="Inbox.showCannedPanel('')">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="11" r="1" fill="currentColor"/><circle cx="12" cy="11" r="1" fill="currentColor"/><circle cx="15" cy="11" r="1" fill="currentColor"/></svg>
                        </button>
                        <button class="compose-icon-btn" data-emoji="1" title="Emoji" onclick="Inbox.toggleEmoji(event)">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                        </button>
                        <button id="send-btn" class="compose-submit hidden" title="Send (Enter)">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                        </button>
                        <button id="like-btn" class="compose-icon-btn compose-like-btn" title="Send like" onclick="Inbox.sendLike()">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" fill="none" stroke="currentColor" stroke-width="2"/></svg>
                        </button>
                    </div>
                </div>
            </div>
            <!-- Typing indicator -->
            <div class="typing-indicator" id="typing-indicator">
                <div class="typing-dots"><span></span><span></span><span></span></div>
                <span id="typing-label">Agent is typing...</span>
            </div>
            </div><!-- /msgs-view -->
            <!-- Notes view (hidden by default) -->
            <div id="notes-view" style="display:none;flex-direction:column;flex:1;overflow:hidden">
                <div class="notes-panel" id="notes-list"><div class="loading-state" style="padding:20px"><div class="spin"></div></div></div>
                <div class="note-compose">
                    <textarea class="note-input" id="note-input" placeholder="Add internal note (only visible to you)..." rows="2"></textarea>
                    <button class="note-save-btn" onclick="Inbox.saveNote()">Save</button>
                </div>
            </div>`;

        panel.innerHTML = html;
        this.initCompose();
        this.loadNotes(this.selectedConvId);

        setTimeout(() => {
            const body = document.getElementById('msgs-body');
            if (body) { body.scrollTop = body.scrollHeight; }
        }, 60);
    },

    switchTab(tab) {
        const msgsView = document.getElementById('msgs-view');
        const notesView = document.getElementById('notes-view');
        const tabMsgs = document.getElementById('tab-msgs');
        const tabNotes = document.getElementById('tab-notes');
        if (!msgsView || !notesView) return;
        if (tab === 'msgs') {
            msgsView.style.display = 'flex';
            notesView.style.display = 'none';
            tabMsgs?.classList.add('active');
            tabNotes?.classList.remove('active');
        } else {
            msgsView.style.display = 'none';
            notesView.style.display = 'flex';
            tabMsgs?.classList.remove('active');
            tabNotes?.classList.add('active');
            document.getElementById('note-input')?.focus();
        }
    },

    async loadNotes(convId) {
        const list = document.getElementById('notes-list');
        if (!list) return;
        try {
            const res = await fetchWithAuth(`/api/threads/${convId}/notes`);
            if (!res || convId !== this.selectedConvId) return;
            const data = await res.json();
            this._renderNotes(data.notes || []);
        } catch(e) {}
    },

    _renderNotes(notes) {
        const list = document.getElementById('notes-list');
        if (!list) return;
        if (!notes.length) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">No notes yet.<br>Add internal notes visible only to you.</div>';
            return;
        }
        list.innerHTML = notes.map(n => `
            <div class="note-item" data-note-id="${n.id}">
                <div class="note-meta">
                    <span>${escapeHtml(n.author)} · ${formatRelativeTime(n.created_at)}</span>
                    <button class="note-delete" onclick="Inbox.deleteNote(${n.id})" title="Delete">✕</button>
                </div>
                <div class="note-body">${escapeHtml(n.body)}</div>
            </div>`).join('');
    },

    async saveNote() {
        const input = document.getElementById('note-input');
        const body = input?.value.trim();
        if (!body || !this.selectedConvId) return;
        try {
            const res = await fetchWithAuth(`/api/threads/${this.selectedConvId}/notes`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ body, pageId: this.selectedPageId })
            });
            if (!res) return;
            const data = await res.json();
            if (data.note) {
                if (input) input.value = '';
                await this.loadNotes(this.selectedConvId);
                showToast('Note saved', 'success');
            }
        } catch(e) { showToast('Failed to save note', 'error'); }
    },

    async deleteNote(noteId) {
        if (!this.selectedConvId) return;
        try {
            await fetchWithAuth(`/api/threads/${this.selectedConvId}/notes/${noteId}`, {
                method: 'DELETE', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ pageId: this.selectedPageId })
            });
            await this.loadNotes(this.selectedConvId);
        } catch(e) {}
    },

    async archiveConv(convId) {
        if (!convId) return;
        try {
            await fetchWithAuth(`/api/threads/${convId}/archive`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ pageId: this.selectedPageId })
            });
            this.conversations = this.conversations.filter(c => c.id !== convId);
            this.selectedConvId = null;
            this.renderConversations();
            this.showEmpty();
            showInboxToast('Conversation archived', 'success');
        } catch(e) { showInboxToast('Failed to archive', 'error'); }
    },

    async unarchiveConv(convId) {
        if (!convId) return;
        try {
            await fetchWithAuth(`/api/threads/${convId}/unarchive`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ pageId: this.selectedPageId })
            });
            this.conversations = this.conversations.filter(c => c.id !== convId);
            this.selectedConvId = null;
            this.renderConversations();
            this.showEmpty();
            showInboxToast('Conversation moved to inbox ✓', 'success');
        } catch(e) { showInboxToast('Failed to unarchive', 'error'); }
    },

    async markUnread(convId) {
        if (!convId) return;
        try {
            await fetchWithAuth(`/api/threads/${convId}/unread`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ pageId: this.selectedPageId })
            });
            const conv = this.conversations.find(c => c.id === convId);
            if (conv) { conv.isRead = false; conv.unreadCount = 1; }
            this.renderConversations();
        } catch(e) {}
    },

    async markAllRead() {
        if (!this.selectedPageId) return;
        try {
            const res = await fetchWithAuth(`/api/pages/${this.selectedPageId}/mark-all-read`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: '{}'
            });
            if (!res) return;
            this.conversations.forEach(c => { c.isRead = true; c.unreadCount = 0; });
            this.renderConversations();
            updateFaviconBadge(0);
            showToast('All conversations marked as read', 'success');
        } catch(e) { showToast('Failed to mark all read', 'error'); }
    },

    msgHtml(msg) {
        const senderLabel = msg.isFromPage ? 'You' : this.participantName;
        const cls = msg.isFromPage ? 'msg-outgoing' : 'msg-incoming';
        const idAttr = msg.id ? `data-msg-id="${msg.id}"` : '';

        let attachHtml = '';
        if (msg.attachments && msg.attachments.length > 0) {
            attachHtml = msg.attachments.map(a => {
                if (a.t === 'image') return `<div class="msg-attachment"><div class="msg-img-wrap skeleton"><img src="${escapeHtml(a.u)}" class="msg-img" loading="lazy" alt="" onload="this.parentElement.classList.remove('skeleton')" onerror="this.parentElement.classList.remove('skeleton'); this.style.display='none'" onclick="Inbox.openLightbox('${escapeHtml(a.u)}')"></div></div>`;
                if (a.t === 'video') return `<div class="msg-attachment"><video src="${escapeHtml(a.u)}" controls class="msg-video" preload="metadata"></video></div>`;
                return `<div class="msg-attachment"><a href="${escapeHtml(a.u)}" target="_blank" rel="noopener noreferrer" class="msg-file">📎 ${escapeHtml(a.n || a.t || 'File')}</a></div>`;
            }).join('');
        }

        const isPlaceholderOnly = !msg.text || msg.text === `[${(msg.attachments||[])[0]?.t}]`;
        const textHtml = (!isPlaceholderOnly && msg.text) ? `<div class="msg-text">${escapeHtml(msg.text)}</div>` : '';

        return `
            <div class="msg ${cls}" ${idAttr}>
                <div class="msg-sender">${escapeHtml(senderLabel)}</div>
                ${textHtml}
                ${attachHtml}
                <div class="msg-time">${msg.createdTime === 'Just now' ? 'Just now' : formatMessageTime(msg.createdTime)}</div>
            </div>`;
    },

    appendMessage(msg) {
        const container = document.getElementById('msgs-body');
        if (!container) return;
        if (msg.id && document.querySelector(`[data-msg-id="${msg.id}"]`)) return;

        const wasAtBottom = this.atBottom;
        container.insertAdjacentHTML('beforeend', this.msgHtml(msg));

        if (wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        } else if (!msg.isFromPage) {
            this.newMsgCount++;
            const notif = document.getElementById('new-msg-notif');
            if (notif) { notif.textContent = `↓ ${this.newMsgCount} new message${this.newMsgCount !== 1 ? 's' : ''}`; notif.classList.remove('hidden'); }
        }
    },

    initCompose() {
        const input = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const msgsBody = document.getElementById('msgs-body');

        if (msgsBody) {
            msgsBody.addEventListener('scroll', () => {
                const { scrollTop, scrollHeight, clientHeight } = msgsBody;
                this.atBottom = scrollTop + clientHeight >= scrollHeight - 80;
                document.getElementById('scroll-btn')?.classList.toggle('hidden', this.atBottom);
                if (this.atBottom) {
                    this.newMsgCount = 0;
                    document.getElementById('new-msg-notif')?.classList.add('hidden');
                }
            });
        }

        // Typing indicator: emit start/stop to other agents watching this thread
        input.addEventListener('input', () => {
            if (this.socket && this.selectedConvId) {
                clearTimeout(this._typingStopTimer);
                if (!this._isTyping) {
                    this._isTyping = true;
                    this.socket.emit('typing_start', { threadId: this.selectedConvId, pageId: this.selectedPageId, agentName: 'Agent' });
                }
                this._typingStopTimer = setTimeout(() => {
                    this._isTyping = false;
                    this.socket?.emit('typing_stop', { threadId: this.selectedConvId });
                }, 2000);
            }

            const hasText = !!input.value.trim();
            sendBtn.disabled = !hasText;
            sendBtn.classList.toggle('hidden', !hasText);
            document.getElementById('like-btn')?.classList.toggle('hidden', hasText);
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';

            const len = input.value.length;
            const counter = document.getElementById('char-counter');
            if (counter) {
                if (len >= 1800) {
                    counter.textContent = `${len}/2000`;
                    counter.className = 'compose-char-counter' + (len >= 1950 ? ' danger' : ' warn');
                } else {
                    counter.className = 'compose-char-counter hidden';
                }
            }

            const val = input.value;
            if (val === '/' || (val.startsWith('/') && !val.includes(' '))) {
                this.showCannedPanel(val.slice(1));
                this.hideSavedReplyPreview();
            } else {
                this.hideCannedPanel();
                const q = val.trim().toLowerCase();
                if (q.length >= 1) {
                    const match = this.cannedReplies.find(r => r.title.toLowerCase().startsWith(q));
                    match ? this.showSavedReplyPreview(match) : this.hideSavedReplyPreview();
                } else {
                    this.hideSavedReplyPreview();
                }
            }
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                this.hideEmoji(); this.hideCannedPanel(); this.hideSavedReplyPreview();
                return;
            }
            const isCannedOpen = !document.getElementById('canned-panel').classList.contains('hidden');
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && isCannedOpen) {
                e.preventDefault();
                const items = document.querySelectorAll('#canned-list-panel .canned-item');
                if (!items.length) return;
                const active = document.querySelector('#canned-list-panel .canned-item.focused');
                let idx = Array.from(items).indexOf(active);
                if (active) active.classList.remove('focused');
                idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
                items[idx].classList.add('focused');
                items[idx].scrollIntoView({ block: 'nearest' });
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (isCannedOpen) {
                    const focused = document.querySelector('#canned-list-panel .canned-item.focused');
                    if (focused) { focused.click(); return; }
                }
                this.sendMessage();
            }
        });

        sendBtn.addEventListener('click', () => this.sendMessage());
        input.focus();
    },

    async sendMessage() {
        const input = document.getElementById('message-input');
        const text = input.value.trim();
        if (!text || !this.selectedConvId) return;

        input.disabled = true;
        document.getElementById('send-btn').disabled = true;
        this.hideEmoji();
        this.hideCannedPanel();
        this.hideSavedReplyPreview();

        // Optimistic append BEFORE the API call — the server emits the socket
        // event before returning the HTTP response, so _lastTempMsgId must be
        // set before await or the socket handler won't find the temp element.
        // Stop typing indicator immediately on send
        if (this._isTyping) {
            this._isTyping = false;
            clearTimeout(this._typingStopTimer);
            this.socket?.emit('typing_stop', { threadId: this.selectedConvId });
        }

        const tempId = '__tmp__' + Date.now();
        this._lastTempMsgId = tempId;
        this.appendMessage({ text, isFromPage: true, createdTime: 'Just now', attachments: [], id: tempId });
        input.value = '';
        input.style.height = 'auto';

        try {
            const res = await fetchWithAuth(`/api/threads/${this.selectedConvId}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, pageId: this.selectedPageId, recipientId: this.participantId })
            });
            if (!res) throw new Error('Network error');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
        } catch(e) {
            showInboxToast('Send failed: ' + e.message, 'error');
            document.querySelector(`[data-msg-id="${tempId}"]`)?.remove();
            input.value = text;
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        } finally {
            input.disabled = false;
            const hasText = !!input.value.trim();
            document.getElementById('send-btn').disabled = !hasText;
            document.getElementById('send-btn').classList.toggle('hidden', !hasText);
            document.getElementById('like-btn')?.classList.toggle('hidden', hasText);
            input.focus();
        }
    },

    async sendLike() {
        if (!this.selectedConvId) return;
        const likeBtn = document.getElementById('like-btn');
        if (likeBtn) likeBtn.disabled = true;
        const tempId = '__tmp__' + Date.now();
        this._lastTempMsgId = tempId;
        this.appendMessage({ text: '👍', isFromPage: true, createdTime: 'Just now', attachments: [], id: tempId });
        try {
            const res = await fetchWithAuth(`/api/threads/${this.selectedConvId}/reply`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '👍', pageId: this.selectedPageId, recipientId: this.participantId })
            });
            if (!res) throw new Error('Network error');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
        } catch(e) {
            document.querySelector(`[data-msg-id="${tempId}"]`)?.remove();
            showInboxToast('Failed: ' + e.message, 'error');
        } finally {
            if (likeBtn) likeBtn.disabled = false;
        }
    },

    handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        if (file.size > 10 * 1024 * 1024) { showInboxToast('File too large (max 10MB)', 'error'); return; }
        this.sendAttachment(file);
    },

    async sendAttachment(file) {
        if (!this.selectedConvId) return;
        const attachBtn = document.getElementById('attach-btn');
        if (attachBtn) attachBtn.disabled = true;
        showInboxToast('Sending...', '');
        const formData = new FormData();
        formData.append('file', file);
        formData.append('pageId', this.selectedPageId);
        formData.append('recipientId', this.participantId);
        try {
            const res = await fetch(`/api/threads/${this.selectedConvId}/attach`, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'X-CSRF-Token': App.csrfToken },
                body: formData
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const attachType = file.type.startsWith('image/') ? 'image' : 'video';
            const tempId = '__tmp__' + Date.now();
            this._lastTempMsgId = tempId;
            this.appendMessage({
                text: '', isFromPage: true, createdTime: 'Just now',
                attachments: [{ t: attachType, u: URL.createObjectURL(file) }], id: tempId
            });
            showInboxToast('Sent!', 'success');
        } catch(e) {
            showInboxToast('Failed: ' + e.message, 'error');
        } finally {
            if (attachBtn) attachBtn.disabled = false;
        }
    },

    // ── THEME & SOUND ──
    toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        showInboxToast(next === 'light' ? '☀️ Light mode' : '🌙 Dark mode');
    },

    toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        localStorage.setItem('sound', this.soundEnabled);
        document.getElementById('sound-btn')?.classList.toggle('active', this.soundEnabled);
        showInboxToast(this.soundEnabled ? 'Sound on' : 'Sound off');
    },

    // ── EMOJI ──
    toggleEmoji(e) {
        e.stopPropagation();
        document.getElementById('emoji-picker')?.classList.toggle('hidden');
        this.hideCannedPanel();
    },
    hideEmoji() { document.getElementById('emoji-picker')?.classList.add('hidden'); },
    insertEmoji(emoji) {
        const input = document.getElementById('message-input');
        if (!input) return;
        const s = input.selectionStart, end = input.selectionEnd;
        input.value = input.value.slice(0, s) + emoji + input.value.slice(end);
        input.selectionStart = input.selectionEnd = s + emoji.length;
        input.dispatchEvent(new Event('input'));
        input.focus();
        this.hideEmoji();
    },

    // ── CANNED REPLIES ──
    showCannedPanel(query) {
        const panel = document.getElementById('canned-panel');
        if (!panel) return;
        const searchInput = document.getElementById('canned-search-input');
        if (searchInput) {
            searchInput.value = query || '';
            searchInput.oninput = () => this._renderCannedListPanel(searchInput.value);
        }
        this._renderCannedListPanel(query || '');
        panel.classList.remove('hidden');
        this.hideEmoji();
        if (searchInput) setTimeout(() => searchInput.focus(), 40);
    },

    _renderCannedListPanel(query) {
        const list = document.getElementById('canned-list-panel');
        if (!list) return;
        const q = (query || '').toLowerCase();
        const filtered = q
            ? this.cannedReplies.filter(r => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q))
            : this.cannedReplies;
        if (!filtered.length) {
            list.innerHTML = `<div class="canned-empty">${q ? 'No results for "' + escapeHtml(q) + '"' : 'No saved replies yet. Click + Add new to create one.'}</div>`;
            return;
        }
        list.innerHTML = filtered.map(r => `
            <div class="canned-item" onclick="Inbox.useCanned(\`${r.body.replace(/`/g,"'")}\`)">
                <div class="canned-item-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </div>
                <div class="canned-item-info">
                    <div class="canned-item-title">${escapeHtml(r.title)}</div>
                    <div class="canned-item-body">${escapeHtml(r.body)}</div>
                </div>
                <div class="canned-item-more-wrap">
                    <button class="canned-item-more" onclick="event.stopPropagation(); Inbox.toggleCannedDropdown(event, ${r.id})" title="More">···</button>
                    <div class="canned-dropdown hidden" id="canned-dd-${r.id}">
                        <div class="canned-dd-item" onclick="event.stopPropagation(); Inbox.editCanned(${r.id}, \`${r.title.replace(/`/g,"'")}\`, \`${r.body.replace(/`/g,"'")}\`)">Edit</div>
                        <div class="canned-dd-item danger" onclick="event.stopPropagation(); Inbox.deleteCannedFromPanel(${r.id})">Delete</div>
                    </div>
                </div>
            </div>`).join('');
    },

    hideCannedPanel() { document.getElementById('canned-panel')?.classList.add('hidden'); },
    showSavedReplyPreview(reply) {
        const bar = document.getElementById('saved-reply-preview');
        const bodyEl = document.getElementById('srp-body');
        if (!bar || !bodyEl) return;
        bodyEl.textContent = reply.title + ' · ' + reply.body;
        bar.dataset.replyBody = reply.body;
        bar.classList.remove('hidden');
    },
    hideSavedReplyPreview() { document.getElementById('saved-reply-preview')?.classList.add('hidden'); },
    clickSavedReplyPreview(e) {
        if (e.target.classList.contains('srp-close')) return;
        const bar = document.getElementById('saved-reply-preview');
        if (!bar) return;
        this.useCanned(bar.dataset.replyBody || '');
    },
    useCanned(body) {
        const input = document.getElementById('message-input');
        if (input) { input.value = body; input.dispatchEvent(new Event('input')); input.focus(); }
        this.hideCannedPanel();
        this.hideSavedReplyPreview();
    },

    async loadCannedReplies() {
        try {
            const res = await fetchWithAuth('/api/canned-replies');
            if (res) { const d = await res.json(); this.cannedReplies = d.replies || []; }
        } catch(e) { this.cannedReplies = []; }
    },

    openCannedModal() {
        this.renderCannedList();
        document.getElementById('canned-modal').classList.remove('hidden');
    },
    closeCannedModal() {
        document.getElementById('canned-modal').classList.add('hidden');
        this._editingCannedId = null;
        const btn = document.getElementById('canned-modal-save-btn');
        if (btn) btn.textContent = 'Save Reply';
        const t = document.getElementById('cr-title');
        const b = document.getElementById('cr-body');
        if (t) t.value = '';
        if (b) b.value = '';
    },

    toggleCannedDropdown(e, id) {
        e.stopPropagation();
        document.querySelectorAll('.canned-dropdown').forEach(d => {
            if (d.id !== `canned-dd-${id}`) d.classList.add('hidden');
        });
        document.getElementById(`canned-dd-${id}`)?.classList.toggle('hidden');
    },

    editCanned(id, title, body) {
        this._editingCannedId = id;
        document.getElementById('cr-title').value = title;
        document.getElementById('cr-body').value = body;
        const btn = document.getElementById('canned-modal-save-btn');
        if (btn) btn.textContent = 'Update Reply';
        this.hideCannedPanel();
        this.openCannedModal();
    },

    deleteCannedFromPanel(id) {
        this.deleteCanned(id).then(() => this._renderCannedListPanel(''));
    },

    renderCannedList() {
        const el = document.getElementById('cr-list');
        if (!el) return;
        if (!this.cannedReplies.length) { el.innerHTML = '<div class="canned-empty" style="padding:10px 0">No quick replies yet. Add one above!</div>'; return; }
        el.innerHTML = this.cannedReplies.map(r => `
            <div class="canned-row">
                <div class="canned-row-body">
                    <div class="canned-row-title">/${escapeHtml(r.title)}</div>
                    <div class="canned-row-text">${escapeHtml(r.body)}</div>
                </div>
                <button class="del-btn" onclick="Inbox.deleteCanned(${r.id})" title="Delete">✕</button>
            </div>`).join('');
    },

    async saveNewCanned() {
        const title = document.getElementById('cr-title').value.trim();
        const body = document.getElementById('cr-body').value.trim();
        if (!title || !body) { showInboxToast('Title and message required', 'error'); return; }
        try {
            if (this._editingCannedId) {
                await fetchWithAuth(`/api/canned-replies/${this._editingCannedId}`, { method: 'DELETE' });
                this.cannedReplies = this.cannedReplies.filter(r => r.id !== this._editingCannedId);
                this._editingCannedId = null;
                const btn = document.getElementById('canned-modal-save-btn');
                if (btn) btn.textContent = 'Save Reply';
            }
            const res = await fetchWithAuth('/api/canned-replies', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, body })
            });
            if (!res) throw new Error('Network error');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            this.cannedReplies.push(data.reply);
            document.getElementById('cr-title').value = '';
            document.getElementById('cr-body').value = '';
            this.renderCannedList();
            showInboxToast('Saved!', 'success');
        } catch(e) { showInboxToast('Failed: ' + e.message, 'error'); }
    },

    async deleteCanned(id) {
        try {
            await fetchWithAuth(`/api/canned-replies/${id}`, { method: 'DELETE' });
            this.cannedReplies = this.cannedReplies.filter(r => r.id !== id);
            this.renderCannedList();
            showInboxToast('Deleted', 'success');
        } catch(e) { showInboxToast('Delete failed', 'error'); }
    },

    // ── LIGHTBOX ──
    openLightbox(url) {
        const lb = document.getElementById('lightbox');
        const img = document.getElementById('lb-img');
        if (lb && img) { img.src = url; lb.classList.remove('hidden'); }
    },
    closeLightbox(e) {
        if (e) e.stopPropagation();
        document.getElementById('lightbox')?.classList.add('hidden');
    },

    // ── SCROLL ──
    scrollToBottom() {
        const body = document.getElementById('msgs-body');
        if (body) body.scrollTop = body.scrollHeight;
        this.atBottom = true; this.newMsgCount = 0;
        document.getElementById('scroll-btn')?.classList.add('hidden');
        document.getElementById('new-msg-notif')?.classList.add('hidden');
    },

    // ── EMPTY STATE ──
    showEmpty() {
        document.getElementById('messages-panel').innerHTML = `
            <div class="msgs-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="64" height="64"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <h3>Select a conversation</h3>
                <p>Pick a conversation from the list to view and reply to messages</p>
            </div>`;
    },

    // ── REAL-TIME UPDATES ──
    handleConvUpdate(data) {
        let conv = this.conversations.find(c => c.id === data.id);
        if (conv) {
            if (data.snippet) conv.snippet = data.snippet;
            if (data.updatedTime) conv.updatedTime = data.updatedTime;
            if (!data.fromEcho && !data.isRead && data.isLive && data.id !== this.selectedConvId) {
                conv.isRead = false;
                conv.unreadCount = (conv.unreadCount || 0) + 1;
            }
            if (data.lastMessageFromPage !== undefined) conv.lastMessageFromPage = data.lastMessageFromPage;
        } else if (data.snippet) {
            conv = {
                id: data.id, pageId: data.pageId,
                participantName: data.participantName || 'Customer',
                participantId: data.participantId,
                snippet: data.snippet, updatedTime: new Date(),
                isRead: !!data.fromEcho, unreadCount: data.fromEcho ? 0 : 1,
                lastMessageFromPage: !!data.lastMessageFromPage
            };
            this.conversations.unshift(conv);
        }
        this.conversations.sort((a, b) => new Date(b.updatedTime) - new Date(a.updatedTime));
        this.renderConversations();
    },

    updatePageBadge(pageId) {
        const page = this.pages.find(p => p.id === pageId);
        if (!page) return;
        if (pageId === this.selectedPageId)
            page.unreadCount = this.conversations.filter(c => !c.isRead).length;
        this.renderPages();
    }
};

function showInboxToast(msg, type = '') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2500);
}


function showInboxToast(msg, type = '') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2500);
}

// ── Main site integration: called when user navigates to Messenger view ──────
window.initInboxForMainSite = async function() {
    // Get user token from localStorage (set by FB JS SDK login)
    let userToken = null;
    try {
        const stored = localStorage.getItem('fb_user_token');
        if (stored) {
            const parsed = JSON.parse(stored);
            userToken = parsed.token || null;
        }
    } catch (_) {}

    if (!userToken) {
        const el = document.getElementById('messages-panel');
        if (el) el.innerHTML = '<div class="msgs-empty"><h3>Please login first</h3><p>Login with Facebook to use Messenger</p></div>';
        return;
    }

    // Bridge: exchange FB token for server session
    try {
        await initCsrfToken();
        const bridgeRes = await fetch('/api/auth/fb-token', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrfToken || '' },
            body: JSON.stringify({ user_token: userToken })
        });
        const bridgeData = await bridgeRes.json();
        if (!bridgeData.authenticated) {
            console.error('Inbox auth bridge failed:', bridgeData.error);
            return;
        }
        // Update CSRF token from bridge response
        if (bridgeData.csrfToken) window._csrfToken = bridgeData.csrfToken;
    } catch (err) {
        console.error('Inbox bridge error:', err);
        return;
    }

    // Now init the Inbox — session is established
    await Inbox.init();
};

// Override DOMContentLoaded — only run on standalone inbox.html, not main site
if (window.location.pathname.includes('inbox.html')) {
    document.addEventListener('DOMContentLoaded', () => Inbox.init());
}
