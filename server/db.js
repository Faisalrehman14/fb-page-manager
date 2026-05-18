require('./config/env');
const mysql = require('mysql2/promise');

let pool = null;
const syncStatus = new Map(); // pageId -> boolean
let dbErrorLogs = [];

// ── Conv-lookup in-process cache ──────────────────────────────────────────────
// Avoids a DB round-trip on every send and every webhook receive for hot convs.
const _convIdCache = new Map(); // `${pageId}:${psid}` → { id, fbConvId, exp }
const CONV_ID_CACHE_TTL = 5 * 60 * 1000;

// Normalises legacy attachment_url values that were stored as a JSON array before
// the column was split into attachment_url (plain URL) + attachment_type.
function _readAttachment(rawUrl, rawType) {
    if (!rawUrl) return { url: null, type: rawType || null };
    if (rawUrl[0] === '[') {
        try {
            const arr = JSON.parse(rawUrl);
            return { url: arr[0]?.u || null, type: arr[0]?.t || rawType || null };
        } catch { return { url: null, type: rawType || null }; }
    }
    return { url: rawUrl, type: rawType || null };
}

const {
    MESSAGE_RETENTION_DAYS,
    CONVERSATION_RETENTION_DAYS,
    retentionCutoff: messageRetentionCutoff,
    retentionCutoffUnix: messageRetentionCutoffUnix,
    isWithinRetention: isWithinMessageRetention,
    SYNC_PARALLEL_LIMIT,
    SYNC_BG_CHUNK_SIZE,
    SYNC_BG_CHUNK_DELAY,
    BULK_INSERT_BATCH_SIZE,
    CLEANUP_DELETE_BATCH,
    CLEANUP_DEFER_MS
} = require('./messenger/config');

const cleanupTimers = new Map();
const addDbError = (err) => {
    dbErrorLogs.unshift({ time: new Date().toISOString(), err });
    if (dbErrorLogs.length > 20) dbErrorLogs.pop();
};

async function initDatabase() {
    let connectionString = process.env.DATABASE_URL || process.env.MYSQL_URL;

    // If no full URL, try to build it from individual Railway variables
    if (!connectionString && process.env.MYSQLHOST) {
        const user = process.env.MYSQLUSER || 'root';
        const password = process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD;
        const host = process.env.MYSQLHOST;
        const port = process.env.MYSQLPORT || 3306;
        const database = process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE;
        
        if (host && password && database) {
            connectionString = `mysql://${user}:${password}@${host}:${port}/${database}`;
            console.log('DB: Constructed connection string from individual variables');
        }
    }

    if (!connectionString) {
        console.log('DATABASE_URL or MYSQL_URL not set - running without persistent storage');
        initDatabase.lastError = 'Environment variable DATABASE_URL or MYSQL_URL is missing, and could not construct from individual MYSQL variables';
        return null;
    }

    try {
        console.log('Connecting to MySQL...');
        
        // Configuration for the pool - Optimized for Cloud Environments
        const config = {
            uri: connectionString,
            waitForConnections: true,
            connectionLimit: 5,   // fewer idle connections = fewer stale TCP sockets
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0, // send TCP keepalive probes immediately when idle
            connectTimeout: 20000,
            // Add SSL support for cloud databases (Railway, Aiven, etc.)
            ssl: (connectionString.includes('railway') || 
                  connectionString.includes('aiven') || 
                  connectionString.includes('digitalocean') ||
                  connectionString.includes('ssl') ||
                  process.env.NODE_ENV === 'production') ? 
                 { rejectUnauthorized: false } : undefined
        };

        pool = mysql.createPool(config);

        // Catch idle connection errors so the process doesn't crash
        pool.on('error', (err) => {
            addDbError(`pool_error: ${err.message}`);
            console.error('DB pool error:', err.message);
        });

        // Test connection
        const connection = await pool.getConnection();
        console.log('MySQL connected successfully');

        // ── Free disk space — sessions table caused Railway disk exhaustion ──
        // We no longer use MySQL for sessions (switched to in-memory store),
        // so drop the table entirely to reclaim disk space.
        try { await connection.query('DROP TABLE IF EXISTS sessions'); } catch (_) {}
        try { await connection.query('DELETE FROM messenger_sync_logs WHERE created_at < NOW() - INTERVAL 3 DAY'); } catch (_) {}
        try { await connection.query('DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL 7 DAY'); } catch (_) {}
        console.log('DB: disk cleanup done');

        // Helper — each CREATE TABLE is isolated so one failure doesn't abort the rest
        const tryCreate = async (sql) => {
            try { await connection.query(sql); } catch (e) {
                addDbError(`CREATE TABLE failed: ${e.message.substring(0, 120)}`);
                console.warn('DB: table create failed (non-fatal):', e.message.substring(0, 80));
            }
        };

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS messenger_pages (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fb_page_id VARCHAR(64) NOT NULL,
                access_token TEXT NOT NULL,
                name VARCHAR(255) DEFAULT NULL,
                avatar_url TEXT DEFAULT NULL,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                last_synced_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_fb_page_id (fb_page_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS messenger_conversations (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                page_id VARCHAR(64) NOT NULL,
                fb_user_id VARCHAR(64) NOT NULL,
                fb_conv_id VARCHAR(128) DEFAULT NULL,
                user_name VARCHAR(255) NOT NULL DEFAULT 'User',
                user_picture TEXT DEFAULT NULL,
                snippet TEXT DEFAULT NULL,
                last_from_me TINYINT(1) DEFAULT NULL,
                is_unread SMALLINT UNSIGNED NOT NULL DEFAULT 0,
                can_reply TINYINT(1) NOT NULL DEFAULT 1,
                updated_at DATETIME DEFAULT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_page_user (page_id, fb_user_id),
                KEY idx_inbox (page_id, updated_at DESC),
                KEY idx_inbox_reply (page_id, can_reply, updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS messenger_messages (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                conversation_id INT UNSIGNED NOT NULL,
                page_id VARCHAR(64) NOT NULL,
                user_id VARCHAR(64) DEFAULT NULL,
                message_id VARCHAR(128) DEFAULT NULL,
                message TEXT DEFAULT NULL,
                from_me TINYINT(1) NOT NULL DEFAULT 0,
                attachment_url TEXT DEFAULT NULL,
                attachment_type VARCHAR(100) DEFAULT NULL,
                metadata JSON DEFAULT NULL,
                is_read TINYINT(1) NOT NULL DEFAULT 0,
                is_archived TINYINT(1) NOT NULL DEFAULT 0,
                delivered_at DATETIME DEFAULT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_message_id (message_id),
                KEY idx_conv_time (conversation_id, created_at DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Optional table — allowed to fail (e.g. disk full)
        await tryCreate(`
            CREATE TABLE IF NOT EXISTS messenger_sync_logs (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                page_id VARCHAR(64) NOT NULL,
                phase VARCHAR(64) NOT NULL,
                status VARCHAR(32) NOT NULL,
                total INT DEFAULT 0,
                done INT DEFAULT 0,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_page_status (page_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // ── Migrations (safe column additions) ───────────────────────────
        const migrations = [
            "ALTER TABLE messenger_conversations ADD COLUMN fb_conv_id VARCHAR(128) DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN last_from_me TINYINT(1) DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN is_unread SMALLINT UNSIGNED NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_conversations ADD COLUMN updated_at DATETIME DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN user_name VARCHAR(255) NOT NULL DEFAULT 'User'",
            "ALTER TABLE messenger_conversations ADD COLUMN user_picture TEXT DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN fb_user_id VARCHAR(64) NOT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN conversation_id INT UNSIGNED",
            "ALTER TABLE messenger_messages ADD COLUMN message TEXT",
            "ALTER TABLE messenger_messages ADD COLUMN from_me TINYINT(1) DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN metadata JSON",
            "ALTER TABLE messenger_messages ADD COLUMN is_read TINYINT(1) DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN delivered_at DATETIME",
            "ALTER TABLE messenger_pages ADD COLUMN fb_page_id VARCHAR(64)",
            "ALTER TABLE messenger_pages ADD COLUMN last_synced_at DATETIME NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_conversations ADD COLUMN can_reply TINYINT(1) NOT NULL DEFAULT 1",
            "ALTER TABLE messenger_conversations ADD INDEX idx_page_updated (page_id, updated_at DESC)",
            "ALTER TABLE messenger_conversations ADD INDEX idx_inbox_reply (page_id, can_reply, updated_at)",
            // Speeds up stale-conversation cleanup scan (no page_id filter needed)
            "ALTER TABLE messenger_conversations ADD INDEX idx_conv_updated_at (updated_at)",
            "ALTER TABLE users ADD COLUMN fb_name VARCHAR(255) DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN fb_access_token TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN free_trial_expires_at DATETIME NULL",
            "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45) DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL",
            "ALTER TABLE users ADD COLUMN plan_activated_at DATETIME NULL"
        ];
        for (const sql of migrations) {
            try { await connection.query(sql); } catch (_) { /* column already exists */ }
        }
        try {
            await connection.query(
                `UPDATE users SET free_trial_expires_at = DATE_ADD(COALESCE(created_at, NOW()), INTERVAL ? DAY)
                 WHERE plan = 'free' AND free_trial_expires_at IS NULL`,
                [FREE_TRIAL_DAYS]
            );
        } catch (_) { /* column may not exist yet on very old DBs */ }

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS users (
                fb_user_id VARCHAR(50) PRIMARY KEY,
                email VARCHAR(255),
                plan ENUM('free','basic','pro','gold','sapphire','platinum','unknown') DEFAULT 'free',
                messenger_messages_used INT DEFAULT 0,
                messenger_messages_limit INT DEFAULT 2000,
                stripe_customer_id VARCHAR(255),
                stripe_subscription_id VARCHAR(255),
                subscription_expires DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_stripe_cust (stripe_customer_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS payment_history (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fb_user_id VARCHAR(50) NOT NULL,
                stripe_invoice_id VARCHAR(255) NOT NULL DEFAULT '',
                plan VARCHAR(32) NOT NULL DEFAULT 'unknown',
                amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
                status ENUM('succeeded','failed','pending') NOT NULL DEFAULT 'pending',
                billing_reason VARCHAR(80) NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_payment_user (fb_user_id),
                INDEX idx_payment_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS webhook_events (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                event_id VARCHAR(255) NOT NULL UNIQUE,
                event_type VARCHAR(120) NOT NULL,
                status ENUM('processing','processed','failed') NOT NULL DEFAULT 'processing',
                attempts INT UNSIGNED NOT NULL DEFAULT 1,
                payload MEDIUMTEXT NULL,
                last_error TEXT NULL,
                received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processed_at DATETIME NULL DEFAULT NULL,
                INDEX idx_webhook_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS activity_log (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fb_user_id VARCHAR(50) NOT NULL,
                action VARCHAR(50) NOT NULL,
                detail TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_act_user (fb_user_id),
                INDEX idx_act_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS user_fb_pages (
                fb_user_id VARCHAR(50) NOT NULL,
                fb_page_id VARCHAR(64) NOT NULL,
                page_name VARCHAR(255) DEFAULT NULL,
                page_url VARCHAR(512) DEFAULT NULL,
                linked_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (fb_user_id, fb_page_id),
                INDEX idx_ufp_user (fb_user_id),
                INDEX idx_ufp_page (fb_page_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS canned_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS conversation_notes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                conversation_id VARCHAR(255) NOT NULL,
                page_id VARCHAR(255) NOT NULL,
                author VARCHAR(255) NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_conv_id (conversation_id),
                INDEX idx_page_id (page_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fb_user_id VARCHAR(50) NOT NULL,
                page_id VARCHAR(64) NOT NULL,
                page_name VARCHAR(255) DEFAULT NULL,
                page_token TEXT NOT NULL,
                message TEXT NOT NULL,
                image_url TEXT DEFAULT NULL,
                delay_ms INT NOT NULL DEFAULT 1200,
                scheduled_at DATETIME NOT NULL,
                status ENUM('pending','running','done','failed','cancelled') DEFAULT 'pending',
                total_recipients INT DEFAULT 0,
                sent_count INT DEFAULT 0,
                failed_count INT DEFAULT 0,
                error_message TEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_status_time (status, scheduled_at),
                INDEX idx_user (fb_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS broadcast_history (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fb_user_id VARCHAR(50) NOT NULL,
                mode ENUM('manual','auto','scheduled') NOT NULL DEFAULT 'manual',
                page_id VARCHAR(64) DEFAULT NULL,
                pages_count INT UNSIGNED NOT NULL DEFAULT 1,
                total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
                sent_count INT UNSIGNED NOT NULL DEFAULT 0,
                failed_count INT UNSIGNED NOT NULL DEFAULT 0,
                message_preview VARCHAR(160) DEFAULT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_bh_user_time (fb_user_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await tryCreate(`
            CREATE TABLE IF NOT EXISTS user_preferences (
                fb_user_id VARCHAR(50) PRIMARY KEY,
                notif_broadcast TINYINT(1) NOT NULL DEFAULT 1,
                notif_failed TINYINT(1) NOT NULL DEFAULT 1,
                default_delay_ms INT NOT NULL DEFAULT 1200,
                message_draft TEXT DEFAULT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        connection.release();
        console.log('Database tables verified');
        pool.lastError = null;
        return pool;
    } catch (err) {
        // Only fatal if we couldn't even connect
        console.error('MySQL connection failed:', err.message);
        addDbError(`Connection failed: ${err.message}`);
        if (pool) { pool.lastError = err.message; return pool; } // Still return pool if connected
        initDatabase.lastError = err.message;
        pool = null;
        return null;
    }
}

function getLastError() {
    return pool?.lastError || initDatabase.lastError || null;
}

function isPageSyncing(pageId) {
    return !!syncStatus.get(pageId);
}

function isConnected() {
    return pool !== null;
}

// =============================================================================
// Page Operations
// =============================================================================

async function savePage(page) {
    if (!pool) return;
    const { id, name, picture, accessToken } = page;
    try {
        await pool.query(`
            INSERT INTO messenger_pages (fb_page_id, name, avatar_url, access_token)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                avatar_url = VALUES(avatar_url),
                access_token = VALUES(access_token),
                updated_at = CURRENT_TIMESTAMP
        `, [id, name, picture, accessToken]);
    } catch (err) {
        addDbError(`savePage: ${err.message}`);
    }
}

async function savePages(messenger_pages) {
    for (const page of messenger_pages) {
        await savePage(page);
    }
}

async function getPages() {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT fb_page_id as id, name, avatar_url as picture, access_token, last_synced_at, created_at, updated_at
            FROM messenger_pages
            ORDER BY name ASC
        `);
        return rows;
    } catch (err) {
        addDbError(`getPages: ${err.message}`);
        return [];
    }
}

async function getPageToken(pageId) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT access_token FROM messenger_pages WHERE fb_page_id = ?',
            [pageId]
        );
        return rows[0]?.access_token || null;
    } catch (err) {
        addDbError(`getPageToken: ${err.message}`);
        return null;
    }
}

// =============================================================================
// Conversation Operations
// =============================================================================

/** Inbox list: replyable, non-archived threads (conversations are never auto-deleted). */
function _inboxWhere(alias = 'c', archived = false) {
    if (archived) {
        return `${alias}.page_id = ? AND COALESCE(${alias}.archived, 0) = 1`;
    }
    return `${alias}.page_id = ? AND COALESCE(${alias}.archived, 0) = 0` +
        ` AND COALESCE(${alias}.can_reply, 1) = 1`;
}

function _inboxParams(pageId) {
    return [pageId];
}

/** Inbox list only — search uses {@link _searchWhere} (includes cannot-reply threads). */
function _searchWhere(alias = 'c') {
    return `${alias}.page_id = ? AND COALESCE(${alias}.archived, 0) = 0`;
}

function _nameMatchesSearch(text, query) {
    const hay = String(text || '').toLowerCase();
    const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    return words.every(w => hay.includes(w));
}

function _searchNameSql(term) {
    const words = String(term || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { clause: '0', params: [] };
    const parts = [];
    const params = [];
    for (const w of words) {
        const like = `%${w}%`;
        parts.push(
            `(LOWER(COALESCE(c.user_name, '')) LIKE ? OR LOWER(COALESCE(c.snippet, '')) LIKE ? OR c.fb_user_id LIKE ?)`
        );
        params.push(like, like, `%${w}%`);
    }
    return { clause: parts.join(' AND '), params };
}

async function markCannotReply(pageId, participantIds) {
    if (!pool || !pageId) return;
    const ids = Array.isArray(participantIds) ? participantIds : [participantIds];
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    try {
        const ph = unique.map(() => '?').join(',');
        await pool.query(
            `UPDATE messenger_conversations SET can_reply = 0 WHERE page_id = ? AND fb_user_id IN (${ph})`,
            [pageId, ...unique]
        );
    } catch (err) {
        addDbError(`markCannotReply: ${err.message}`);
    }
}

async function saveConversation(conversation) {
    if (!pool) return;
    const { id, pageId, participantId, participantName, snippet, updatedTime, isRead, unreadCount, canReply, lastFromMe } = conversation;
    if (!pageId || !participantId) return; // fb_user_id is NOT NULL — skip rather than fail
    const fbUnreadCount = unreadCount != null ? unreadCount : (isRead ? 0 : 1);
    const canReplyVal = canReply === false ? 0 : 1;
    const lastFromMeVal = lastFromMe === true || lastFromMe === 1
        ? 1
        : (lastFromMe === false || lastFromMe === 0
            ? 0
            : (/^you:/i.test(String(snippet || '').trim()) ? 1 : 0));

    try {
        await pool.query(`
            INSERT INTO messenger_conversations (page_id, fb_user_id, fb_conv_id, user_name, snippet, updated_at, is_unread, can_reply, last_from_me)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                fb_conv_id = COALESCE(VALUES(fb_conv_id), fb_conv_id),
                user_name = VALUES(user_name),
                snippet = VALUES(snippet),
                updated_at = IF(
                    NOT (snippet <=> VALUES(snippet))
                    OR NOT (is_unread <=> VALUES(is_unread))
                    OR NOT (last_from_me <=> VALUES(last_from_me)),
                    VALUES(updated_at),
                    updated_at
                ),
                is_unread = VALUES(is_unread),
                can_reply = VALUES(can_reply),
                last_from_me = VALUES(last_from_me)
        `, [pageId, participantId, id, participantName, snippet, updatedTime ? new Date(updatedTime) : null, fbUnreadCount, canReplyVal, lastFromMeVal]);
    } catch (err) {
        addDbError(`saveConversation: ${err.message}`);
    }
}

async function saveConversations(messenger_conversations) {
    if (!pool || !messenger_conversations?.length) return;
    if (messenger_conversations.length === 1) {
        await saveConversation(messenger_conversations[0]).catch(() => {});
        return;
    }

    const valid = messenger_conversations.filter(c => c.pageId && c.participantId);
    for (let i = 0; i < valid.length; i += BULK_INSERT_BATCH_SIZE) {
        const batch = valid.slice(i, i + BULK_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
        const params = batch.flatMap(c => {
            const fbUnreadCount = c.unreadCount != null ? c.unreadCount : (c.isRead ? 0 : 1);
            const snip = (c.snippet || '').substring(0, 200);
            const lastFromMeVal = c.lastFromMe === true || c.lastFromMe === 1
                ? 1
                : (c.lastFromMe === false || c.lastFromMe === 0 ? 0 : (/^you:/i.test(snip.trim()) ? 1 : 0));
            return [
                c.pageId,
                c.participantId,
                c.id || null,
                c.participantName || 'User',
                snip,
                c.updatedTime ? new Date(c.updatedTime) : null,
                fbUnreadCount,
                c.canReply === false ? 0 : 1,
                lastFromMeVal
            ];
        });
        try {
            await pool.query(`
                INSERT INTO messenger_conversations (page_id, fb_user_id, fb_conv_id, user_name, snippet, updated_at, is_unread, can_reply, last_from_me)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    fb_conv_id = COALESCE(VALUES(fb_conv_id), fb_conv_id),
                    user_name = VALUES(user_name),
                    snippet = VALUES(snippet),
                    updated_at = IF(
                        NOT (snippet <=> VALUES(snippet))
                        OR NOT (is_unread <=> VALUES(is_unread))
                        OR NOT (last_from_me <=> VALUES(last_from_me)),
                        VALUES(updated_at),
                        updated_at
                    ),
                    is_unread = VALUES(is_unread),
                    can_reply = VALUES(can_reply),
                    last_from_me = VALUES(last_from_me)
            `, params);
        } catch (err) {
            addDbError(`saveConversationsBatch: ${err.message}`);
            for (const c of batch) await saveConversation(c).catch(() => {});
        }
    }
}

async function getConversations(pageId, limit = 100, offset = 0, archived = false) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id AS participant_id, c.user_name AS participant_name,
                   c.user_picture AS participant_picture, c.snippet, c.updated_at AS updated_time,
                   c.is_unread, c.last_from_me, c.can_reply
            FROM messenger_conversations c
            WHERE ${_inboxWhere('c', archived)}
            ORDER BY c.updated_at DESC
            LIMIT ? OFFSET ?
        `, [..._inboxParams(pageId, archived), limit, offset]);
        const { normalizeSnippetForList } = require('./messenger/message-content');
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            participantPicture: row.participant_picture,
            snippet: normalizeSnippetForList(row.snippet || ''),
            updatedTime: row.updated_time,
            isRead: row.is_unread === 0,
            unreadCount: row.is_unread || 0,
            lastMessageFromPage: row.last_from_me === 1,
            canReply: row.can_reply !== 0
        }));
    } catch (err) {
        addDbError(`getConversations: ${err.message}`);
        return [];
    }
}

async function searchConversations(pageId, query, limit = 50) {
    if (!pool) return [];
    const term = String(query || '').trim();
    if (term.length < 1) return [];
    const { clause, params: nameParams } = _searchNameSql(term);
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id AS participant_id, c.user_name AS participant_name,
                   c.user_picture AS participant_picture, c.snippet, c.updated_at AS updated_time, c.is_unread
            FROM messenger_conversations c
            WHERE ${_searchWhere('c')} AND (${clause})
            ORDER BY c.updated_at DESC
            LIMIT ?
        `, [..._inboxParams(pageId), ...nameParams, limit]);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            participantPicture: row.participant_picture,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: (row.is_unread || 0) === 0,
            unreadCount: row.is_unread || 0
        }));
    } catch (err) {
        addDbError(`searchConversations: ${err.message}`);
        return [];
    }
}

/**
 * Server-side inbox search — scans DB only (no need to load full conv list in UI).
 */
async function searchInbox(pageId, query, limits = {}) {
    const {
        SEARCH_CONV_LIMIT,
        SEARCH_MSG_LIMIT
    } = require('./messenger/config');
    const term = String(query || '').trim();
    if (!pool || term.length < 1) {
        return { conversations: [], messages: [] };
    }

    const convLimit = limits.conversations ?? SEARCH_CONV_LIMIT;
    const msgLimit = limits.messages ?? SEARCH_MSG_LIMIT;

    const [conversations, messages] = await Promise.all([
        searchConversations(pageId, term, convLimit),
        searchMessages(pageId, term, msgLimit)
    ]);

    return { conversations, messages };
}

/**
 * Scan Facebook conversation list for name/snippet matches (like Meta inbox search).
 * Saves hits to DB so they appear on next load.
 */
async function searchConversationsFromFacebook(pageId, pageToken, fetchFn, query, opts = {}) {
    const term = String(query || '').trim();
    if (!term || !pageToken || !fetchFn) return [];

    const maxPages = opts.maxPages ?? 12;
    const maxMatches = opts.maxMatches ?? 40;
    const matches = [];
    const toSave = [];

    let nextUrl = buildConversationsUrl(pageId, pageToken, null, opts.fbLimit ?? 100);
    let pages = 0;

    while (nextUrl && pages < maxPages && matches.length < maxMatches) {
        pages++;
        const response = await fetchFn(nextUrl);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        for (const conv of data.data || []) {
            const participants = conv.participants?.data || [];
            const participant = participants.find(p => String(p.id) !== String(pageId))
                || participants.find(p => p.id) || null;
            if (!participant?.id) continue;

            const name = participant.name || '';
            const rawSnip = (conv.snippet || '').substring(0, 200);
            const { normalizeSnippetForList, snippetIndicatesFromPage } = require('./messenger/message-content');
            const snip = normalizeSnippetForList(rawSnip);
            const hit = _nameMatchesSearch(name, term)
                || _nameMatchesSearch(snip, term)
                || _nameMatchesSearch(rawSnip, term)
                || String(participant.id).includes(term);
            if (!hit) continue;

            const row = {
                id: conv.id,
                pageId,
                participantId: String(participant.id),
                participantName: name || 'User',
                snippet: snip,
                updatedTime: conv.updated_time,
                isRead: (conv.unread_count || 0) === 0,
                unreadCount: conv.unread_count || 0,
                canReply: conv.can_reply !== false,
                lastFromMe: snippetIndicatesFromPage(rawSnip)
            };
            matches.push({
                id: row.id,
                pageId: row.pageId,
                participantId: row.participantId,
                participantName: row.participantName,
                participantPicture: null,
                snippet: row.snippet,
                updatedTime: row.updatedTime,
                isRead: row.isRead,
                unreadCount: row.unreadCount
            });
            toSave.push(row);
            if (matches.length >= maxMatches) break;
        }

        nextUrl = data.paging?.next || null;
    }

    if (toSave.length) await saveConversations(toSave);
    return matches;
}

async function getConversationCount(pageId, archived = false) {
    if (!pool) return 0;
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM messenger_conversations c WHERE ${_inboxWhere('c', archived)}`,
            _inboxParams(pageId, archived)
        );
        return Number(rows[0]?.cnt || 0);
    } catch (err) {
        addDbError(`getConversationCount: ${err.message}`);
        return 0;
    }
}

// Get all messenger_conversations for multiple messenger_pages in one query (optimized for performance)
async function getConversationsBulk(pageIds, limitPerPage = 100) {
    if (!pool || !pageIds || pageIds.length === 0) return {};

    try {
        const placeholders = pageIds.map(() => '?').join(',');
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id as participant_id, c.user_name as participant_name,
                   c.snippet, c.updated_at as updated_time, c.is_unread, c.last_from_me,
                   p.name as page_name, p.avatar_url as page_picture
            FROM messenger_conversations c
            LEFT JOIN messenger_pages p ON c.page_id = p.fb_page_id
            WHERE c.page_id IN (${placeholders})
              AND COALESCE(c.can_reply, 1) = 1
            ORDER BY c.page_id, c.updated_at DESC
        `, pageIds);

        const result = {};
        for (const pageId of pageIds) result[pageId] = [];
        for (const row of rows) {
            if (!result[row.page_id]) result[row.page_id] = [];
            if (result[row.page_id].length < limitPerPage) {
                result[row.page_id].push({
                    id: row.id,
                    pageId: row.page_id,
                    participantId: row.participant_id,
                    participantName: row.participant_name,
                    snippet: row.snippet,
                    updatedTime: row.updated_time,
                    isRead: (row.is_unread || 0) === 0,
                    unreadCount: row.is_unread || 0,
                    pageName: row.page_name,
                    pagePicture: row.page_picture,
                    lastMessageFromPage: row.last_from_me === 1
                });
            }
        }
        return result;
    } catch (err) {
        addDbError(`getConversationsBulk: ${err.message}`);
        return {};
    }
}

async function getUnreadCountsForPages(pageIds) {
    if (!pool || !pageIds.length) return {};
    try {
        const placeholders = pageIds.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT page_id, COUNT(*) AS cnt FROM messenger_conversations
             WHERE page_id IN (${placeholders}) AND is_unread > 0
               AND COALESCE(can_reply, 1) = 1
             GROUP BY page_id`,
            pageIds
        );
        const result = {};
        for (const row of rows) result[row.page_id] = Number(row.cnt);
        return result;
    } catch (err) {
        addDbError(`getUnreadCountsForPages: ${err.message}`);
        return {};
    }
}

/**
 * Cross-page inbox poll — unread totals + recent customer messages on other pages.
 */
async function pollAllPagesInbox(pageIds, opts = {}) {
    const unreadByPage = await getUnreadCountsForPages(pageIds || []);
    const notifications = [];
    if (!pool || !pageIds?.length) return { unreadByPage, notifications };

    const since = opts.since;
    if (!since) return { unreadByPage, notifications };

    const sinceDate = since instanceof Date ? since : new Date(since);
    if (isNaN(sinceDate.getTime())) return { unreadByPage, notifications };

    const activePageId = opts.activePageId ? String(opts.activePageId) : null;
    const activePsid = opts.activePsid ? String(opts.activePsid) : null;
    const cap = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), 50);

    try {
        const placeholders = pageIds.map(() => '?').join(',');
        const params = [...pageIds, sinceDate];
        let excludeOpen = '';
        if (activePageId && activePsid) {
            excludeOpen = ' AND NOT (page_id = ? AND fb_user_id = ?)';
            params.push(activePageId, activePsid);
        }
        const [rows] = await pool.query(
            `SELECT page_id, fb_user_id, user_name, snippet, updated_at
             FROM messenger_conversations
             WHERE page_id IN (${placeholders})
               AND updated_at > ?
               AND is_unread > 0
               AND COALESCE(last_from_me, 0) = 0
               AND COALESCE(can_reply, 1) = 1
               ${excludeOpen}
             ORDER BY updated_at DESC
             LIMIT ${cap}`,
            params
        );
        for (const r of rows || []) {
            notifications.push({
                page_id: r.page_id,
                fb_user_id: r.fb_user_id,
                user_name: r.user_name,
                snippet: r.snippet,
                updated_at: r.updated_at
            });
        }
    } catch (err) {
        addDbError(`pollAllPagesInbox: ${err.message}`);
    }

    return { unreadByPage, notifications };
}

async function getConversationIdByParticipant(pageId, participantId) {
    if (!pool) return null;
    const key = `${pageId}:${participantId}`;
    const hit = _convIdCache.get(key);
    if (hit && hit.exp > Date.now()) return { id: hit.id, fbConvId: hit.fbConvId };
    try {
        const [rows] = await pool.query(
            'SELECT id, fb_conv_id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?',
            [pageId, participantId]
        );
        if (rows[0]) {
            const result = { id: rows[0].id, fbConvId: rows[0].fb_conv_id || null };
            _convIdCache.set(key, { ...result, exp: Date.now() + CONV_ID_CACHE_TTL });
            return result;
        }
        return null;
    } catch (err) {
        addDbError(`getConversationIdByParticipant: ${err.message}`);
        return null;
    }
}

async function getConversationById(convId) {
    if (!pool || !convId) return null;
    try {
        const [rows] = await pool.query(
            'SELECT id, page_id, fb_user_id FROM messenger_conversations WHERE id = ? LIMIT 1',
            [convId]
        );
        return rows[0] || null;
    } catch (err) {
        addDbError(`getConversationById: ${err.message}`);
        return null;
    }
}

async function getPagePsids(pageId) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(
            'SELECT DISTINCT fb_user_id FROM messenger_conversations WHERE page_id = ? AND fb_user_id IS NOT NULL AND fb_user_id != ""',
            [pageId]
        );
        return rows.map(r => r.fb_user_id);
    } catch (err) {
        addDbError(`getPagePsids: ${err.message}`);
        return [];
    }
}

async function getAllConversations() {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id as participant_id, c.user_name as participant_name,
                   c.snippet, c.updated_at as updated_time, c.is_unread, c.last_from_me,
                   p.name as page_name, p.avatar_url as page_picture
            FROM messenger_conversations c
            LEFT JOIN messenger_pages p ON c.page_id = p.fb_page_id
            WHERE COALESCE(c.can_reply, 1) = 1
            ORDER BY c.updated_at DESC
        `);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: (row.is_unread || 0) === 0,
            unreadCount: row.is_unread || 0,
            pageName: row.page_name,
            pagePicture: row.page_picture,
            lastMessageFromPage: row.last_from_me === 1
        }));
    } catch (err) {
        addDbError(`getAllConversations: ${err.message}`);
        return [];
    }
}

// =============================================================================
// Message Operations
// =============================================================================

async function saveMessage(message) {
    if (!pool) return { ok: false, inserted: false };
    const { normalizeIncomingSave } = require('./messenger/message-content');
    let { id, threadId, conversationId, pageId, senderId, text, attachments, isFromPage, createdTime } = message;
    const convId = conversationId || threadId;
    if (!isWithinMessageRetention(createdTime)) return { ok: false, inserted: false };

    const normalized = normalizeIncomingSave({ text, attachments });
    text = normalized.text;
    attachments = normalized.attachments;

    // Split first attachment into indexed columns; store overflow in metadata JSON
    const firstUrl = attachments?.[0]?.u || null;
    const firstType = attachments?.[0]?.t || null;
    const metaJson = attachments?.length ? JSON.stringify(attachments) : null;

    try {
        const [result] = await pool.query(`
            INSERT INTO messenger_messages
                (conversation_id, page_id, user_id, message_id, message, from_me, created_at, attachment_url, attachment_type, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                message = COALESCE(NULLIF(TRIM(VALUES(message)), ''), message),
                from_me = VALUES(from_me),
                attachment_url = COALESCE(VALUES(attachment_url), attachment_url),
                attachment_type = COALESCE(VALUES(attachment_type), attachment_type),
                metadata = COALESCE(VALUES(metadata), metadata)
        `, [convId, pageId, senderId, id, text, isFromPage ? 1 : 0,
            createdTime ? new Date(createdTime) : new Date(),
            firstUrl, firstType, metaJson]);
        const inserted = result.affectedRows === 1;
        return { ok: true, inserted };
    } catch (err) {
        addDbError(`saveMessage: ${err.message}`);
        return { ok: false, inserted: false };
    }
}

async function saveMessages(messenger_messages) {
    if (!pool || !messenger_messages?.length) return;
    if (messenger_messages.length === 1) {
        await saveMessage(messenger_messages[0]).catch(() => {});
        return;
    }

    const { normalizeIncomingSave } = require('./messenger/message-content');
    const rows = messenger_messages
        .filter(m => isWithinMessageRetention(m.createdTime))
        .map(m => {
            const convId = m.conversationId || m.threadId;
            const norm = normalizeIncomingSave({ text: m.text, attachments: m.attachments });
            return {
                convId,
                pageId: m.pageId,
                senderId: m.senderId || null,
                messageId: m.id,
                text: norm.text || '',
                fromMe: m.isFromPage ? 1 : 0,
                createdAt: m.createdTime ? new Date(m.createdTime) : new Date(),
                firstUrl: norm.attachments?.[0]?.u || null,
                firstType: norm.attachments?.[0]?.t || null,
                metaJson: norm.attachments?.length ? JSON.stringify(norm.attachments) : null
            };
        })
        .filter(r => r.convId && r.messageId);

    for (let i = 0; i < rows.length; i += BULK_INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + BULK_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
        const params = batch.flatMap(r => [
            r.convId, r.pageId, r.senderId, r.messageId, r.text, r.fromMe, r.createdAt,
            r.firstUrl, r.firstType, r.metaJson
        ]);
        try {
            await pool.query(`
                INSERT INTO messenger_messages
                    (conversation_id, page_id, user_id, message_id, message, from_me, created_at, attachment_url, attachment_type, metadata)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    message = COALESCE(NULLIF(TRIM(VALUES(message)), ''), message),
                    from_me = VALUES(from_me),
                    attachment_url = COALESCE(VALUES(attachment_url), attachment_url),
                    attachment_type = COALESCE(VALUES(attachment_type), attachment_type),
                    metadata = COALESCE(VALUES(metadata), metadata)
            `, params);
        } catch (err) {
            addDbError(`saveMessagesBatch: ${err.message}`);
            for (const m of messenger_messages.slice(i, i + BULK_INSERT_BATCH_SIZE)) {
                await saveMessage(m).catch(() => {});
            }
        }
    }
}

async function getMessages(threadId, limit = 100, before = null) {
    if (!pool) return [];

    try {
        const cutoff = messageRetentionCutoff();
        let query = `
            SELECT id, message_id as mid, message as text, from_me as is_from_page,
                   created_at as created_time, attachment_url, attachment_type, metadata
            FROM messenger_messages
            WHERE conversation_id = ? AND created_at >= ?
        `;
        let params = [threadId, cutoff];

        if (before) {
            const beforeDate = new Date(before);
            if (beforeDate <= cutoff) return [];
            query += ' AND created_at < ?';
            params.push(beforeDate);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const [rows] = await pool.query(query, params);

        // Reverse to return oldest → newest
        const { normalizeMessengerMessage } = require('./messenger/message-content');
        return rows.reverse().map(row => {
            const att = _readAttachment(row.attachment_url, row.attachment_type);
            let attachments = [];
            if (att.type || att.url) attachments.push({ t: att.type, u: att.url });
            if (row.metadata) {
                try {
                    const meta = JSON.parse(row.metadata);
                    if (Array.isArray(meta) && meta.length) attachments = meta;
                } catch { /* ignore */ }
            }
            return normalizeMessengerMessage({
                id: row.id,
                mid: row.mid,
                text: row.text,
                isFromPage: row.is_from_page === 1 || row.is_from_page === true,
                createdTime: row.created_time,
                attachment_url: att.url,
                attachment_type: att.type,
                attachments
            });
        });
    } catch (err) {
        addDbError(`getMessages: ${err.message}`);
        return [];
    }
}

// =============================================================================
// Sync Functions
// =============================================================================

async function syncConversationsFromFacebook(pageId, pageToken, fetchFn, since = null, opts = {}) {
    return syncConversationsAll(pageId, pageToken, fetchFn, since, {
        maxPages: opts.maxPages ?? 1,
        maxTotal: opts.maxTotal ?? 80,
        fbLimit: opts.fbLimit ?? 50
    });
}

function parseAttachments(msg) {
    const { graphMessageAttachments } = require('./messenger/message-content');
    return graphMessageAttachments(typeof msg === 'object' && msg && !Array.isArray(msg) ? msg : { attachments: msg });
}

async function syncMessagesFromFacebook(threadId, pageId, pageToken, fetchFn, limit = 20) {
    try {
        const response = await fetchFn(
            `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,sticker,${require('./messenger/message-content').FB_MESSAGE_ATTACHMENT_FIELDS}&limit=${limit}&access_token=${pageToken}`
        );
        const data = await response.json();

        if (data.error) throw new Error(data.error.message);

        const messenger_messages = (data.data || []).map(msg => ({
            id: msg.id,
            threadId: threadId,
            pageId: pageId,
            senderId: msg.from?.id,
            senderType: msg.from?.id === pageId ? 'page' : 'customer',
            text: msg.message || '',
            attachments: parseAttachments(msg),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        })).filter(m => isWithinMessageRetention(m.createdTime));

        if (pool) {
            await saveMessages(messenger_messages);
            return await getMessages(threadId, limit);
        }
        return messenger_messages;

    } catch (err) {
        addDbError(`syncMessagesFromFacebook: ${err.message}`);
        console.error('DB: syncMessages error:', err.message);
        if (pool) return await getMessages(threadId);
        return [];
    }
}

/** After Graph sync — bump list snippet/time from newest stored message. */
async function touchConversationFromLatestMessage(dbConvId) {
    if (!pool || !dbConvId) return;
    try {
        const { snippetForMessage } = require('./messenger/message-content');
        const [rows] = await pool.query(
            `SELECT message, from_me, created_at, attachment_url, attachment_type FROM messenger_messages
             WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
            [dbConvId]
        );
        if (!rows[0]) return;
        const att = _readAttachment(rows[0].attachment_url, rows[0].attachment_type);
        const snippet = snippetForMessage({
            text: rows[0].message,
            attachment_url: att.url,
            attachment_type: att.type
        }).substring(0, 200);
        const lastFromMe = rows[0].from_me === 1 || rows[0].from_me === true;
        const createdAt = rows[0].created_at;

        const [cur] = await pool.query(
            `SELECT snippet, updated_at, last_from_me FROM messenger_conversations WHERE id = ? LIMIT 1`,
            [dbConvId]
        );
        if (!cur[0]) return;
        const sameSnippet = String(cur[0].snippet || '') === String(snippet || '');
        const sameFrom = (cur[0].last_from_me === 1) === lastFromMe;
        const curTs = cur[0].updated_at ? new Date(cur[0].updated_at).getTime() : 0;
        const msgTs = createdAt ? new Date(createdAt).getTime() : 0;
        if (sameSnippet && sameFrom && Math.abs(curTs - msgTs) < 2000) return;

        await updateConversationFromMessage({
            threadId: dbConvId,
            text: snippet,
            createdTime: createdAt,
            lastFromMe
        });
    } catch (err) {
        addDbError(`touchConversationFromLatestMessage: ${err.message}`);
    }
}

async function updateConversationFromMessage(message) {
    if (!pool) return;
    const { snippetForMessage } = require('./messenger/message-content');
    const { threadId, text, createdTime, lastFromMe, attachment_type, attachment_url } = message;
    const snippet = snippetForMessage({ text, attachment_type, attachment_url }).substring(0, 200);
    const updatedAt = createdTime ? new Date(createdTime) : new Date();
    try {
        if (lastFromMe !== undefined) {
            await pool.query(`
                UPDATE messenger_conversations
                SET snippet = ?, updated_at = ?, last_from_me = ?
                WHERE id = ?
            `, [snippet, updatedAt, lastFromMe ? 1 : 0, threadId]);
        } else {
            await pool.query(`
                UPDATE messenger_conversations
                SET snippet = ?, updated_at = ?
                WHERE id = ?
            `, [snippet, updatedAt, threadId]);
        }
    } catch (err) {
        console.error('DB: updateConversationFromMessage error:', err.message);
    }
}

async function markAsRead(threadId) {
    if (!pool) return;
    try {
        await pool.query(
            'UPDATE messenger_conversations SET is_unread = 0 WHERE id = ?',
            [threadId]
        );
    } catch (err) {
        addDbError(`markAsRead: ${err.message}`);
        console.error('DB: markAsRead error:', err.message);
    }
}

async function markAsUnread(threadId) {
    if (!pool) return;
    try {
        await pool.query(
            'UPDATE messenger_conversations SET is_unread = 1 WHERE id = ?',
            [threadId]
        );
    } catch (err) {
        addDbError(`markAsUnread: ${err.message}`);
        console.error('DB: markAsUnread error:', err.message);
    }
}

// =============================================================================
// Canned Replies
// =============================================================================

async function getCannedReplies(userId) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(
            'SELECT id, title, body, created_at FROM canned_replies WHERE user_id = ? ORDER BY title ASC',
            [userId]
        );
        return rows;
    } catch (err) {
        addDbError(`getCannedReplies: ${err.message}`);
        return [];
    }
}

async function saveCannedReply(userId, title, body) {
    if (!pool) return null;
    try {
        const [result] = await pool.query(
            'INSERT INTO canned_replies (user_id, title, body) VALUES (?, ?, ?)',
            [userId, title.substring(0, 255), body]
        );
        return { id: result.insertId, title, body };
    } catch (err) {
        addDbError(`saveCannedReply: ${err.message}`);
        return null;
    }
}

async function updateCannedReply(userId, replyId, title, body) {
    if (!pool) return null;
    try {
        const [result] = await pool.query(
            'UPDATE canned_replies SET title = ?, body = ? WHERE id = ? AND user_id = ?',
            [title.substring(0, 255), body, replyId, userId]
        );
        if (!result.affectedRows) return null;
        return { id: Number(replyId), title, body };
    } catch (err) {
        addDbError(`updateCannedReply: ${err.message}`);
        return null;
    }
}

async function deleteCannedReply(userId, replyId) {
    if (!pool) return;
    try {
        await pool.query(
            'DELETE FROM canned_replies WHERE id = ? AND user_id = ?',
            [replyId, userId]
        );
    } catch (err) {
        addDbError(`deleteCannedReply: ${err.message}`);
    }
}

async function syncAllPageData(pageId, pageToken, fetchFn) {
    if (!pool) return;
    
    // Prevent parallel syncs for the same page
    if (syncStatus.get(pageId)) {
        console.log(`DB: Sync already in progress for page ${pageId}`);
        return;
    }
    
    syncStatus.set(pageId, true);
    try {
        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, null);
        for (const conv of messenger_conversations) {
            await syncMessagesAll(conv.id, pageId, pageToken, fetchFn);
        }
    } catch (err) {
        addDbError(`syncAllPageData: ${err.message}`);
    } finally {
        syncStatus.set(pageId, false);
    }
}

function buildConversationsUrl(pageId, pageToken, since = null, fbLimit = 100) {
    const sinceParam = since ? `&since=${since}` : '';
    const cap = Math.min(Math.max(fbLimit, 25), 200);
    return `https://graph.facebook.com/v19.0/${pageId}/conversations?fields=id,participants,snippet,updated_time,unread_count,can_reply&limit=${cap}${sinceParam}&access_token=${pageToken}`;
}

async function syncConversationsAll(pageId, pageToken, fetchFn, since = null, opts = {}) {
    const {
        SYNC_MAX_FB_PAGES,
        SYNC_MAX_CONVERSATIONS
    } = require('./messenger/config');
    const maxPages = opts.maxPages ?? SYNC_MAX_FB_PAGES;
    const maxTotal = opts.maxTotal ?? SYNC_MAX_CONVERSATIONS;
    const fbLimit = opts.fbLimit ?? 200;

    let allConversations = [];
    let nextUrl = buildConversationsUrl(pageId, pageToken, since, fbLimit);
    let pagesFetched = 0;

    while (nextUrl && pagesFetched < maxPages && allConversations.length < maxTotal) {
        pagesFetched++;
        const response = await fetchFn(nextUrl);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        // Log first page of raw data for diagnosis
        if (allConversations.length === 0) {
            const sample = (data.data || []).slice(0, 2).map(c => ({
                id: c.id, hasParticipants: !!c.participants,
                participants: c.participants?.data?.map(p => ({id: p.id, name: p.name}))
            }));
            addDbError(`syncConversationsAll[page1]: total=${(data.data||[]).length}, sample=${JSON.stringify(sample)}`);
        }

        const blockedPsids = [];
        const messenger_conversations = (data.data || []).flatMap(conv => {
            const participants = conv.participants?.data || [];
            const participant = participants.find(p => String(p.id) !== String(pageId))
                             || participants.find(p => p.id)
                             || null;
            if (!participant?.id) {
                addDbError(`syncConversationsAll: skipping conv ${conv.id} — participants=${JSON.stringify(participants)}`);
                return [];
            }
            if (conv.can_reply === false) {
                blockedPsids.push(String(participant.id));
                return [];
            }
            const fbCount = conv.unread_count || 0;
            const { normalizeSnippetForList, snippetIndicatesFromPage } = require('./messenger/message-content');
            const rawSnip = (conv.snippet || '').substring(0, 200);
            const snip = normalizeSnippetForList(rawSnip);
            return [{
                id: conv.id,
                pageId: pageId,
                participantId: String(participant.id),
                participantName: participant.name || 'User',
                snippet: snip,
                updatedTime: conv.updated_time,
                isRead: fbCount === 0,
                unreadCount: fbCount,
                canReply: true,
                lastFromMe: snippetIndicatesFromPage(rawSnip)
            }];
        });

        if (blockedPsids.length > 0) {
            await markCannotReply(pageId, blockedPsids);
        }

        if (messenger_conversations.length > 0) {
            await saveConversations(messenger_conversations);
            allConversations = allConversations.concat(messenger_conversations);
            if (allConversations.length >= maxTotal) break;
        }

        nextUrl = data.paging?.next || null;
    }

    return allConversations.slice(0, maxTotal);
}

async function syncMessagesAll(threadId, pageId, pageToken, fetchFn) {
    let nextUrl = `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,sticker,${require('./messenger/message-content').FB_MESSAGE_ATTACHMENT_FIELDS}&limit=100&access_token=${pageToken}`;

    while (nextUrl) {
        const response = await fetchFn(nextUrl);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const messenger_messages = (data.data || []).map(msg => ({
            id: msg.id,
            threadId: threadId,
            pageId: pageId,
            senderId: msg.from?.id,
            senderType: msg.from?.id === pageId ? 'page' : 'customer',
            text: msg.message || '',
            attachments: parseAttachments(msg),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        }));

        if (messenger_messages.length > 0) {
            await saveMessages(messenger_messages);
        }

        nextUrl = data.paging?.next || null;
    }
}

// Sync only last 3 months of data — used on first login
async function syncAllPageData3Months(pageId, pageToken, fetchFn) {
    if (!pool) return;
    if (syncStatus.get(pageId)) {
        console.log(`DB: Sync already in progress for page ${pageId}`);
        return;
    }

    syncStatus.set(pageId, true);
    const since = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    try {
        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, since);
        for (const conv of messenger_conversations) {
            await syncMessagesAll(conv.id, pageId, pageToken, fetchFn);
        }
    } catch (err) {
        addDbError(`syncAllPageData3Months: ${err.message}`);
    } finally {
        syncStatus.set(pageId, false);
    }
}

// =============================================================================
// New Parallel Sync Engine
// =============================================================================

// Worker-pool: run all tasks with max `concurrency` in flight at once
async function parallelLimit(tasks, concurrency = 10) {
    if (tasks.length === 0) return;
    let idx = 0;
    async function worker() {
        while (idx < tasks.length) {
            const i = idx++;
            try { await tasks[i](); } catch (e) {
                console.error('parallelLimit task error:', e.message);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function getLatestMessageTime(threadId) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT MAX(created_at) AS latest FROM messenger_messages WHERE conversation_id = ?',
            [threadId]
        );
        return rows[0]?.latest || null;
    } catch (err) {
        addDbError(`getLatestMessageTime: ${err.message}`);
        return null;
    }
}

async function getPageSyncTime(pageId) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT last_synced_at FROM messenger_pages WHERE fb_page_id = ?',
            [pageId]
        );
        return rows[0]?.last_synced_at || null;
    } catch (err) {
        addDbError(`getPageSyncTime: ${err.message}`);
        return null;
    }
}

async function updatePageSyncTime(pageId) {
    if (!pool) return;
    try {
        await pool.query('UPDATE messenger_pages SET last_synced_at = NOW() WHERE fb_page_id = ?', [pageId]);
    } catch (err) {
        addDbError(`updatePageSyncTime: ${err.message}`);
    }
}

async function logSync(pageId, phase, status, total = 0, done = 0, errorMessage = null) {
    if (!pool) return;
    try {
        await pool.query(`
            INSERT INTO messenger_sync_logs (page_id, phase, status, total, done, error_message)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                status = VALUES(status), 
                total = VALUES(total), 
                done = VALUES(done), 
                error_message = VALUES(error_message),
                updated_at = NOW()
        `, [pageId, phase, status, total, done, errorMessage]);
    } catch (err) {
        console.error(`DB: logSync error [${pageId}]:`, err.message);
    }
}

// Paginate Facebook messenger_messages DESC (newest first — default FB order).
// Stops when the oldest message on a page is older than `cutoffMs` (ms timestamp).
// Pass cutoffMs = null to only fetch the first page (fast incremental refresh).
async function syncThreadMessages(threadId, pageId, pageToken, fetchFn, cutoffMs = null) {
    // threadId here is the Facebook conversation ID (string like t_123456).
    // We need the DB integer conversation_id for message storage.
    // Look it up via fb_conv_id column that saveConversation populated.
    let dbConvId = threadId; // fallback: use FB ID (gets coerced to 0 by MySQL, but at least doesn't throw)
    if (pool) {
        try {
            const [rows] = await pool.query(
                'SELECT id FROM messenger_conversations WHERE fb_conv_id = ? OR (page_id = ? AND fb_conv_id = ?)',
                [threadId, pageId, threadId]
            );
            if (rows[0]) dbConvId = rows[0].id;
        } catch (e) { /* use fallback */ }
    }

    let nextUrl = `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,sticker,${require('./messenger/message-content').FB_MESSAGE_ATTACHMENT_FIELDS}&limit=100&access_token=${pageToken}`;
    let saved = 0;

    while (nextUrl) {
        let data;
        try {
            const response = await fetchFn(nextUrl);
            data = await response.json();
        } catch (e) {
            console.error(`syncThreadMessages fetch error [${threadId}]:`, e.message);
            break;
        }
        if (data.error) {
            console.error(`syncThreadMessages FB error [${threadId}]:`, data.error.message);
            break;
        }
        const messenger_messages = (data.data || []).map(msg => ({
            id: msg.id, threadId: dbConvId, pageId,
            senderId: msg.from?.id || '',
            senderType: msg.from?.id === pageId ? 'page' : 'customer',
            text: msg.message || '',
            attachments: parseAttachments(msg),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        })).filter(m => isWithinMessageRetention(m.createdTime));
        if (messenger_messages.length > 0) {
            await saveMessages(messenger_messages);
            saved += messenger_messages.length;
        }
        // No cutoff = incremental: first page (newest 100 msgs) is enough
        if (!cutoffMs) {
            if (saved > 0 && dbConvId) {
                await touchConversationFromLatestMessage(dbConvId).catch(() => {});
            }
            break;
        }
        // FB returns DESC: last element in array is the oldest on this page
        if (messenger_messages.length > 0) {
            const oldestMs = new Date(messenger_messages[messenger_messages.length - 1].createdTime).getTime();
            if (oldestMs <= cutoffMs) break; // covered everything we need
        }
        nextUrl = data.paging?.next || null; // next page = older messenger_messages
    }
    return saved;
}

// First-time sync: all messenger_conversations + last 7 days of messenger_messages, parallel
async function syncPageSmart(pageId, pageToken, fetchFn, onProgress = null) {
    if (!pool) return;
    if (syncStatus.get(pageId)) return;
    
    try {
        const lastSynced = await getPageSyncTime(pageId);
        if (lastSynced) {
            await syncPageIncremental(pageId, pageToken, fetchFn, onProgress);
        } else {
            await syncPageInitial(pageId, pageToken, fetchFn, onProgress);
        }
    } catch (err) {
        console.error(`DB: syncPageSmart error [${pageId}]:`, err);
    }
}

/**
 * Silently syncs conversation threads beyond the initial SYNC_MESSAGE_THREADS_MAX cap.
 * Runs entirely in the background — does NOT block the main sync response or UI.
 *
 * Chunks of SYNC_BG_CHUNK_SIZE with SYNC_BG_CHUNK_DELAY ms gaps to stay well
 * under Facebook's rate limits (~200 calls/hour per token).
 */
async function syncRemainingInBackground(conversations, pageId, pageToken, fetchFn) {
    if (!conversations.length) return;
    for (let i = 0; i < conversations.length; i += SYNC_BG_CHUNK_SIZE) {
        // Stop if another explicit sync has taken over for this page
        if (syncStatus.get(pageId)) return;

        const chunk = conversations.slice(i, i + SYNC_BG_CHUNK_SIZE);
        const tasks = chunk.map(conv => async () => {
            // null cutoff = only newest page (incremental, not full history)
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, null)
                .catch(err => addDbError(`bg_sync_thread [${conv.id}]: ${err.message}`));
        });
        await parallelLimit(tasks, SYNC_PARALLEL_LIMIT);

        const remaining = conversations.length - (i + SYNC_BG_CHUNK_SIZE);
        if (remaining > 0) {
            console.log(`DB: bg sync — ${remaining} thread(s) left for page ${pageId}, waiting ${SYNC_BG_CHUNK_DELAY}ms`);
            await new Promise(r => setTimeout(r, SYNC_BG_CHUNK_DELAY));
        }
    }
    console.log(`DB: bg sync complete — all threads processed for page ${pageId}`);
}

// First-time sync: ALL can_reply conversations active in last 7 days + 7 days of messages
async function syncPageInitial(pageId, pageToken, fetchFn, onProgress = null) {
    if (syncStatus.get(pageId)) return;
    syncStatus.set(pageId, true);
    const cutoff7DaysMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
        await logSync(pageId, 'initial_sync', 'running');
        const { SYNC_MESSAGE_THREADS_MAX } = require('./messenger/config');
        // Fetch ALL conversations without a since filter — Facebook returns them sorted by
        // updated_time DESC so we always get the most recently active ones first.
        // No date cap here: conversations go into DB regardless of age; only MESSAGE sync
        // is constrained to the 7-day retention window below.
        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, null, {
            maxPages: Infinity,
            maxTotal: 10000,
            fbLimit: 200
        });
        if (onProgress) onProgress({ pageId, phase: 'messenger_conversations', total: messenger_conversations.length, done: 0 });

        const sorted = [...messenger_conversations]
            .sort((a, b) => new Date(b.updatedTime || 0) - new Date(a.updatedTime || 0));
        const forMessageSync = sorted.slice(0, SYNC_MESSAGE_THREADS_MAX);
        const remaining      = sorted.slice(SYNC_MESSAGE_THREADS_MAX); // everything beyond cap

        let done = 0;
        const tasks = forMessageSync.map(conv => async () => {
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoff7DaysMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messenger_messages', total: forMessageSync.length, done });
            await logSync(pageId, 'initial_sync', 'running', forMessageSync.length, done);
        });

        await parallelLimit(tasks, SYNC_PARALLEL_LIMIT);

        scheduleDeferredCleanup(pageId, MESSAGE_RETENTION_DAYS);
        await updatePageSyncTime(pageId);
        await logSync(pageId, 'initial_sync', 'done', messenger_conversations.length, done);

        // Schedule remaining threads silently in background — non-blocking
        if (remaining.length > 0) {
            console.log(`DB: ${remaining.length} thread(s) queued for background sync [page ${pageId}]`);
            setImmediate(() => syncRemainingInBackground(remaining, pageId, pageToken, fetchFn));
        }
    } catch (err) {
        await logSync(pageId, 'initial_sync', 'error', 0, 0, err.message);
        throw err;
    } finally {
        syncStatus.set(pageId, false);
    }
}

async function syncPageIncremental(pageId, pageToken, fetchFn, onProgress = null) {
    if (syncStatus.get(pageId)) return;
    syncStatus.set(pageId, true);
    const cutoff7DaysMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
        await logSync(pageId, 'incremental_sync', 'running');
        const lastSynced = await getPageSyncTime(pageId);
        const sinceUnix = lastSynced
            ? Math.floor(new Date(lastSynced).getTime() / 1000)
            : Math.floor(cutoff7DaysMs / 1000);

        const { SYNC_MESSAGE_THREADS_MAX } = require('./messenger/config');
        // Paginate all pages since last sync — catches every new/updated conversation
        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, sinceUnix, {
            maxPages: Infinity,
            maxTotal: 10000,
            fbLimit: 200
        });
        if (onProgress) onProgress({ pageId, phase: 'messenger_conversations', total: messenger_conversations.length, done: 0 });

        const sortedIncr = [...messenger_conversations]
            .sort((a, b) => new Date(b.updatedTime || 0) - new Date(a.updatedTime || 0));
        const forMessageSync  = sortedIncr.slice(0, SYNC_MESSAGE_THREADS_MAX);
        const remainingIncr   = sortedIncr.slice(SYNC_MESSAGE_THREADS_MAX);

        let done = 0;
        const tasks = forMessageSync.map(conv => async () => {
            const latestTime = await getLatestMessageTime(conv.id);
            const cutoffMs = latestTime ? new Date(latestTime).getTime() : null;
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoffMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messenger_messages', total: forMessageSync.length, done });
            await logSync(pageId, 'incremental_sync', 'running', forMessageSync.length, done);
        });

        await parallelLimit(tasks, SYNC_PARALLEL_LIMIT);

        scheduleDeferredCleanup(pageId, MESSAGE_RETENTION_DAYS);
        await updatePageSyncTime(pageId);
        await logSync(pageId, 'incremental_sync', 'done', messenger_conversations.length, done);

        // Silently continue syncing remaining threads in background
        if (remainingIncr.length > 0) {
            console.log(`DB: ${remainingIncr.length} thread(s) queued for background sync [page ${pageId}]`);
            setImmediate(() => syncRemainingInBackground(remainingIncr, pageId, pageToken, fetchFn));
        }
    } catch (err) {
        await logSync(pageId, 'incremental_sync', 'error', 0, 0, err.message);
        throw err;
    } finally {
        syncStatus.set(pageId, false);
    }
}

// =============================================================================
// Bulk & Utility Operations
// =============================================================================

async function markAllAsRead(pageId) {
    if (!pool) return 0;
    try {
        const [result] = await pool.query(
            'UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND is_unread > 0',
            [pageId]
        );
        return result.affectedRows || 0;
    } catch (err) {
        addDbError(`markAllAsRead: ${err.message}`);
        return 0;
    }
}

async function archiveConversation(convId, pageId) {
    if (!pool) return;
    try {
        await pool.query('UPDATE messenger_conversations SET archived = 1 WHERE id = ? AND page_id = ?', [convId, pageId]);
    } catch (err) { addDbError(`archiveConversation: ${err.message}`); }
}

async function unarchiveConversation(convId, pageId) {
    if (!pool) return;
    try {
        await pool.query('UPDATE messenger_conversations SET archived = 0 WHERE id = ? AND page_id = ?', [convId, pageId]);
    } catch (err) { addDbError(`unarchiveConversation: ${err.message}`); }
}

// =============================================================================
// Conversation Notes
// =============================================================================

async function getNotes(conversationId) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(
            'SELECT id, author, body, created_at FROM conversation_notes WHERE conversation_id = ? ORDER BY created_at ASC',
            [conversationId]
        );
        return rows;
    } catch (err) {
        addDbError(`getNotes: ${err.message}`);
        return [];
    }
}

async function saveNote(conversationId, pageId, author, body) {
    if (!pool) return null;
    try {
        const [result] = await pool.query(
            'INSERT INTO conversation_notes (conversation_id, page_id, author, body) VALUES (?, ?, ?, ?)',
            [conversationId, pageId, author.substring(0, 255), body.substring(0, 5000)]
        );
        return { id: result.insertId, author, body, created_at: new Date() };
    } catch (err) {
        addDbError(`saveNote: ${err.message}`);
        return null;
    }
}

async function deleteNote(noteId, pageId) {
    if (!pool) return;
    try {
        await pool.query('DELETE FROM conversation_notes WHERE id = ? AND page_id = ?', [noteId, pageId]);
    } catch (err) { addDbError(`deleteNote: ${err.message}`); }
}

// =============================================================================
// Stats & Cleanup
// =============================================================================

async function getStats() {
    if (!pool) return { totalConversations: 0, totalMessages: 0, users: 0 };
    try {
        const [msgCount] = await pool.query('SELECT COUNT(*) as total FROM messenger_messages');
        const [convCount] = await pool.query('SELECT COUNT(*) as total FROM messenger_conversations');
        const [userCount] = await pool.query('SELECT COUNT(*) as total FROM users').catch(() => [{ total: 0 }]);
        return {
            totalMessages: msgCount[0]?.total || 0,
            totalConversations: convCount[0]?.total || 0,
            users: userCount[0]?.total || 0
        };
    } catch (err) {
        addDbError(`getStats: ${err.message}`);
        return { totalConversations: 0, totalMessages: 0, users: 0 };
    }
}

/**
 * Single batched poll — one connection, parallel queries, minimal latency.
 * Uses a single pool checkout for the two independent inbox queries so we
 * don't pay three connection-acquire round-trips on every 3-second poll.
 */
/** Recently active threads for live Graph refresh while inbox is open. */
async function getHotConversationsForSync(pageId, limit = 10) {
    if (!pool || !pageId) return [];
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
    try {
        const [rows] = await pool.query(
            `SELECT id, fb_conv_id, fb_user_id, updated_at
             FROM messenger_conversations
             WHERE page_id = ? AND fb_conv_id IS NOT NULL AND fb_conv_id != ''
               AND COALESCE(can_reply, 1) = 1
             ORDER BY updated_at DESC
             LIMIT ${cap}`,
            [pageId]
        );
        return rows;
    } catch (err) {
        addDbError(`getHotConversationsForSync: ${err.message}`);
        return [];
    }
}

async function pollInboxUpdates(pageId, psid, since, maxConvs = 40) {
    if (!pool) return { newMessages: [], updatedConvs: [], totalUnread: 0 };

    const sinceDate = since instanceof Date ? since : new Date(since);
    if (isNaN(sinceDate.getTime())) return { newMessages: [], updatedConvs: [], totalUnread: 0 };

    const cap = Math.min(Math.max(parseInt(maxConvs, 10) || 40, 1), 100);
    let conn;
    try {
        conn = await pool.getConnection();

        // Fire both inbox queries in parallel on the same connection
        const convParams = [pageId, sinceDate];
        let convExclude = '';
        if (psid) {
            convExclude = ' AND fb_user_id <> ?';
            convParams.push(String(psid));
        }
        const [updatedConvsResult, unreadResult] = await Promise.all([
            conn.query(
                `SELECT id, page_id, fb_user_id, user_name, user_picture, snippet,
                        updated_at, is_unread, last_from_me
                 FROM messenger_conversations
                 WHERE page_id = ? AND updated_at > ?
                   AND COALESCE(can_reply, 1) = 1${convExclude}
                 ORDER BY updated_at DESC LIMIT ${cap}`,
                convParams
            ),
            conn.query(
                `SELECT COUNT(*) AS total FROM messenger_conversations
                 WHERE page_id = ? AND is_unread > 0 AND COALESCE(can_reply, 1) = 1`,
                [pageId]
            )
        ]);

        conn.release();
        conn = null;

        const updatedConvs = (updatedConvsResult[0] || []).map(r => ({
            id: r.id, page_id: r.page_id, fb_user_id: r.fb_user_id,
            user_name: r.user_name, user_picture: r.user_picture,
            snippet: r.snippet, updated_at: r.updated_at,
            is_unread: r.is_unread || 0, last_from_me: r.last_from_me
        }));
        const totalUnread = Number(unreadResult[0]?.[0]?.total || 0);

        let newMessages = [];
        if (psid) {
            // Uses the in-process conv cache — usually no DB hit here
            const convInfo = await getConversationIdByParticipant(pageId, psid);
            if (convInfo?.id) newMessages = await getNewMessagesSince(convInfo.id, sinceDate);
        }

        return { newMessages, updatedConvs, totalUnread };
    } catch (err) {
        addDbError(`pollInboxUpdates: ${err.message}`);
        return { newMessages: [], updatedConvs: [], totalUnread: 0 };
    } finally {
        conn?.release();
    }
}

async function getNewMessagesSince(convId, since) {
    if (!pool) return [];
    try {
        // Convert ISO string (e.g. '2026-05-16T05:10:30.123Z') to JS Date so
        // mysql2 serialises it as 'YYYY-MM-DD HH:MM:SS.mmm' — MySQL's DATETIME
        // implicit cast cannot parse the trailing 'Z', returning NULL and
        // matching zero rows.
        const sinceDate = since instanceof Date ? since : new Date(since);
        if (isNaN(sinceDate)) throw new Error('invalid since: ' + since);

        const [rows] = await pool.query(
            `SELECT id, message_id AS mid, message AS text,
                    from_me AS isFromPage, created_at AS createdTime,
                    attachment_url, attachment_type, metadata
             FROM messenger_messages
             WHERE conversation_id = ? AND created_at > ?
             ORDER BY created_at ASC`,
            [convId, sinceDate]
        );
        const { normalizeMessengerMessage } = require('./messenger/message-content');
        return rows.map(r => {
            const att = _readAttachment(r.attachment_url, r.attachment_type);
            let attachments = [];
            if (att.type || att.url) attachments.push({ t: att.type, u: att.url });
            if (r.metadata) {
                try {
                    const meta = JSON.parse(r.metadata);
                    if (Array.isArray(meta) && meta.length) attachments = meta;
                } catch { /* ignore */ }
            }
            return normalizeMessengerMessage({
                mid: r.mid,
                message_id: r.mid,
                text: r.text,
                isFromPage: r.isFromPage === 1 || r.isFromPage === true,
                createdTime: r.createdTime,
                attachment_url: att.url,
                attachment_type: att.type,
                attachments
            });
        });
    } catch (err) {
        addDbError(`getNewMessagesSince: ${err.message}`);
        return [];
    }
}

async function getUpdatedConvsSince(pageId, since, limit = 50) {
    if (!pool) return [];
    try {
        const sinceDate = since instanceof Date ? since : new Date(since);
        const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
        const [rows] = await pool.query(
            `SELECT id, page_id, fb_user_id, user_name, user_picture, snippet, updated_at, is_unread, last_from_me
             FROM messenger_conversations
             WHERE page_id = ? AND updated_at > ?
               AND COALESCE(can_reply, 1) = 1
             ORDER BY updated_at DESC
             LIMIT ${cap}`,
            [pageId, sinceDate]
        );
        return rows.map(r => ({
            id: r.id,
            page_id: r.page_id,
            fb_user_id: r.fb_user_id,
            user_name: r.user_name,
            user_picture: r.user_picture,
            snippet: r.snippet,
            updated_at: r.updated_at,
            is_unread: r.is_unread || 0,
            last_from_me: r.last_from_me
        }));
    } catch (err) {
        addDbError(`getUpdatedConvsSince: ${err.message}`);
        return [];
    }
}

async function getTotalUnread(pageId) {
    if (!pool) return 0;
    try {
        // COUNT conversations that need attention (not SUM of message counts)
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS total FROM messenger_conversations
             WHERE page_id = ? AND is_unread > 0 AND COALESCE(can_reply, 1) = 1`,
            [pageId]
        );
        return Number(rows[0]?.total || 0);
    } catch (err) {
        addDbError(`getTotalUnread: ${err.message}`);
        return 0;
    }
}

async function searchMessages(pageId, query, limit = 40) {
    if (!pool) return [];
    const term = String(query || '').trim();
    if (term.length < 1) return [];
    const likeLower = `%${term.toLowerCase()}%`;
    try {
        const [rows] = await pool.query(
            `SELECT m.message_id, m.message, m.from_me, m.created_at, m.user_id,
                    c.fb_user_id AS senderId, c.user_name, c.user_picture, c.id AS conversation_id
             FROM messenger_messages m
             INNER JOIN messenger_conversations c ON m.conversation_id = c.id
             WHERE m.page_id = ? AND LOWER(COALESCE(m.message, '')) LIKE ?
             ORDER BY m.created_at DESC
             LIMIT ?`,
            [pageId, likeLower, limit]
        );
        return rows;
    } catch (err) {
        addDbError(`searchMessages: ${err.message}`);
        return [];
    }
}

async function upsertUserFacebookName(fbUserId, name, accessToken = null) {
    if (!pool || !fbUserId) return;
    const trimmed = String(name || '').trim().slice(0, 255);
    const token = accessToken ? String(accessToken).trim() : null;
    if (!trimmed && !token) return;
    try {
        if (trimmed && token) {
            await pool.query(`
                INSERT INTO users (fb_user_id, fb_name, fb_access_token, plan, messenger_messages_limit)
                VALUES (?, ?, ?, 'free', 2000)
                ON DUPLICATE KEY UPDATE
                    fb_name = VALUES(fb_name),
                    fb_access_token = COALESCE(VALUES(fb_access_token), fb_access_token)
            `, [fbUserId, trimmed, token]);
        } else if (trimmed) {
            await pool.query(`
                INSERT INTO users (fb_user_id, fb_name, plan, messenger_messages_limit)
                VALUES (?, ?, 'free', 2000)
                ON DUPLICATE KEY UPDATE fb_name = VALUES(fb_name)
            `, [fbUserId, trimmed]);
        } else if (token) {
            await pool.query(`
                UPDATE users SET fb_access_token = ? WHERE fb_user_id = ?
            `, [token, fbUserId]);
        }
    } catch (err) {
        addDbError(`upsertUserFacebookName: ${err.message}`);
    }
}

/** First login: 7-day free trial with 2000 messages */
async function ensureUserExists(fbUserId) {
    if (!pool || !fbUserId) return false;
    const [result] = await pool.query(
        `INSERT INTO users (fb_user_id, plan, messenger_messages_limit, messenger_messages_used, free_trial_expires_at)
         VALUES (?, 'free', ?, 0, DATE_ADD(NOW(), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE fb_user_id = fb_user_id`,
        [fbUserId, FREE_TIER.limit, FREE_TRIAL_DAYS]
    );
    return result.affectedRows === 1;
}

async function getUserQuotaRow(fbUserId) {
    if (!pool || !fbUserId) return null;
    await ensureUserExists(fbUserId);
    const [rows] = await pool.query(
        `SELECT messenger_messages_used, messenger_messages_limit, plan, subscription_expires,
                free_trial_expires_at, stripe_subscription_id, created_at
         FROM users WHERE fb_user_id = ?`,
        [fbUserId]
    );
    return rows[0] || null;
}

function resolveEffectiveQuota(row) {
    if (!row) {
        return {
            effectiveLimit: 0, used: 0, remaining: 0, trialDaysLeft: 0, trialExpired: true,
            onTrial: false, plan: 'free', freeTrialExpiresAt: null
        };
    }
    const plan = String(row.plan || 'free').toLowerCase();
    const used = Number(row.messenger_messages_used) || 0;
    const isPaid = plan !== 'free' && plan !== 'unknown';
    const paidExpired = isPaid && row.subscription_expires && new Date(row.subscription_expires) < new Date();

    if (isPaid && !paidExpired) {
        const limit = Number(row.messenger_messages_limit) || 0;
        const clampedUsed = Math.min(used, limit);
        return {
            effectiveLimit: limit,
            used: clampedUsed,
            remaining: Math.max(0, limit - clampedUsed),
            trialDaysLeft: null,
            trialExpired: false,
            onTrial: false,
            plan,
            freeTrialExpiresAt: null
        };
    }

    const trialEnd = row.free_trial_expires_at ? new Date(row.free_trial_expires_at) : null;
    const now = new Date();
    const trialExpired = !trialEnd || now >= trialEnd;
    let trialDaysLeft = 0;
    if (trialEnd && !trialExpired) {
        trialDaysLeft = Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / 86400000));
    }
    const effectiveLimit = trialExpired ? 0 : (Number(row.messenger_messages_limit) || FREE_TIER.limit);
    const clampedUsed = Math.min(used, effectiveLimit || used);
    return {
        effectiveLimit,
        used: clampedUsed,
        remaining: Math.max(0, effectiveLimit - clampedUsed),
        trialDaysLeft,
        trialExpired,
        onTrial: !trialExpired && !!trialEnd,
        plan: 'free',
        freeTrialExpiresAt: trialEnd ? trialEnd.toISOString() : null
    };
}

async function syncExpiredFreeTrial(fbUserId, row, effective) {
    if (!pool || !fbUserId || !row || !effective.trialExpired) return;
    if (String(row.plan || '').toLowerCase() !== 'free') return;
    if (Number(row.messenger_messages_limit) === 0) return;
    await pool.query(
        'UPDATE users SET messenger_messages_limit = 0 WHERE fb_user_id = ? AND plan = ?',
        [fbUserId, 'free']
    );
}

function formatQuotaApiResponse(row, effective, extra = {}) {
    return {
        success: true,
        messenger_messagesUsed: effective.used,
        messageLimit: effective.effectiveLimit,
        subscriptionStatus: row?.plan || 'free',
        plan: row?.plan || 'free',
        remaining: effective.remaining,
        trialDaysLeft: effective.trialDaysLeft,
        trialExpired: effective.trialExpired,
        onFreeTrial: effective.onTrial,
        freeTrialExpiresAt: effective.freeTrialExpiresAt,
        ...extra
    };
}

async function updateUserQuota(fbUserId, count) {
    if (!pool) return null;
    try {
        await ensureUserExists(fbUserId);

        const rowBefore = await getUserQuotaRow(fbUserId);
        let effective = resolveEffectiveQuota(rowBefore);

        if (count > 0 && effective.remaining >= count) {
            await pool.query(
                `UPDATE users
                 SET messenger_messages_used = messenger_messages_used + ?
                 WHERE fb_user_id = ?`,
                [count, fbUserId]
            );
        }

        const row = await getUserQuotaRow(fbUserId);
        effective = resolveEffectiveQuota(row);
        await syncExpiredFreeTrial(fbUserId, row, effective);

        if (count > 0) {
            await pool.query(
                'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, "send", ?)',
                [fbUserId, `Sent: ${count} | Remaining: ${effective.remaining}`]
            ).catch(() => {});
        }

        return formatQuotaApiResponse(row, effective);
    } catch (err) {
        addDbError(`updateUserQuota: ${err.message}`);
        return null;
    }
}

function scheduleDeferredCleanup(pageId = null, daysOld = MESSAGE_RETENTION_DAYS) {
    const key = pageId || '__global__';
    if (cleanupTimers.has(key)) return;
    const timer = setTimeout(async () => {
        cleanupTimers.delete(key);
        // Messages only — conversations stay in DB (user requirement).
        await cleanupOldMessages(daysOld, pageId).catch(() => {});
    }, CLEANUP_DEFER_MS);
    cleanupTimers.set(key, timer);
}

async function cleanupOldMessages(daysOld = MESSAGE_RETENTION_DAYS, pageId = null) {
    if (!pool) return 0;

    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    let totalDeleted = 0;

    try {
        while (true) {
            const params = [cutoff];
            let sql = 'DELETE FROM messenger_messages WHERE created_at < ?';
            if (pageId) {
                sql += ' AND page_id = ?';
                params.push(pageId);
            }
            sql += ` LIMIT ${CLEANUP_DELETE_BATCH}`;

            const [result] = await pool.query(sql, params);
            const deleted = result.affectedRows || 0;
            totalDeleted += deleted;
            if (deleted < CLEANUP_DELETE_BATCH) break;
            await new Promise(r => setTimeout(r, 50));
        }

        if (totalDeleted > 0) {
            console.log(`DB: Purged ${totalDeleted} message(s) older than ${daysOld} day(s)${pageId ? ` for page ${pageId}` : ''}`);
        }
        return totalDeleted;
    } catch (err) {
        addDbError(`cleanupOldMessages: ${err.message}`);
        return totalDeleted;
    }
}

/**
 * Optional manual/admin purge of very old empty conversation rows.
 * NOT called by scheduleDeferredCleanup — conversations are kept by default.
 */
async function cleanupStaleConversations(pageId = null, daysOld = CONVERSATION_RETENTION_DAYS) {
    if (!pool) return 0;
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    let totalDeleted = 0;

    try {
        while (true) {
            // Collect a batch of stale conv IDs before deleting
            const baseWhere = pageId
                ? 'c.page_id = ? AND c.updated_at < ?'
                : 'c.updated_at < ?';
            const baseParams = pageId ? [pageId, cutoff] : [cutoff];

            const [stale] = await pool.query(
                `SELECT c.id FROM messenger_conversations c
                 WHERE ${baseWhere}
                   AND NOT EXISTS (
                       SELECT 1 FROM messenger_messages m WHERE m.conversation_id = c.id
                   )
                 LIMIT ${CLEANUP_DELETE_BATCH}`,
                baseParams
            );

            if (stale.length === 0) break;

            const ids = stale.map(r => r.id);
            const ph = ids.map(() => '?').join(',');

            // Orphaned notes have no FK cascade — delete them first
            await pool.query(
                `DELETE FROM conversation_notes WHERE conversation_id IN (${ph})`,
                ids
            ).catch(() => {});

            // Evict cache entries for deleted conversations
            for (const { id } of stale) _convIdCache.forEach((v, k) => {
                if (v.id === id) _convIdCache.delete(k);
            });

            const [result] = await pool.query(
                `DELETE FROM messenger_conversations WHERE id IN (${ph})`,
                ids
            );
            totalDeleted += result.affectedRows || 0;

            if (stale.length < CLEANUP_DELETE_BATCH) break;
            await new Promise(r => setTimeout(r, 100)); // breathe between batches
        }

        if (totalDeleted > 0) {
            console.log(`DB: Purged ${totalDeleted} stale conversation(s) older than ${daysOld} days${pageId ? ` for page ${pageId}` : ''}`);
        }
        return totalDeleted;
    } catch (err) {
        addDbError(`cleanupStaleConversations: ${err.message}`);
        return totalDeleted;
    }
}

const { getPlan, FREE_TIER, FREE_TRIAL_DAYS, resolvePlanKey } = require('./config/plans');

async function ensureBillingTables() {
    return initDatabase();
}

async function reserveWebhookEvent(eventId, eventType, payload) {
    if (!pool) return 'failed';
    try {
        const [existing] = await pool.query('SELECT status FROM webhook_events WHERE event_id = ?', [eventId]);
        if (existing.length) {
            if (existing[0].status === 'processed') return 'processed';
            await pool.query(
                `UPDATE webhook_events SET attempts = attempts + 1, last_seen_at = NOW() WHERE event_id = ?`,
                [eventId]
            );
            return 'processing';
        }
        await pool.query(
            `INSERT INTO webhook_events (event_id, event_type, status, payload) VALUES (?, ?, 'processing', ?)`,
            [eventId, eventType, payload]
        );
        return 'processing';
    } catch (_) {
        return 'processing';
    }
}

async function markWebhookProcessed(eventId) {
    if (!pool) return;
    await pool.query(
        `UPDATE webhook_events SET status = 'processed', processed_at = NOW(), last_error = NULL WHERE event_id = ?`,
        [eventId]
    ).catch(() => {});
}

async function markWebhookFailed(eventId, error) {
    if (!pool) return;
    await pool.query(
        `UPDATE webhook_events SET status = 'failed', last_error = ? WHERE event_id = ?`,
        [String(error).slice(0, 5000), eventId]
    ).catch(() => {});
}

async function recordPayment(fbUserId, { invoiceId, plan, amountCents, status, billingReason }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO payment_history (fb_user_id, stripe_invoice_id, plan, amount_cents, status, billing_reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [fbUserId, invoiceId || '', plan || 'unknown', amountCents || 0, status || 'pending', billingReason || '']
    ).catch(() => {});
}

async function applyPlan(fbUserId, planKey, { subscriptionId = '', email = '', amountCents = 0, invoiceId = '', billingReason = '' } = {}) {
    if (!pool) return;
    const plan = getPlan(planKey);
    if (!plan) return;
    const expiresExpr = plan.interval === 'year'
        ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
        : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
    await ensureUserExists(fbUserId);
    if (email) {
        await pool.query(
            `UPDATE users SET plan = ?, messenger_messages_limit = ?, messenger_messages_used = 0,
             stripe_subscription_id = ?, subscription_expires = ${expiresExpr}, email = ?,
             free_trial_expires_at = NULL, plan_activated_at = NOW()
             WHERE fb_user_id = ?`,
            [plan.dbPlan, plan.limit, subscriptionId || null, email, fbUserId]
        );
    } else {
        await pool.query(
            `UPDATE users SET plan = ?, messenger_messages_limit = ?, messenger_messages_used = 0,
             stripe_subscription_id = ?, subscription_expires = ${expiresExpr},
             free_trial_expires_at = NULL, plan_activated_at = NOW()
             WHERE fb_user_id = ?`,
            [plan.dbPlan, plan.limit, subscriptionId || null, fbUserId]
        );
    }
    await pool.query(
        'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)',
        [fbUserId, 'subscription', `Activated: ${planKey} | ${plan.limit} messages`]
    ).catch(() => {});
    if (amountCents || invoiceId) {
        await recordPayment(fbUserId, { invoiceId, plan: plan.dbPlan, amountCents, status: 'succeeded', billingReason });
    }
}

async function renewPlan(fbUserId, planKey, { invoiceId, amountCents, billingReason }) {
    if (!pool) return;
    const plan = getPlan(planKey);
    if (!plan) return;
    const expiresExpr = plan.interval === 'year'
        ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
        : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
    await pool.query(
        `UPDATE users SET messenger_messages_used = 0, messenger_messages_limit = ?,
         subscription_expires = ${expiresExpr}, plan = ?
         WHERE fb_user_id = ?`,
        [plan.limit, plan.dbPlan, fbUserId]
    );
    await recordPayment(fbUserId, { invoiceId, plan: plan.dbPlan, amountCents, status: 'succeeded', billingReason });
}

async function downgradeToFree(fbUserId) {
    if (!pool) return;
    // Paid ended — no new free trial; quota stays at 0 until upgrade
    await pool.query(
        `UPDATE users SET plan = 'free', messenger_messages_limit = 0, messenger_messages_used = 0,
         stripe_subscription_id = NULL, subscription_expires = NULL
         WHERE fb_user_id = ?`,
        [fbUserId]
    );
    await pool.query(
        'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)',
        [fbUserId, 'subscription', 'Cancelled — reverted to free']
    ).catch(() => {});
}

/** Admin: fully activate a plan (limits, expiry, quota reset) like Stripe checkout */
async function adminActivatePlan(fbUserId, planInput, { messages_used, messages_limit } = {}) {
    if (!pool || !fbUserId) return { ok: false, error: 'Invalid user' };
    const catalogKey = resolvePlanKey(planInput);
    if (!catalogKey) return { ok: false, error: 'Unknown plan' };

    if (catalogKey === 'free') {
        await downgradeToFree(fbUserId);
    } else {
        await applyPlan(fbUserId, catalogKey, { billingReason: 'admin_activation' });
    }

    const sets = [];
    const vals = [];
    if (messages_limit !== undefined && messages_limit !== null && messages_limit !== '') {
        sets.push('messenger_messages_limit=?');
        vals.push(Math.max(0, parseInt(messages_limit, 10) || 0));
    }
    if (messages_used !== undefined && messages_used !== null && messages_used !== '') {
        sets.push('messenger_messages_used=?');
        vals.push(Math.max(0, parseInt(messages_used, 10) || 0));
    }
    if (sets.length) {
        vals.push(fbUserId);
        await pool.query(`UPDATE users SET ${sets.join(',')} WHERE fb_user_id=?`, vals);
    }

    const [rows] = await pool.query(
        `SELECT plan, messenger_messages_limit, messenger_messages_used, subscription_expires
         FROM users WHERE fb_user_id = ?`,
        [fbUserId]
    );
    const r = rows[0] || {};
    const catalog = catalogKey === 'free' ? null : getPlan(catalogKey);
    await pool.query(
        'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)',
        [fbUserId, 'subscription', `Admin activated: ${catalog?.name || 'Free'} (${r.messenger_messages_limit} msgs)`]
    ).catch(() => {});

    return {
        ok: true,
        planKey: catalogKey,
        plan: r.plan || (catalogKey === 'free' ? 'free' : catalog?.dbPlan),
        planName: catalog?.name || 'Free',
        messageLimit: r.messenger_messages_limit,
        messagesUsed: r.messenger_messages_used,
        subscriptionExpires: r.subscription_expires
    };
}

/** Single source for entitlement state (trial sync, paid expiry downgrade). */
async function computeEntitlements(fbUserId) {
    if (!pool || !fbUserId) return null;
    await ensureUserExists(fbUserId);
    let row = await getUserQuotaRow(fbUserId);
    if (!row) return null;

    const dbPlan = String(row.plan || 'free').toLowerCase();
    if (row.subscription_expires && new Date(row.subscription_expires) < new Date() && dbPlan !== 'free') {
        await downgradeToFree(fbUserId);
        row = await getUserQuotaRow(fbUserId);
        if (!row) return null;
    }

    let effective = resolveEffectiveQuota(row);
    await syncExpiredFreeTrial(fbUserId, row, effective);
    if (effective.trialExpired) {
        row = await getUserQuotaRow(fbUserId);
        effective = resolveEffectiveQuota(row);
    }
    return { row, effective };
}

async function assertQuota(fbUserId, count = 1) {
    if (!pool) return { ok: false, code: 'DB_UNAVAILABLE', message: 'Database unavailable' };
    const computed = await computeEntitlements(fbUserId);
    if (!computed) return { ok: false, code: 'USER_NOT_FOUND', message: 'User not found' };
    const { row, effective } = computed;

    if (effective.remaining < count) {
        const msg = effective.trialExpired && effective.plan === 'free'
            ? 'Your 7-day free trial has ended. Please upgrade to continue sending.'
            : 'Message quota exceeded. Upgrade your plan to continue.';
        return {
            ok: false,
            code: effective.trialExpired ? 'TRIAL_EXPIRED' : 'QUOTA_EXCEEDED',
            message: msg,
            remaining: effective.remaining,
            limit: effective.effectiveLimit,
            used: effective.used,
            plan: effective.plan,
            trialDaysLeft: effective.trialDaysLeft,
            trialExpired: effective.trialExpired
        };
    }
    return {
        ok: true,
        remaining: effective.remaining,
        limit: effective.effectiveLimit,
        used: effective.used,
        plan: effective.plan,
        trialDaysLeft: effective.trialDaysLeft,
        trialExpired: effective.trialExpired
    };
}

async function checkExpiredSubscriptions() {
    if (!pool) return 0;
    const [result] = await pool.query(
        `UPDATE users SET plan = 'free', messenger_messages_limit = 0, messenger_messages_used = 0,
         stripe_subscription_id = NULL, subscription_expires = NULL
         WHERE subscription_expires IS NOT NULL AND subscription_expires < NOW() AND plan != 'free'`
    );
    return result.affectedRows || 0;
}

function fbPageUrl(pageId, link) {
    const l = String(link || '').trim();
    if (l && /^https?:\/\//i.test(l)) return l;
    if (pageId) return `https://www.facebook.com/${pageId}`;
    return '';
}

async function recordUserLogin(fbUserId, ip, pages) {
    if (!pool || !fbUserId) return;
    const ipStr = ip ? String(ip).split(',')[0].trim().slice(0, 45) : null;
    try {
        await pool.query(
            `UPDATE users SET last_login_at = NOW(), last_login_ip = COALESCE(?, last_login_ip) WHERE fb_user_id = ?`,
            [ipStr, fbUserId]
        );
        await pool.query(
            'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)',
            [fbUserId, 'login', ipStr ? `IP ${ipStr}` : 'Session login']
        );
    } catch (_) {}
    if (Array.isArray(pages) && pages.length) await linkUserPages(fbUserId, pages);
}

async function linkUserPages(fbUserId, pages) {
    if (!pool || !fbUserId || !Array.isArray(pages)) return;
    for (const p of pages) {
        const id = p.id || p.fb_page_id;
        if (!id) continue;
        const name = p.name || p.page_name || null;
        const url = fbPageUrl(id, p.link || p.page_url);
        try {
            await pool.query(
                `INSERT INTO user_fb_pages (fb_user_id, fb_page_id, page_name, page_url)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE page_name = VALUES(page_name), page_url = VALUES(page_url), linked_at = NOW()`,
                [fbUserId, String(id), name, url || null]
            );
        } catch (_) {}
    }
}

async function getUserFbPages(fbUserId) {
    if (!pool || !fbUserId) return [];
    try {
        const [rows] = await pool.query(
            `SELECT fb_page_id, page_name, page_url, linked_at FROM user_fb_pages WHERE fb_user_id = ? ORDER BY page_name ASC`,
            [fbUserId]
        );
        return rows.map(r => ({
            id: r.fb_page_id,
            name: r.page_name || r.fb_page_id,
            url: r.page_url || fbPageUrl(r.fb_page_id),
            linked_at: r.linked_at
        }));
    } catch (_) {
        return [];
    }
}

async function getAdminRevenueTotals() {
    const empty = { today: 0, week: 0, month: 0, year: 0, allTime: 0, paymentsToday: 0, mrrEstimate: 0 };
    if (!pool) return empty;
    try {
        const [[row]] = await pool.query(`
            SELECT
              COALESCE(SUM(CASE WHEN status='succeeded' AND DATE(created_at)=CURDATE() THEN amount_cents END),0) AS today,
              COALESCE(SUM(CASE WHEN status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN amount_cents END),0) AS week,
              COALESCE(SUM(CASE WHEN status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN amount_cents END),0) AS month,
              COALESCE(SUM(CASE WHEN status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY) THEN amount_cents END),0) AS year,
              COALESCE(SUM(CASE WHEN status='succeeded' THEN amount_cents END),0) AS all_time,
              COALESCE(SUM(CASE WHEN status='succeeded' AND DATE(created_at)=CURDATE() THEN 1 END),0) AS payments_today,
              COALESCE(SUM(CASE WHEN status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN amount_cents END),0) AS mrr_raw
            FROM payment_history
        `);
        return {
            today: Number(row.today) || 0,
            week: Number(row.week) || 0,
            month: Number(row.month) || 0,
            year: Number(row.year) || 0,
            allTime: Number(row.all_time) || 0,
            paymentsToday: Number(row.payments_today) || 0,
            mrrEstimate: Number(row.mrr_raw) || 0
        };
    } catch (_) {
        return empty;
    }
}

async function getAdminRevenueSeries(period) {
    if (!pool) return [];
    const p = String(period || 'month').toLowerCase();
    let sql;
    if (p === 'day') {
        sql = `SELECT DATE(created_at) AS bucket, COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS cnt
               FROM payment_history WHERE status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
               GROUP BY DATE(created_at) ORDER BY bucket ASC`;
    } else if (p === 'week') {
        sql = `SELECT DATE_FORMAT(created_at,'%x-W%v') AS bucket, COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS cnt
               FROM payment_history WHERE status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 84 DAY)
               GROUP BY bucket ORDER BY bucket ASC`;
    } else if (p === 'year') {
        sql = `SELECT YEAR(created_at) AS bucket, COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS cnt
               FROM payment_history WHERE status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 5 YEAR)
               GROUP BY YEAR(created_at) ORDER BY bucket ASC`;
    } else {
        sql = `SELECT DATE_FORMAT(created_at,'%Y-%m') AS bucket, COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS cnt
               FROM payment_history WHERE status='succeeded' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
               GROUP BY DATE_FORMAT(created_at,'%Y-%m') ORDER BY bucket ASC`;
    }
    try {
        const [rows] = await pool.query(sql);
        return rows.map(r => ({
            bucket: String(r.bucket),
            total: Number(r.total) || 0,
            count: Number(r.cnt) || 0
        }));
    } catch (_) {
        return [];
    }
}

async function getAdminUserDetail(fbUserId) {
    if (!pool || !fbUserId) return null;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE fb_user_id = ? LIMIT 1', [fbUserId]);
        const user = rows[0];
        if (!user) return null;
        delete user.fb_access_token;
        user.page_count = (await getUserFbPages(fbUserId)).length;
        user.pages = await getUserFbPages(fbUserId);
        user.messages_remaining = Math.max(0, (user.messenger_messages_limit || 0) - (user.messenger_messages_used || 0));
        const [payments] = await pool.query(
            `SELECT plan, amount_cents, status, billing_reason, created_at FROM payment_history
             WHERE fb_user_id = ? ORDER BY created_at DESC LIMIT 20`,
            [fbUserId]
        );
        const [acts] = await pool.query(
            `SELECT action, detail, created_at FROM activity_log WHERE fb_user_id = ? ORDER BY created_at DESC LIMIT 15`,
            [fbUserId]
        );
        return { user, payments, activity: acts };
    } catch (_) {
        return null;
    }
}

async function getAdminExpiringUsers(days = 7, limit = 20) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(
            `SELECT fb_user_id, fb_name, plan, subscription_expires, messenger_messages_used, messenger_messages_limit
             FROM users
             WHERE subscription_expires IS NOT NULL
               AND subscription_expires > NOW()
               AND subscription_expires <= DATE_ADD(NOW(), INTERVAL ? DAY)
             ORDER BY subscription_expires ASC LIMIT ?`,
            [days, limit]
        );
        return rows;
    } catch (_) {
        return [];
    }
}

const dbModule = {
    initDatabase,
    getPool: () => pool,
    isConnected,
    savePage,
    savePages,
    getPages,
    getPageToken,
    markCannotReply,
    saveConversation,
    saveConversations,
    getConversations,
    getPagePsids,
    getConversationCount,
    searchConversations,
    searchConversationsFromFacebook,
    searchInbox,
    getAllConversations,
    getConversationsBulk,
    saveMessage,
    saveMessages,
    getMessages,
    syncConversationsFromFacebook,
    syncMessagesFromFacebook,
    syncAllPageData,
    syncAllPageData3Months,
    syncConversationsAll,
    parallelLimit,
    getLatestMessageTime,
    getPageSyncTime,
    updatePageSyncTime,
    syncThreadMessages,
    syncPageInitial,
    syncPageIncremental,
    updateConversationFromMessage,
    getUnreadCountsForPages,
    pollAllPagesInbox,
    getConversationIdByParticipant,
    getConversationById,
    getLastError,
    isPageSyncing,
    getDbErrorLogs: () => dbErrorLogs,
    getStats,
    updateUserQuota,
    upsertUserFacebookName,
    markAsRead,
    markAsUnread,
    markAllAsRead,
    pollInboxUpdates,
    getHotConversationsForSync,
    getNewMessagesSince,
    getUpdatedConvsSince,
    getTotalUnread,
    searchMessages,
    archiveConversation,
    unarchiveConversation,
    getNotes,
    saveNote,
    deleteNote,
    getCannedReplies,
    saveCannedReply,
    updateCannedReply,
    deleteCannedReply,
    cleanupOldMessages,
    cleanupStaleConversations,
    scheduleDeferredCleanup,
    messageRetentionCutoff,
    messageRetentionCutoffUnix,
    MESSAGE_RETENTION_DAYS,
    CONVERSATION_RETENTION_DAYS,
    ensureConversation,
    touchConversationFromLatestMessage,
    onIncomingMessage,
    migrateSchedules,
    createSchedule,
    getSchedules,
    cancelSchedule,
    getDueSchedules,
    updateScheduleStatus,
    insertBroadcastHistory,
    getBroadcastHistory,
    getUserPreferences,
    upsertUserPreferences,
    getUserProfile,
    ensureBillingTables,
    reserveWebhookEvent,
    markWebhookProcessed,
    markWebhookFailed,
    recordPayment,
    applyPlan,
    adminActivatePlan,
    renewPlan,
    downgradeToFree,
    computeEntitlements,
    assertQuota,
    checkExpiredSubscriptions,
    recordUserLogin,
    linkUserPages,
    getUserFbPages,
    getAdminRevenueTotals,
    getAdminRevenueSeries,
    getAdminUserDetail,
    getAdminExpiringUsers,
    fbPageUrl
};

// ── ensureConversation — INSERT IGNORE then SELECT (race-safe) ────────────────
async function ensureConversation(pageId, participantId) {
    if (!pool) return null;
    try {
        await pool.query(`
            INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at, is_unread, can_reply)
            VALUES (?, ?, 'User', '', NOW(), 0, 1)
        `, [pageId, participantId]);
        const [rows] = await pool.query(
            'SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?',
            [pageId, participantId]
        );
        return rows[0]?.id || null;
    } catch (err) {
        addDbError(`ensureConversation: ${err.message}`);
        return null;
    }
}

// ── onIncomingMessage — increment unread, update snippet ─────────────────────
async function onIncomingMessage(threadId, pageId, participantId, text) {
    if (!pool) return;
    try {
        await pool.query(`
            UPDATE messenger_conversations
            SET snippet = ?, updated_at = NOW(), is_unread = is_unread + 1, last_from_me = 0
            WHERE id = ?
        `, [(text || '').substring(0, 200), threadId]);
    } catch (err) {
        addDbError(`onIncomingMessage: ${err.message}`);
    }
}

// ── Scheduled Broadcasts ──────────────────────────────────────────────────────
// Migration: add pages_data column (safe — ignored if already exists)
async function migrateSchedules() {
    if (!pool) return;
    try { await pool.query("ALTER TABLE scheduled_broadcasts ADD COLUMN pages_data JSON DEFAULT NULL"); } catch (_) {}
}

// pages: [{id, name, token}, ...]
async function createSchedule({ fb_user_id, pages, message, image_url, delay_ms, scheduled_at }) {
    if (!pool) throw new Error('DB not connected');
    const pagesJson = JSON.stringify(pages || []);
    const firstPage = (pages || [])[0] || {};
    const [result] = await pool.query(
        `INSERT INTO scheduled_broadcasts
         (fb_user_id, page_id, page_name, page_token, pages_data, message, image_url, delay_ms, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fb_user_id, firstPage.id || '', firstPage.name || null, firstPage.token || '',
         pagesJson, message, image_url || null, delay_ms || 1200, scheduled_at]
    );
    return result.insertId;
}

async function getSchedules(fb_user_id) {
    if (!pool) return [];
    const [rows] = await pool.query(
        `SELECT id, pages_data, page_id, page_name, message, image_url, delay_ms,
                scheduled_at, status, total_recipients, sent_count, failed_count,
                error_message, created_at
         FROM scheduled_broadcasts
         WHERE fb_user_id = ? AND status != 'cancelled'
         ORDER BY scheduled_at DESC LIMIT 100`,
        [fb_user_id]
    );
    return rows.map(r => ({
        ...r,
        pages: r.pages_data ? (typeof r.pages_data === 'string' ? JSON.parse(r.pages_data) : r.pages_data) : [{ id: r.page_id, name: r.page_name }]
    }));
}

async function cancelSchedule(id, fb_user_id) {
    if (!pool) return false;
    const [result] = await pool.query(
        `UPDATE scheduled_broadcasts SET status = 'cancelled'
         WHERE id = ? AND fb_user_id = ? AND status = 'pending'`,
        [id, fb_user_id]
    );
    return result.affectedRows > 0;
}

async function getDueSchedules() {
    if (!pool) return [];
    const [rows] = await pool.query(
        `SELECT id, fb_user_id, page_id, page_token, pages_data, message, image_url, delay_ms
         FROM scheduled_broadcasts
         WHERE status = 'pending' AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC LIMIT 10`
    );
    return rows.map(r => ({
        ...r,
        pages: r.pages_data ? (typeof r.pages_data === 'string' ? JSON.parse(r.pages_data) : r.pages_data) : [{ id: r.page_id, token: r.page_token }]
    }));
}

async function updateScheduleStatus(id, status, stats = {}) {
    if (!pool) return;
    await pool.query(
        `UPDATE scheduled_broadcasts
         SET status = ?, total_recipients = COALESCE(?, total_recipients),
             sent_count = COALESCE(?, sent_count), failed_count = COALESCE(?, failed_count),
             error_message = COALESCE(?, error_message)
         WHERE id = ?`,
        [status, stats.total || null, stats.sent || null, stats.failed || null, stats.error || null, id]
    );
}

// ── Broadcast history (per user, survives logout) ───────────────────────────
async function insertBroadcastHistory(fb_user_id, row = {}) {
    if (!pool || !fb_user_id) return null;
    const mode = ['manual', 'auto', 'scheduled'].includes(row.mode) ? row.mode : 'manual';
    const sent = Math.max(0, parseInt(row.sent, 10) || 0);
    const failed = Math.max(0, parseInt(row.failed, 10) || 0);
    const total = Math.max(0, parseInt(row.total, 10) || sent + failed);
    if (sent + failed === 0 && total === 0) return null;
    const [result] = await pool.query(
        `INSERT INTO broadcast_history
         (fb_user_id, mode, page_id, pages_count, total_recipients, sent_count, failed_count, message_preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            fb_user_id,
            mode,
            row.pageId || row.page_id || null,
            Math.max(1, parseInt(row.pages || row.pages_count, 10) || 1),
            total,
            sent,
            failed,
            (row.message_preview || row.label) ? String(row.message_preview || row.label).slice(0, 160) : null
        ]
    );
    return result.insertId;
}

async function getBroadcastHistory(fb_user_id, days = 90) {
    if (!pool || !fb_user_id) return [];
    const d = Math.min(365, Math.max(1, parseInt(days, 10) || 90));
    const [rows] = await pool.query(
        `SELECT id, mode, page_id, pages_count, total_recipients, sent_count, failed_count,
                message_preview, created_at
         FROM broadcast_history
         WHERE fb_user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ORDER BY created_at DESC
         LIMIT 200`,
        [fb_user_id, d]
    );
    return rows.map((r) => ({
        id: 'bh_' + r.id,
        ts: r.created_at,
        mode: r.mode,
        pageId: r.page_id,
        pages: r.pages_count,
        total: r.total_recipients,
        sent: r.sent_count,
        failed: r.failed_count,
        label: r.message_preview
    }));
}

// ── User preferences (per user, survives logout) ──────────────────────────────
const DEFAULT_PREFS = {
    notif_broadcast: true,
    notif_failed: true,
    default_delay_ms: 1200,
    message_draft: ''
};

async function getUserPreferences(fb_user_id) {
    if (!pool || !fb_user_id) return { ...DEFAULT_PREFS };
    const [rows] = await pool.query(
        'SELECT notif_broadcast, notif_failed, default_delay_ms, message_draft FROM user_preferences WHERE fb_user_id = ?',
        [fb_user_id]
    );
    if (!rows.length) return { ...DEFAULT_PREFS };
    const r = rows[0];
    return {
        notif_broadcast: !!r.notif_broadcast,
        notif_failed: !!r.notif_failed,
        default_delay_ms: Math.max(500, parseInt(r.default_delay_ms, 10) || 1200),
        message_draft: r.message_draft || ''
    };
}

async function upsertUserPreferences(fb_user_id, patch = {}) {
    if (!pool || !fb_user_id) return { ...DEFAULT_PREFS };
    const current = await getUserPreferences(fb_user_id);
    const next = {
        notif_broadcast: patch.notif_broadcast !== undefined ? !!patch.notif_broadcast : current.notif_broadcast,
        notif_failed: patch.notif_failed !== undefined ? !!patch.notif_failed : current.notif_failed,
        default_delay_ms: patch.default_delay_ms !== undefined
            ? Math.max(500, parseInt(patch.default_delay_ms, 10) || 1200)
            : current.default_delay_ms,
        message_draft: patch.message_draft !== undefined
            ? String(patch.message_draft || '').slice(0, 2000)
            : current.message_draft
    };
    await pool.query(
        `INSERT INTO user_preferences (fb_user_id, notif_broadcast, notif_failed, default_delay_ms, message_draft)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           notif_broadcast = VALUES(notif_broadcast),
           notif_failed = VALUES(notif_failed),
           default_delay_ms = VALUES(default_delay_ms),
           message_draft = VALUES(message_draft)`,
        [fb_user_id, next.notif_broadcast ? 1 : 0, next.notif_failed ? 1 : 0, next.default_delay_ms, next.message_draft || null]
    );
    return next;
}

async function getUserProfile(fb_user_id) {
    const quota = await updateUserQuota(fb_user_id, 0);
    const preferences = await getUserPreferences(fb_user_id);
    return { quota, preferences };
}

// Getter so server.js can access db.pool after initDatabase() assigns it
Object.defineProperty(dbModule, 'pool', { get: () => pool, enumerable: true });

module.exports = dbModule;
