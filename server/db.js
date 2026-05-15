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
            connectionLimit: 15,
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

        // Test connection with a timeout
        const connection = await pool.getConnection();
        console.log('MySQL connected successfully');

        // Create tables using query() instead of execute() for DDL
        await connection.query(`
            CREATE TABLE IF NOT EXISTS pages (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(500) NOT NULL,
                picture TEXT,
                access_token TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id VARCHAR(255) PRIMARY KEY,
                page_id VARCHAR(255) NOT NULL,
                participant_id VARCHAR(255) NOT NULL,
                participant_name VARCHAR(500),
                snippet TEXT,
                updated_time DATETIME,
                is_read BOOLEAN DEFAULT TRUE,
                unread_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_page_id (page_id),
                INDEX idx_updated_time (updated_time),
                INDEX idx_participant (participant_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        // Ensure is_read column exists
        try {
            const [columns] = await connection.query('SHOW COLUMNS FROM conversations LIKE "is_read"');
            if (columns.length === 0) {
                await connection.query('ALTER TABLE conversations ADD COLUMN is_read BOOLEAN DEFAULT TRUE AFTER updated_time');
            }
        } catch (e) { console.warn('DB: Column check warning:', e.message); }

        // Ensure unread_count column exists
        try {
            const [ucols] = await connection.query('SHOW COLUMNS FROM conversations LIKE "unread_count"');
            if (ucols.length === 0) {
                await connection.query('ALTER TABLE conversations ADD COLUMN unread_count INT DEFAULT 0 AFTER is_read');
            }
        } catch (e) { console.warn('DB: unread_count column check warning:', e.message); }

        // Ensure last_message_from_page column exists
        try {
            const [lcols] = await connection.query('SHOW COLUMNS FROM conversations LIKE "last_message_from_page"');
            if (lcols.length === 0) {
                await connection.query('ALTER TABLE conversations ADD COLUMN last_message_from_page BOOLEAN DEFAULT FALSE AFTER unread_count');
            }
        } catch (e) { console.warn('DB: last_message_from_page column check warning:', e.message); }

        // Ensure pages.last_synced_at column exists (tracks per-page sync state)
        try {
            const [scols] = await connection.query('SHOW COLUMNS FROM pages LIKE "last_synced_at"');
            if (scols.length === 0) {
                await connection.query('ALTER TABLE pages ADD COLUMN last_synced_at DATETIME NULL AFTER access_token');
            }
        } catch (e) { console.warn('DB: last_synced_at column check warning:', e.message); }

        // ── Users Table ───────────────────────────────────────────────────
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                fb_user_id VARCHAR(50) PRIMARY KEY,
                email VARCHAR(255),
                plan ENUM('free','basic','pro','gold','sapphire','platinum','unknown') DEFAULT 'free',
                messages_used INT DEFAULT 0,
                messages_limit INT DEFAULT 2000,
                stripe_customer_id VARCHAR(255),
                stripe_subscription_id VARCHAR(255),
                subscription_expires DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_stripe_cust (stripe_customer_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // ── Activity Log ──────────────────────────────────────────────────
        await connection.query(`
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

        await connection.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR(255) PRIMARY KEY,
                thread_id VARCHAR(255) NOT NULL,
                page_id VARCHAR(255) NOT NULL,
                sender_id VARCHAR(255) NOT NULL,
                sender_type VARCHAR(50) NOT NULL,
                text TEXT,
                attachments TEXT,
                is_from_page BOOLEAN DEFAULT FALSE,
                created_time DATETIME NOT NULL,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_thread_id (thread_id),
                INDEX idx_created_time (created_time)
            ) ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Add attachments column if missing (for existing databases)
        try {
            const [attCols] = await connection.query('SHOW COLUMNS FROM messages LIKE "attachments"');
            if (attCols.length === 0) {
                await connection.query('ALTER TABLE messages ADD COLUMN attachments TEXT AFTER text');
            }
        } catch (e) { console.warn('DB: attachments column check warning:', e.message); }

        await connection.query(`
            CREATE TABLE IF NOT EXISTS canned_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await connection.query(`
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

        // archived column — soft-delete conversations without losing messages
        try {
            const [archCols] = await connection.query('SHOW COLUMNS FROM conversations LIKE "archived"');
            if (archCols.length === 0) {
                await connection.query('ALTER TABLE conversations ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0 AFTER unread_count, ADD INDEX idx_archived (archived)');
            }
        } catch (e) { console.warn('DB: archived column check warning:', e.message); }

        connection.release();
        console.log('Database tables verified');
        pool.lastError = null;
        return pool;

    } catch (err) {
        console.error('MySQL connection failed:', err.message);
        addDbError(`Connection failed: ${err.message}`);
        if (pool) pool.lastError = err.message;
        else initDatabase.lastError = err.message;
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
            INSERT INTO pages (id, name, picture, access_token)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                picture = VALUES(picture),
                access_token = VALUES(access_token),
                updated_at = CURRENT_TIMESTAMP
        `, [id, name, picture, accessToken]);
    } catch (err) {
        addDbError(`savePage: ${err.message}`);
    }
}

async function savePages(pages) {
    for (const page of pages) {
        await savePage(page);
    }
}

async function getPages() {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT id, name, picture, access_token, last_synced_at, created_at, updated_at
            FROM pages
            ORDER BY name ASC
        `);
        return rows.map(row => ({
            id: row.id,
            name: row.name,
            picture: row.picture,
            access_token: row.access_token,
            last_synced_at: row.last_synced_at
        }));
    } catch (err) {
        addDbError(`getPages: ${err.message}`);
        return [];
    }
}

async function getPageToken(pageId) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT access_token FROM pages WHERE id = ?',
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
    const fbUnreadCount = unreadCount != null ? unreadCount : 0;

    try {
        if (isRead !== undefined) {
            // ON DUPLICATE KEY never touches is_read or unread_count.
            // unread_count is managed exclusively by the webhook (+1 per message)
            // and markAsRead (reset to 0). FB sync must not overwrite these —
            // FB's unread_count is a historical total and can be in the hundreds.
            await pool.query(`
                INSERT INTO conversations (id, page_id, participant_id, participant_name, snippet, updated_time, is_read, unread_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    participant_name = VALUES(participant_name),
                    snippet = VALUES(snippet),
                    updated_time = VALUES(updated_time),
                    updated_at = CURRENT_TIMESTAMP
            `, [id, pageId, participantId, participantName, snippet, updatedTime ? new Date(updatedTime) : null, isRead ? 1 : 0, fbUnreadCount]);
        } else {
            await pool.query(`
                INSERT INTO conversations (id, page_id, participant_id, participant_name, snippet, updated_time)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    participant_name = VALUES(participant_name),
                    snippet = VALUES(snippet),
                    updated_time = VALUES(updated_time),
                    updated_at = CURRENT_TIMESTAMP
            `, [id, pageId, participantId, participantName, snippet, updatedTime ? new Date(updatedTime) : null]);
        }
    } catch (err) {
        addDbError(`saveConversation: ${err.message}`);
    }
}

async function saveConversations(conversations) {
    if (!pool || conversations.length === 0) return;
    // Batch INSERT — single round-trip instead of N queries
    try {
        const values = conversations.map(c => [
            c.id, c.pageId, c.participantId || '', c.participantName || '',
            (c.snippet || '').substring(0, 200),
            c.updatedTime ? new Date(c.updatedTime) : null,
            c.isRead ? 1 : 0,
            c.unreadCount || 0
        ]);
        await pool.query(`
            INSERT INTO conversations
                (id, page_id, participant_id, participant_name, snippet, updated_time, is_read, unread_count)
            VALUES ?
            ON DUPLICATE KEY UPDATE
                participant_name = VALUES(participant_name),
                snippet          = VALUES(snippet),
                updated_time     = VALUES(updated_time),
                updated_at       = CURRENT_TIMESTAMP
        `, [values]);
    } catch (err) {
        addDbError(`saveConversations batch: ${err.message}`);
        // Fallback: individual saves
        for (const c of conversations) await saveConversation(c).catch(() => {});
    }
}

async function getConversations(pageId, limit = 100, offset = 0, archived = false) {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.participant_id, c.participant_name, c.snippet, c.updated_time, c.is_read, c.unread_count, c.last_message_from_page,
                   COALESCE(c.archived, 0) as archived,
                   p.name as page_name, p.picture as page_picture
            FROM conversations c
            LEFT JOIN pages p ON c.page_id = p.id
            WHERE c.page_id = ? AND COALESCE(c.archived, 0) = ?
            ORDER BY c.updated_time DESC
            LIMIT ? OFFSET ?
        `, [pageId, archived ? 1 : 0, limit, offset]);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: row.is_read === 1 || row.is_read === true,
            unreadCount: row.unread_count || 0,
            pageName: row.page_name,
            pagePicture: row.page_picture,
            lastMessageFromPage: row.last_message_from_page === 1 || row.last_message_from_page === true,
            archived: row.archived === 1 || row.archived === true
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
            SELECT c.id, c.page_id, c.participant_id, c.participant_name, c.snippet, c.updated_time, c.is_read, c.unread_count, c.last_message_from_page,
                   p.name as page_name, p.picture as page_picture
            FROM conversations c
            LEFT JOIN pages p ON c.page_id = p.id
            WHERE c.page_id = ? AND (c.participant_name LIKE ? OR c.snippet LIKE ?)
            ORDER BY c.updated_time DESC
            LIMIT ?
        `, [pageId, q, q, limit]);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: row.is_read === 1 || row.is_read === true,
            unreadCount: row.unread_count || 0,
            pageName: row.page_name,
            pagePicture: row.page_picture,
            lastMessageFromPage: row.last_message_from_page === 1 || row.last_message_from_page === true
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
            'SELECT COUNT(*) AS cnt FROM conversations WHERE page_id = ? AND COALESCE(archived, 0) = ?',
            [pageId, archived ? 1 : 0]
        );
        return Number(rows[0]?.cnt || 0);
    } catch (err) {
        addDbError(`getConversationCount: ${err.message}`);
        return 0;
    }
}

// Get all conversations for multiple pages in one query (optimized for performance)
async function getConversationsBulk(pageIds, limitPerPage = 100) {
    if (!pool || !pageIds || pageIds.length === 0) return {};

    try {
        // Use IN clause to get conversations for all pages at once
        const placeholders = pageIds.map(() => '?').join(',');
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.participant_id, c.participant_name, c.snippet, c.updated_time, c.is_read, c.unread_count, c.last_message_from_page,
                   p.name as page_name, p.picture as page_picture
            FROM conversations c
            LEFT JOIN pages p ON c.page_id = p.id
            WHERE c.page_id IN (${placeholders})
            ORDER BY c.page_id, c.updated_time DESC
        `, pageIds);

        // Group by page_id
        const result = {};
        for (const pageId of pageIds) {
            result[pageId] = [];
        }
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
                    isRead: row.is_read === 1 || row.is_read === true,
                    unreadCount: row.unread_count || 0,
                    pageName: row.page_name,
                    pagePicture: row.page_picture,
                    lastMessageFromPage: row.last_message_from_page === 1 || row.last_message_from_page === true
                });
            }
        }
        return result;
    } catch (err) {
        addDbError(`getAllConversations: ${err.message}`);
        return {};
    }
}

async function getUnreadCountsForPages(pageIds) {
    if (!pool || !pageIds.length) return {};
    try {
        const placeholders = pageIds.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT page_id, COUNT(*) AS cnt FROM conversations WHERE page_id IN (${placeholders}) AND is_read = 0 GROUP BY page_id`,
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
            'SELECT id FROM conversations WHERE page_id = ? AND participant_id = ?',
            [pageId, participantId]
        );
        return rows[0]?.id || null;
    } catch (err) {
        addDbError(`getConversationIdByParticipant: ${err.message}`);
        return null;
    }
}

async function getAllConversations() {
    if (!pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.page_id, c.participant_id, c.participant_name, c.snippet, c.updated_time, c.is_read, c.unread_count, c.last_message_from_page,
                   p.name as page_name, p.picture as page_picture
            FROM conversations c
            LEFT JOIN pages p ON c.page_id = p.id
            ORDER BY c.updated_time DESC
        `);
        return rows.map(row => ({
            id: row.id,
            pageId: row.page_id,
            participantId: row.participant_id,
            participantName: row.participant_name,
            snippet: row.snippet,
            updatedTime: row.updated_time,
            isRead: row.is_read === 1 || row.is_read === true,
            unreadCount: row.unread_count || 0,
            pageName: row.page_name,
            pagePicture: row.page_picture,
            lastMessageFromPage: row.last_message_from_page === 1 || row.last_message_from_page === true
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
    const { id, threadId, pageId, senderId, senderType, text, attachments, isFromPage, createdTime } = message;
    // Store attachments as compact JSON: [{t:"image",u:"url"},{t:"file",u:"url",n:"name"}]
    const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

    try {
        await pool.query(`
            INSERT INTO messages (id, thread_id, page_id, sender_id, sender_type, text, attachments, is_from_page, created_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                thread_id = VALUES(thread_id),
                text = VALUES(text),
                attachments = VALUES(attachments),
                created_time = VALUES(created_time)
        `, [id, threadId, pageId, senderId, senderType, text, attachmentsJson, isFromPage ? 1 : 0, createdTime ? new Date(createdTime) : null]);
        return true;
    } catch (err) {
        addDbError(`saveMessage: ${err.message}`);
        return false;
    }
}

async function saveMessages(messages) {
    if (!pool || messages.length === 0) return;
    // Batch INSERT — single round-trip
    try {
        const values = messages.map(m => [
            m.id, m.threadId, m.pageId, m.senderId || '', m.senderType || 'customer',
            m.text || '',
            m.attachments && m.attachments.length > 0 ? JSON.stringify(m.attachments) : null,
            m.isFromPage ? 1 : 0,
            m.createdTime ? new Date(m.createdTime) : null
        ]);
        await pool.query(`
            INSERT INTO messages
                (id, thread_id, page_id, sender_id, sender_type, text, attachments, is_from_page, created_time)
            VALUES ?
            ON DUPLICATE KEY UPDATE
                text         = VALUES(text),
                attachments  = VALUES(attachments),
                created_time = VALUES(created_time)
        `, [values]);
    } catch (err) {
        addDbError(`saveMessages batch: ${err.message}`);
        for (const m of messages) await saveMessage(m).catch(() => {});
    }
}

async function getMessages(threadId, limit = 20) {
    if (!pool) return [];

    try {
        const [rows] = await pool.query(`
            SELECT id, thread_id, page_id, sender_id, sender_type, text, attachments, is_from_page, created_time
            FROM (
                SELECT id, thread_id, page_id, sender_id, sender_type, text, attachments, is_from_page, created_time
                FROM messages
                WHERE thread_id = ?
                ORDER BY created_time DESC
                LIMIT ?
            ) sub
            ORDER BY created_time ASC
        `, [threadId, limit]);

        return rows.map(row => ({
            id: row.id,
            threadId: row.thread_id,
            pageId: row.page_id,
            senderId: row.sender_id,
            senderType: row.sender_type,
            text: row.text,
            attachments: row.attachments ? JSON.parse(row.attachments) : [],
            isFromPage: row.is_from_page === 1 || row.is_from_page === true,
            createdTime: row.created_time
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

    const conversations = (data.data || []).map(conv => {
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

    // Save to DB only if pool is available (disk-full / DB-down won't block showing conversations)
    if (pool && conversations.length > 0) {
        saveConversations(conversations).catch(err => {
            addDbError(`syncConversationsFromFacebook save: ${err.message}`);
        });
    }
    return conversations;
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
    if (!pool) {
        console.log('DB: syncMessages - pool not available');
        return [];
    }

    try {
        const response = await fetchFn(
            `https://graph.facebook.com/v19.0/${threadId}/messages?fields=id,message,from,created_time,attachments&limit=${limit}&access_token=${pageToken}`
        );
        const data = await response.json();

        if (data.error) throw new Error(data.error.message);

        const messages = (data.data || []).map(msg => ({
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

        await saveMessages(messages);
        return await getMessages(threadId, limit);

    } catch (err) {
        addDbError(`syncMessagesFromFacebook: ${err.message}`);
        console.error('DB: syncMessages error:', err.message);
        return await getMessages(threadId);
    }
}

async function updateConversationFromMessage(message) {
    if (!pool) return;
    const { threadId, text, createdTime } = message;
    try {
        // Only update snippet and time, don't change is_read status
        // User's read status should be preserved
        await pool.query(`
            UPDATE conversations
            SET snippet = ?, updated_time = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [text, new Date(createdTime), threadId]);
    } catch (err) {
        console.error('DB: updateConversationFromMessage error:', err.message);
    }
}

async function markAsRead(threadId) {
    if (!pool) return;
    try {
        await pool.query(
            'UPDATE conversations SET is_read = 1, unread_count = 0 WHERE id = ?',
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
            'UPDATE conversations SET is_read = 0, unread_count = 1 WHERE id = ?',
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
        const conversations = await syncConversationsAll(pageId, pageToken, fetchFn, null);
        for (const conv of conversations) {
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

        const conversations = (data.data || []).map(conv => {
            const participant = conv.participants?.data?.find(p => p.id !== pageId);
            const fbCount = conv.unread_count || 0;
            return {
                id: conv.id,
                pageId: pageId,
                participantId: participant?.id,
                participantName: participant?.name || 'Unknown',
                snippet: (conv.snippet || '').substring(0, 200),
                updatedTime: conv.updated_time,
                isRead: fbCount === 0,
                unreadCount: fbCount
            };
        });

        if (conversations.length > 0) {
            await saveConversations(conversations);
            allConversations = allConversations.concat(conversations);
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

        const messages = (data.data || []).map(msg => ({
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

        if (messages.length > 0) {
            await saveMessages(messages);
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
        const conversations = await syncConversationsAll(pageId, pageToken, fetchFn, since);
        for (const conv of conversations) {
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
            'SELECT MAX(created_time) AS latest FROM messages WHERE thread_id = ?',
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
            'SELECT last_synced_at FROM pages WHERE id = ?',
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
        await pool.query('UPDATE pages SET last_synced_at = NOW() WHERE id = ?', [pageId]);
    } catch (err) {
        addDbError(`updatePageSyncTime: ${err.message}`);
    }
}

// Paginate Facebook messages DESC (newest first — default FB order).
// Stops when the oldest message on a page is older than `cutoffMs` (ms timestamp).
// Pass cutoffMs = null to only fetch the first page (fast incremental refresh).
async function syncThreadMessages(threadId, pageId, pageToken, fetchFn, cutoffMs = null) {
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
        const messages = (data.data || []).map(msg => ({
            id: msg.id, threadId, pageId,
            senderId: msg.from?.id || '',
            senderType: msg.from?.id === pageId ? 'page' : 'customer',
            text: msg.message || '',
            attachments: parseAttachments(msg.attachments),
            isFromPage: msg.from?.id === pageId,
            createdTime: msg.created_time
        }));
        if (messages.length > 0) {
            await saveMessages(messages);
            saved += messages.length;
        }
        // No cutoff = incremental: first page (newest 100 msgs) is enough
        if (!cutoffMs) break;
        // FB returns DESC: last element in array is the oldest on this page
        if (messages.length > 0) {
            const oldestMs = new Date(messages[messages.length - 1].createdTime).getTime();
            if (oldestMs <= cutoffMs) break; // covered everything we need
        }
        nextUrl = data.paging?.next || null; // next page = older messages
    }
    return saved;
}

// First-time sync: all conversations + last 1 month of messages, parallel
async function syncPageInitial(pageId, pageToken, fetchFn, onProgress = null) {
    if (!pool) return;
    if (syncStatus.get(pageId)) {
        console.log(`DB: syncPageInitial already running for ${pageId}`);
        return;
    }
    syncStatus.set(pageId, true);
    const cutoff1MonthMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    try {
        const conversations = await syncConversationsAll(pageId, pageToken, fetchFn, null);
        console.log(`DB: syncPageInitial [${pageId}] ${conversations.length} conversations`);
        if (onProgress) onProgress({ pageId, phase: 'conversations', total: conversations.length, done: 0 });

        let done = 0;
        const tasks = conversations.map(conv => async () => {
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoff1MonthMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messages', total: conversations.length, done });
        });
        await parallelLimit(tasks, 10);

        await updatePageSyncTime(pageId);
        console.log(`DB: syncPageInitial [${pageId}] complete`);
    } catch (err) {
        addDbError(`syncPageInitial: ${err.message}`);
        console.error(`DB: syncPageInitial error [${pageId}]:`, err.message);
    } finally {
        syncStatus.set(pageId, false);
    }
}

// Incremental sync: only conversations + messages updated since last sync
async function syncPageIncremental(pageId, pageToken, fetchFn, onProgress = null) {
    if (!pool) return;
    if (syncStatus.get(pageId)) {
        console.log(`DB: syncPageIncremental already running for ${pageId}`);
        return;
    }
    syncStatus.set(pageId, true);

    try {
        const lastSynced = await getPageSyncTime(pageId);
        const sinceUnix = lastSynced
            ? Math.floor(new Date(lastSynced).getTime() / 1000)
            : Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

        const conversations = await syncConversationsAll(pageId, pageToken, fetchFn, sinceUnix);
        console.log(`DB: syncPageIncremental [${pageId}] ${conversations.length} updated conversations`);
        if (onProgress) onProgress({ pageId, phase: 'conversations', total: conversations.length, done: 0 });

        let done = 0;
        const tasks = conversations.map(conv => async () => {
            const latestTime = await getLatestMessageTime(conv.id);
            // cutoffMs: stop paginating when we reach messages we already have
            const cutoffMs = latestTime ? new Date(latestTime).getTime() : null;
            await syncThreadMessages(conv.id, pageId, pageToken, fetchFn, cutoffMs);
            done++;
            if (onProgress) onProgress({ pageId, phase: 'messages', total: conversations.length, done });
        });
        await parallelLimit(tasks, 10);

        await updatePageSyncTime(pageId);
        console.log(`DB: syncPageIncremental [${pageId}] complete`);
    } catch (err) {
        addDbError(`syncPageIncremental: ${err.message}`);
        console.error(`DB: syncPageIncremental error [${pageId}]:`, err.message);
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
            'UPDATE conversations SET is_read = 1, unread_count = 0 WHERE page_id = ? AND is_read = 0',
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
        await pool.query('UPDATE conversations SET archived = 1 WHERE id = ? AND page_id = ?', [convId, pageId]);
    } catch (err) { addDbError(`archiveConversation: ${err.message}`); }
}

async function unarchiveConversation(convId, pageId) {
    if (!pool) return;
    try {
        await pool.query('UPDATE conversations SET archived = 0 WHERE id = ? AND page_id = ?', [convId, pageId]);
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
        const [msgCount] = await pool.query('SELECT COUNT(*) as total FROM messages');
        const [convCount] = await pool.query('SELECT COUNT(*) as total FROM conversations');
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
        const [rows] = await pool.query(
            'SELECT * FROM messages WHERE thread_id = ? AND created_time > ? ORDER BY created_time ASC',
            [convId, since]
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
        const [rows] = await pool.query(
            'SELECT * FROM conversations WHERE page_id = ? AND updated_time > ? ORDER BY updated_time DESC',
            [pageId, since]
        );
        return rows.map(r => ({
            ...r,
            fb_user_id: r.participant_id,
            user_name: r.participant_name,
            user_picture: r.participant_picture,
            is_unread: r.is_read ? 0 : 1
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
            'SELECT SUM(unread_count) as total FROM conversations WHERE page_id = ?',
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
            `SELECT m.*, c.participant_name as user_name, c.participant_picture as user_picture 
             FROM messages m
             JOIN conversations c ON m.thread_id = c.id
             WHERE m.page_id = ? AND m.text LIKE ? 
             ORDER BY m.created_time DESC LIMIT 50`,
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
            INSERT IGNORE INTO users (fb_user_id, plan, messages_limit)
            VALUES (?, 'free', 2000)
        `, [fbUserId]);

        // Atomic update
        await pool.query(`
            UPDATE users
            SET messages_used = LEAST(messages_limit, messages_used + ?)
            WHERE fb_user_id = ?
        `, [count, fbUserId]);

        // Fetch updated info
        const [rows] = await pool.query(
            'SELECT messages_used, messages_limit, plan FROM users WHERE fb_user_id = ?',
            [fbUserId]
        );
        
        if (rows.length > 0) {
            const row = rows[0];
            const remaining = Math.max(0, row.messages_limit - row.messages_used);
            
            // Log activity
            await pool.query(
                'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, "send", ?)',
                [fbUserId, `Sent: ${count} | Remaining: ${remaining}`]
            ).catch(() => {}); // non-critical

            return {
                success: true,
                messagesUsed: row.messages_used,
                messageLimit: row.messages_limit,
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

    await pool.query('DELETE FROM messages WHERE created_time < ?', [cutoff]);
    await pool.query('DELETE FROM conversations WHERE updated_time < ?', [cutoff]);
}

const dbModule = {
    initDatabase,
    isConnected,
    savePage,
    savePages,
    getPages,
    getPageToken,
    saveConversation,
    saveConversations,
    getConversations,
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
    onIncomingMessage
};

// ── ensureConversation — INSERT IGNORE then SELECT (race-safe) ────────────────
async function ensureConversation(pageId, participantId) {
    if (!pool) return null;
    try {
        const convId = `${pageId}_${participantId}`;
        await pool.query(`
            INSERT IGNORE INTO conversations (id, page_id, participant_id, participant_name, snippet, updated_time, is_read, unread_count)
            VALUES (?, ?, ?, 'User', '', NOW(), 1, 0)
        `, [convId, pageId, participantId]);
        const [rows] = await pool.query('SELECT id FROM conversations WHERE page_id = ? AND participant_id = ?', [pageId, participantId]);
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
            UPDATE conversations
            SET snippet = ?, updated_time = NOW(), is_read = 0,
                unread_count = unread_count + 1, last_message_from_page = 0
            WHERE id = ?
        `, [(text || '').substring(0, 200), threadId]);
    } catch (err) {
        addDbError(`onIncomingMessage: ${err.message}`);
    }
}

// Getter so server.js can access db.pool after initDatabase() assigns it
Object.defineProperty(dbModule, 'pool', { get: () => pool, enumerable: true });

module.exports = dbModule;
