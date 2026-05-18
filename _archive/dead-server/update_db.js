/**
 * ═══════════════════════════════════════════════════════════
 *  FBCast Pro — DATABASE MIGRATION TOOL
 *  Use this script to safely update your database schema.
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: '../.env' });
const mysql = require('mysql2/promise');

async function migrate() {
    const connection = await mysql.createConnection({
        host: process.env.MYSQLHOST,
        user: process.env.MYSQLUSER,
        password: process.env.MYSQLPASSWORD,
        database: process.env.MYSQLDATABASE
    });

    console.log('[Migration] Connected to Database.');

    try {
        /**
         * EXAMPLE: Add a new column to 'conversations' table
         * Uncomment and modify the SQL below as needed.
         */
        
        /*
        console.log('[Migration] Adding "is_archived" column...');
        await connection.execute('ALTER TABLE conversations ADD COLUMN is_archived TINYINT(1) DEFAULT 0');
        */

        // EXAMPLE: Add index for performance
        console.log('[Migration] Ensuring high-performance indexes...');
        await connection.execute('CREATE INDEX IF NOT EXISTS idx_user_page ON messages (user_id, page_id)');
        await connection.execute('CREATE INDEX IF NOT EXISTS idx_last_msg ON conversations (page_id, last_message_at)');

        console.log('[Migration] SUCCESS: Database schema is up to date.');
    } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME') {
            console.log('[Migration] Note: Indexes already exist, skipping.');
        } else {
            console.error('[Migration] ERROR:', err.message);
        }
    } finally {
        await connection.end();
        process.exit(0);
    }
}

migrate();
