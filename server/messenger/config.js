/**
 * Messenger domain configuration — single source for retention & sync tuning.
 */
const MESSAGE_RETENTION_DAYS = parseInt(process.env.MESSENGER_RETENTION_DAYS || '7', 10);
const SYNC_COOLDOWN_MS = parseInt(process.env.MESSENGER_SYNC_COOLDOWN_MS || '1800000', 10); // 30 min default
const SYNC_PARALLEL_LIMIT = parseInt(process.env.MESSENGER_SYNC_PARALLEL || '5', 10);
const BULK_INSERT_BATCH_SIZE = parseInt(process.env.MESSENGER_BULK_BATCH_SIZE || '50', 10);
const CLEANUP_DELETE_BATCH = parseInt(process.env.MESSENGER_CLEANUP_BATCH || '500', 10);
const CLEANUP_DEFER_MS = parseInt(process.env.MESSENGER_CLEANUP_DEFER_MS || '10000', 10);
const POLL_MAX_CONVS = parseInt(process.env.MESSENGER_POLL_MAX_CONVS || '40', 10);
const POLL_INTERVAL_MS = parseInt(process.env.MESSENGER_POLL_MS || '1000', 10);
const POLL_INTERVAL_SOCKET_MS = parseInt(process.env.MESSENGER_POLL_SOCKET_MS || '1000', 10);
const CONVERSATION_PAGE_SIZE_MAX = 100;
const CONVERSATION_INITIAL_LIMIT = parseInt(process.env.MESSENGER_CONV_INITIAL || '30', 10);
const CONV_LIST_CACHE_MS = parseInt(process.env.MESSENGER_CONV_CACHE_MS || '5000', 10);
const SYNC_MAX_FB_PAGES = parseInt(process.env.MESSENGER_SYNC_MAX_FB_PAGES || '50', 10);
const SYNC_MAX_CONVERSATIONS = parseInt(process.env.MESSENGER_SYNC_MAX_CONVS || '10000', 10);
const SYNC_MESSAGE_THREADS_MAX = parseInt(process.env.MESSENGER_SYNC_MSG_THREADS || '200', 10);
const SYNC_BG_CHUNK_SIZE  = parseInt(process.env.MESSENGER_SYNC_BG_CHUNK  || '100', 10);
const SYNC_BG_CHUNK_DELAY = parseInt(process.env.MESSENGER_SYNC_BG_DELAY  || '45000', 10); // 45s gap between chunks
const SEARCH_MIN_CHARS = parseInt(process.env.MESSENGER_SEARCH_MIN_CHARS || '1', 10);
const SEARCH_CONV_LIMIT = parseInt(process.env.MESSENGER_SEARCH_CONV_LIMIT || '50', 10);
const SEARCH_MSG_LIMIT = parseInt(process.env.MESSENGER_SEARCH_MSG_LIMIT || '40', 10);
const SEARCH_CACHE_MS = parseInt(process.env.MESSENGER_SEARCH_CACHE_MS || '8000', 10);
const MESSAGE_PAGE_SIZE_MAX = 100;
const CONVERSATION_RETENTION_DAYS = parseInt(process.env.MESSENGER_CONV_RETENTION_DAYS || '180', 10);
/** Re-login / return visit: full sync if last sync older than this (default 15 min). */
const RELOGIN_SYNC_GAP_MS = parseInt(process.env.MESSENGER_RELOGIN_SYNC_MS || String(15 * 60 * 1000), 10);
/** While inbox is open: refresh open thread from Graph (Business Suite / external replies). */
const ACTIVE_THREAD_SYNC_MS = parseInt(process.env.MESSENGER_ACTIVE_THREAD_SYNC_MS || '2000', 10);
/** While inbox is open (no thread): refresh hottest convs from Graph. */
const ACTIVE_PAGE_SYNC_MS = parseInt(process.env.MESSENGER_ACTIVE_PAGE_SYNC_MS || '12000', 10);
const HOT_CONV_SYNC_LIMIT = parseInt(process.env.MESSENGER_HOT_CONV_SYNC || '10', 10);
/** Refresh conversation list snippet/time from Facebook while inbox is open. */
const CONVERSATION_LIST_SYNC_MS = parseInt(process.env.MESSENGER_LIST_SYNC_MS || '60000', 10);
/** Inbox poll (no thread open) — Meta list/snippet refresh cadence. */
const CONVERSATION_LIST_SYNC_POLL_MS = parseInt(process.env.MESSENGER_LIST_SYNC_POLL_MS || '5000', 10);
/** While a thread is open — still pull FB list order (Meta Business Suite sends). */
const CONVERSATION_LIST_SYNC_ACTIVE_MS = parseInt(process.env.MESSENGER_LIST_SYNC_ACTIVE_MS || '5000', 10);
const CONVERSATION_LIST_SINCE_SEC = parseInt(process.env.MESSENGER_LIST_SINCE_SEC || '900', 10);
const FB_GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v19.0';
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;
/** Meta Page Inbox app — pass thread here so Business Suite shows read after FBCast reply. */
const FB_PAGE_INBOX_APP_ID = process.env.FB_PAGE_INBOX_APP_ID || '263902037430900';
/** castme app from Conversation Routing (must match Railway FB_APP_ID). */
const FB_CASTME_APP_ID = process.env.FB_CASTME_APP_ID || '1841422713196772';
const FB_HANDOVER_ENABLED = process.env.FB_HANDOVER_ENABLED !== '0';

function retentionCutoff() {
    return new Date(Date.now() - MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function retentionCutoffUnix() {
    return Math.floor(retentionCutoff().getTime() / 1000);
}

function isWithinRetention(createdTime) {
    if (!createdTime) return true;
    const t = createdTime instanceof Date ? createdTime : new Date(createdTime);
    return !isNaN(t) && t >= retentionCutoff();
}

module.exports = {
    MESSAGE_RETENTION_DAYS,
    SYNC_COOLDOWN_MS,
    SYNC_PARALLEL_LIMIT,
    BULK_INSERT_BATCH_SIZE,
    CLEANUP_DELETE_BATCH,
    CLEANUP_DEFER_MS,
    POLL_MAX_CONVS,
    POLL_INTERVAL_MS,
    POLL_INTERVAL_SOCKET_MS,
    CONVERSATION_PAGE_SIZE_MAX,
    CONVERSATION_INITIAL_LIMIT,
    CONV_LIST_CACHE_MS,
    SYNC_MAX_FB_PAGES,
    SYNC_MAX_CONVERSATIONS,
    SYNC_MESSAGE_THREADS_MAX,
    SYNC_BG_CHUNK_SIZE,
    SYNC_BG_CHUNK_DELAY,
    SEARCH_MIN_CHARS,
    SEARCH_CONV_LIMIT,
    SEARCH_MSG_LIMIT,
    SEARCH_CACHE_MS,
    MESSAGE_PAGE_SIZE_MAX,
    CONVERSATION_RETENTION_DAYS,
    RELOGIN_SYNC_GAP_MS,
    ACTIVE_THREAD_SYNC_MS,
    ACTIVE_PAGE_SYNC_MS,
    HOT_CONV_SYNC_LIMIT,
    CONVERSATION_LIST_SYNC_MS,
    CONVERSATION_LIST_SYNC_POLL_MS,
    CONVERSATION_LIST_SYNC_ACTIVE_MS,
    CONVERSATION_LIST_SINCE_SEC,
    FB_GRAPH_VERSION,
    FB_GRAPH_BASE,
    FB_PAGE_INBOX_APP_ID,
    FB_CASTME_APP_ID,
    FB_HANDOVER_ENABLED,
    retentionCutoff,
    retentionCutoffUnix,
    isWithinRetention
};
