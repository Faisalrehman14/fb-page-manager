const mysql = require('mysql2/promise');
require('dotenv').config({ path: '../.env' });

async function audit() {
    const pool = mysql.createPool({
        host: process.env.MYSQLHOST,
        user: process.env.MYSQLUSER,
        password: process.env.MYSQLPASSWORD,
        database: process.env.MYSQLDATABASE
    });

    try {
        console.log('--- DATABASE AUDIT ---');
        const [tables] = await pool.execute('SHOW TABLES');
        console.log('Tables:', tables.map(t => Object.values(t)[0]));

        const [convs] = await pool.execute('DESCRIBE conversations');
        console.log('\nConversations Schema:');
        console.table(convs);

        const [msgs] = await pool.execute('DESCRIBE messages');
        console.log('\nMessages Schema:');
        console.table(msgs);

        // Check for missing indexes
        const [indexes] = await pool.execute('SHOW INDEX FROM messages');
        const indexedCols = indexes.map(i => i.Column_name);
        if (!indexedCols.includes('user_id')) console.warn('!!! MISSING INDEX: messages.user_id');
        if (!indexedCols.includes('page_id')) console.warn('!!! MISSING INDEX: messages.page_id');

        process.exit(0);
    } catch (err) {
        console.error('Audit Failed:', err);
        process.exit(1);
    }
}
audit();
