require('dotenv').config();
const mysql = require('mysql2/promise');

let pool = null;
const syncStatus = new Map(); // pageId -> boolean
let dbErrorLogs = [];
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
            connectionLimit: 30,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
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

        // ── Free disk space first — sessions table bloats rapidly ────────
        try { await connection.query('DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()'); } catch (_) {}
        try { await connection.query('TRUNCATE TABLE sessions'); } catch (_) {}
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
                updated_at DATETIME DEFAULT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_page_user (page_id, fb_user_id),
                KEY idx_inbox (page_id, updated_at DESC)
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
            "ALTER TABLE messenger_conversations ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0"
        ];
        for (const sql of migrations) {
            try { await connection.query(sql); } catch (_) { /* column already exists */ }
        }

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

async function saveConversation(conversation) {
    if (!pool) return;
    const { id, pageId, participantId, participantName, snippet, updatedTime, isRead, unreadCount } = conversation;
    if (!pageId || !participantId) return; // fb_user_id is NOT NULL — skip rather than fail
    const fbUnreadCount = unreadCount != null ? unreadCount : (isRead ? 0 : 1);

    try {
        await pool.query(`
            INSERT INTO messenger_conversations (page_id, fb_user_id, fb_conv_id, user_name, snippet, updated_at, is_unread)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                fb_conv_id = COALESCE(VALUES(fb_conv_id), fb_conv_id),
                user_name = VALUES(user_name),
                snippet = VALUES(snippet),
                updated_at = VALUES(updated_at),
                is_unread = VALUES(is_unread)
        `, [pageId, participantId, id, participantName, snippet, updatedTime ? new Date(updatedTime) : null, fbUnreadCount]);
    } catch (err) {
        addDbError(`saveConversation: ${err.message}`);
    }
}

async function saveConversations(messenger_conversations) {
    if (!pool || messenger_conversations.length === 0) return;
    for (const c of messenger_conversations) await saveConversation(c).catch(() => {});
}

async function getConversations(pageId, limit = 100, offset = 0, archived = false) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id as participant_id, c.user_name as participant_name, c.user_picture as participant_picture, c.snippet, c.updated_at as updated_time, c.is_unread,
                   p.name as page_name, p.avatar_url as page_picture
            FROM messenger_conversations c
            LEFT JOIN messenger_pages p ON c.page_id = p.fb_page_id
            WHERE c.page_id = ? AND COALESCE(c.archived, 0) = ?
            ORDER BY c.updated_at DESC
            LIMIT ? OFFSET ?
        `, [pageId, archived ? 1 : 0, limit, offset]);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            participantPicture: row.participant_picture,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: row.is_unread === 0,
            unreadCount: row.is_unread || 0,
            pageName: row.page_name,
            pagePicture: row.page_picture
        }));
    } catch (err) {
        addDbError(`getConversations: ${err.message}`);
        return [];
    }
}

async function searchConversations(pageId, query, limit = 30) {
    if (!pool) return [];
    const q = `%${query}%`;
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.fb_user_id as participant_id, c.user_name as participant_name, c.snippet, c.updated_at as updated_time, c.is_unread,
                   p.name as page_name, p.avatar_url as page_picture
            FROM messenger_conversations c
            LEFT JOIN messenger_pages p ON c.page_id = p.fb_page_id
            WHERE c.page_id = ? AND (c.user_name LIKE ? OR c.snippet LIKE ?)
            ORDER BY c.updated_at DESC
            LIMIT ?
        `, [pageId, q, q, limit]);
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
            pagePicture: row.page_picture
        }));
    } catch (err) {
        addDbError(`searchConversations: ${err.message}`);
        return [];
    }
}

async function getConversationCount(pageId, archived = false) {
    if (!pool) return 0;
    try {
        const [rows] = await pool.query(
            'SELECT COUNT(*) AS cnt FROM messenger_conversations WHERE page_id = ? AND COALESCE(archived, 0) = ?',
            [pageId, archived ? 1 : 0]
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
            `SELECT page_id, COUNT(*) AS cnt FROM messenger_conversations WHERE page_id IN (${placeholders}) AND is_unread > 0 GROUP BY page_id`,
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

async function getConversationIdByParticipant(pageId, participantId) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT id, fb_conv_id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?',
            [pageId, participantId]
        );
        return rows[0] ? { id: rows[0].id, fbConvId: rows[0].fb_conv_id || null } : null;
    } catch (err) {
        addDbError(`getConversationIdByParticipant: ${err.message}`);
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
    if (!pool) return false;
    const { id, threadId, conversationId, pageId, senderId, text, attachments, isFromPage, createdTime } = message;
    const convId = conversationId || threadId; // accept both field names
    const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

    try {
        await pool.query(`
            INSERT INTO messenger_messages (conversation_id, page_id, user_id, message_id, message, from_me, created_at, attachment_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                message = VALUES(message),
                attachment_url = VALUES(attachment_url),
                created_at = VALUES(created_at)
        `, [convId, pageId, senderId, id, text, isFromPage ? 1 : 0, createdTime ? new Date(createdTime) : new Date(), attachmentsJson]);
        return true;
    } catch (err) {
        addDbError(`saveMessage: ${err.message}`);
        return false;
    }
}

async function saveMessages(messenger_messages) {
    if (!pool || messenger_messages.length === 0) return;
    for (const m of messenger_messages) await saveMessage(m).catch(() => {});
}

async function getMessages(threadId, limit = 100, before = null) {
    if (!pool) return [];

    try {
        let query = `
            SELECT id, message_id as mid, message as text, from_me as is_from_page, created_at as created_time, attachment_url as attachments
            FROM messenger_messages
            WHERE conversation_id = ?
        `;
        let params = [threadId];

        if (before) {
            query += ' AND created_at < ?';
            params.push(new Date(before));
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const [rows] = await pool.query(query, params);

        // Reverse to return oldest → newest
        return rows.reverse().map(row => ({
            id: row.id,
            mid: row.mid,
            text: row.text,
            isFromPage: row.is_from_page === 1 || row.is_from_page === true,
            createdTime: row.created_time,
            attachments: row.attachments ? (typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments) : []
        }));
    } catch (err) {
        addDbError(`getMessages: ${err.message}`);
        return [];
    }
}

// =============================================================================
// Sync Functions
// =============================================================================

async function syncConversationsFromFacebook(pageId, pageToken, fetchFn) {
    // Always fetch from Facebook regardless of DB state
    const response = await fetchFn(
        `https://graph.facebook.com/v19.0/${pageId}/conversations?fields=id,participants,snippet,updated_time,unread_count&limit=100&access_token=${pageToken}`
    );
    const data = await response.json();

    if (data.error) {
        const err = new Error(data.error.message);
        err.fbCode = data.error.code;
        err.fbType = data.error.type;
        addDbError(`syncConversationsFromFacebook: ${err.message}`);
        console.error('DB: syncConversations FB error:', data.error);
        throw err;
    }

    const messenger_conversations = (data.data || []).map(conv => {
        const participant = conv.participants?.data?.find(p => p.id !== pageId);
        const fbCount = conv.unread_count || 0;
        return {
            id: conv.id,
            pageId: pageId,
            participantId: participant?.id,
            participantName: participant?.name || 'Unknown',
            snippet: conv.snippet || '',
            updatedTime: conv.updated_time,
            isRead: fbCount === 0,
            unreadCount: fbCount
        };
    });

    // Save to DB only if pool is available (disk-full / DB-down won't block showing messenger_conversations)
    if (pool && messenger_conversations.length > 0) {
        saveConversations(messenger_conversations).catch(err => {
            addDbError(`syncConversationsFromFacebook save: ${err.message}`);
        });
    }
    return messenger_conversations;
}

function parseAttachments(fbAttachments) {
    if (!fbAttachments) return [];
    const list = fbAttachments.data || (Array.isArray(fbAttachments) ? fbAttachments : []);
    return list.map(a => {
        const type = a.type || (a.mime_type ? a.mime_type.split('/')[0] : 'file');
        const url = a.payload?.url || a.file_url || a.image_data?.url || '';
        const entry = { t: type, u: url };
        if (a.name || a.payload?.name) entry.n = a.name || a.payload?.name;
        return entry;
    }).filter(a => a.u);
}

async function syncMessagesFromFacebook(threadId, pageId, pageToken, fetchFn, limit = 20) {
    try {
        const response = await fetchFn(
            `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,attachments&limit=${limit}&access_token=${pageToken}`
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
            attachments: parseAttachments(msg.attachments),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        }));

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

async function updateConversationFromMessage(message) {
    if (!pool) return;
    const { threadId, text, createdTime } = message;
    try {
        await pool.query(`
            UPDATE messenger_conversations
            SET snippet = ?, updated_at = ?
            WHERE id = ?
        `, [(text || '').substring(0, 200), createdTime ? new Date(createdTime) : new Date(), threadId]);
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

function buildConversationsUrl(pageId, pageToken, since = null) {
    const sinceParam = since ? `&since=${since}` : '';
    return `https://graph.facebook.com/v19.0/${pageId}/conversations?fields=id,participants,snippet,updated_time,unread_count&limit=50${sinceParam}&access_token=${pageToken}`;
}

async function syncConversationsAll(pageId, pageToken, fetchFn, since = null) {
    let allConversations = [];
    let nextUrl = buildConversationsUrl(pageId, pageToken, since);

    while (nextUrl) {
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

        const messenger_conversations = (data.data || []).flatMap(conv => {
            // Find the participant who is NOT the page itself
            const participants = conv.participants?.data || [];
            const participant = participants.find(p => String(p.id) !== String(pageId))
                             || participants.find(p => p.id)  // fallback: first available
                             || null;
            if (!participant?.id) {
                addDbError(`syncConversationsAll: skipping conv ${conv.id} — participants=${JSON.stringify(participants)}`);
                return []; // flatMap skips
            }
            const fbCount = conv.unread_count || 0;
            return [{
                id: conv.id,
                pageId: pageId,
                participantId: String(participant.id),
                participantName: participant.name || 'User',
                snippet: (conv.snippet || '').substring(0, 200),
                updatedTime: conv.updated_time,
                isRead: fbCount === 0,
                unreadCount: fbCount
            }];
        });

        if (messenger_conversations.length > 0) {
            await saveConversations(messenger_conversations);
            allConversations = allConversations.concat(messenger_conversations);
        }

        nextUrl = data.paging?.next || null;
    }
    return allConversations;
}

async function syncMessagesAll(threadId, pageId, pageToken, fetchFn) {
    let nextUrl = `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,attachments&limit=100&access_token=${pageToken}`;

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
            attachments: parseAttachments(msg.attachments),
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

    let nextUrl = `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,attachments&limit=100&access_token=${pageToken}`;
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
            attachments: parseAttachments(msg.attachments),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        }));
        if (messenger_messages.length > 0) {
            await saveMessages(messenger_messages);
            saved += messenger_messages.length;
        }
        // No cutoff = incremental: first page (newest 100 msgs) is enough
        if (!cutoffMs) break;
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

// First-time sync: all messenger_conversations + last 7 days of messenger_messages, parallel
async function syncPageInitial(pageId, pageToken, fetchFn, onProgress = null) {
    if (syncStatus.get(pageId)) return;
    syncStatus.set(pageId, true);
    const cutoff7DaysMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
        await logSync(pageId, 'initial_sync', 'running');
        // Only sync conversations updated in the last 7 days to save disk space
        const since7Days = Math.floor(cutoff7DaysMs / 1000);
        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, since7Days);
        if (onProgress) onProgress({ pageId, phase: 'messenger_conversations', total: messenger_conversations.length, done: 0 });

        let done = 0;
        const tasks = messenger_conversations.map(conv => async () => {
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoff7DaysMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messenger_messages', total: messenger_conversations.length, done });
            await logSync(pageId, 'initial_sync', 'running', messenger_conversations.length, done);
        });
        
        await parallelLimit(tasks, 20);
        await updatePageSyncTime(pageId);
        await logSync(pageId, 'initial_sync', 'done', messenger_conversations.length, done);
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

    try {
        await logSync(pageId, 'incremental_sync', 'running');
        const lastSynced = await getPageSyncTime(pageId);
        const sinceUnix = lastSynced
            ? Math.floor(new Date(lastSynced).getTime() / 1000)
            : Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

        const messenger_conversations = await syncConversationsAll(pageId, pageToken, fetchFn, sinceUnix);
        if (onProgress) onProgress({ pageId, phase: 'messenger_conversations', total: messenger_conversations.length, done: 0 });

        let done = 0;
        const tasks = messenger_conversations.map(conv => async () => {
            const latestTime = await getLatestMessageTime(conv.id);
            const cutoffMs = latestTime ? new Date(latestTime).getTime() : null;
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoffMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messenger_messages', total: messenger_conversations.length, done });
            await logSync(pageId, 'incremental_sync', 'running', messenger_conversations.length, done);
        });
        
        await parallelLimit(tasks, 20);
        await updatePageSyncTime(pageId);
        await logSync(pageId, 'incremental_sync', 'done', messenger_conversations.length, done);
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
                    attachment_url, attachment_type
             FROM messenger_messages
             WHERE conversation_id = ? AND created_at > ?
             ORDER BY created_at ASC`,
            [convId, sinceDate]
        );
        return rows;
    } catch (err) {
        addDbError(`getNewMessagesSince: ${err.message}`);
        return [];
    }
}

async function getUpdatedConvsSince(pageId, since) {
    if (!pool) return [];
    try {
        const sinceDate = since instanceof Date ? since : new Date(since);
        const [rows] = await pool.query(
            'SELECT id, page_id, fb_user_id, user_name, user_picture, snippet, updated_at, is_unread, last_from_me FROM messenger_conversations WHERE page_id = ? AND updated_at > ? ORDER BY updated_at DESC',
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
        const [rows] = await pool.query(
            'SELECT SUM(is_unread) as total FROM messenger_conversations WHERE page_id = ?',
            [pageId]
        );
        return rows[0]?.total || 0;
    } catch (err) {
        addDbError(`getTotalUnread: ${err.message}`);
        return 0;
    }
}

async function searchMessages(pageId, query) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(
            `SELECT m.message_id, m.message, m.from_me, m.created_at, m.user_id,
                    c.fb_user_id as senderId, c.user_name, c.user_picture
             FROM messenger_messages m
             JOIN messenger_conversations c ON m.conversation_id = c.id
             WHERE m.page_id = ? AND m.message LIKE ?
             ORDER BY m.created_at DESC LIMIT 50`,
            [pageId, `%${query}%`]
        );
        return rows;
    } catch (err) {
        addDbError(`searchMessages: ${err.message}`);
        return [];
    }
}

async function updateUserQuota(fbUserId, count) {
    if (!pool) return null;
    try {
        // Ensure user exists (default to free)
        await pool.query(`
            INSERT IGNORE INTO users (fb_user_id, plan, messenger_messages_limit)
            VALUES (?, 'free', 2000)
        `, [fbUserId]);

        // Atomic update
        await pool.query(`
            UPDATE users
            SET messenger_messages_used = LEAST(messenger_messages_limit, messenger_messages_used + ?)
            WHERE fb_user_id = ?
        `, [count, fbUserId]);

        // Fetch updated info
        const [rows] = await pool.query(
            'SELECT messenger_messages_used, messenger_messages_limit, plan FROM users WHERE fb_user_id = ?',
            [fbUserId]
        );
        
        if (rows.length > 0) {
            const row = rows[0];
            const remaining = Math.max(0, row.messenger_messages_limit - row.messenger_messages_used);
            
            // Log activity
            await pool.query(
                'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, "send", ?)',
                [fbUserId, `Sent: ${count} | Remaining: ${remaining}`]
            ).catch(() => {}); // non-critical

            return {
                success: true,
                messenger_messagesUsed: row.messenger_messages_used,
                messageLimit: row.messenger_messages_limit,
                subscriptionStatus: row.plan,
                remaining
            };
        }
        return null;
    } catch (err) {
        addDbError(`updateUserQuota: ${err.message}`);
        return null;
    }
}

async function cleanupOldMessages(daysOld = 30) {
    if (!pool) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    try {
        await pool.query('DELETE FROM messenger_messages WHERE created_at < ?', [cutoff]);
        await pool.query('DELETE FROM messenger_conversations WHERE updated_at < ?', [cutoff]);
    } catch (err) {
        addDbError(`cleanupOldMessages: ${err.message}`);
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
    saveConversation,
    saveConversations,
    getConversations,
    getPagePsids,
    getConversationCount,
    searchConversations,
    getAllConversations,
    getConversationsBulk,
    saveMessage,
    saveMessages,
    getMessages,
    syncConversationsFromFacebook,
    syncMessagesFromFacebook,
    syncAllPageData,
    syncAllPageData3Months,
    parallelLimit,
    getLatestMessageTime,
    getPageSyncTime,
    updatePageSyncTime,
    syncThreadMessages,
    syncPageInitial,
    syncPageIncremental,
    updateConversationFromMessage,
    getUnreadCountsForPages,
    getConversationIdByParticipant,
    getLastError,
    getDbErrorLogs: () => dbErrorLogs,
    getStats,
    updateUserQuota,
    markAsRead,
    markAsUnread,
    markAllAsRead,
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
    deleteCannedReply,
    cleanupOldMessages,
    ensureConversation,
    onIncomingMessage,
    migrateSchedules,
    createSchedule,
    getSchedules,
    cancelSchedule,
    getDueSchedules,
    updateScheduleStatus
};

// ── ensureConversation — INSERT IGNORE then SELECT (race-safe) ────────────────
async function ensureConversation(pageId, participantId) {
    if (!pool) return null;
    try {
        await pool.query(`
            INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at, is_unread)
            VALUES (?, ?, 'User', '', NOW(), 0)
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

// Getter so server.js can access db.pool after initDatabase() assigns it
Object.defineProperty(dbModule, 'pool', { get: () => pool, enumerable: true });

module.exports = dbModule;
