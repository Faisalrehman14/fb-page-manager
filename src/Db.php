<?php
declare(strict_types=1);

/**
 * Database singleton + idempotent schema migrations.
 * Migrations run once per PHP-FPM worker process using a static flag.
 */
class Db
{
    private static ?PDO $pdo = null;

    public static function get(): PDO
    {
        if (self::$pdo === null) {
            self::$pdo = getDB(); // from db_config.php
        }
        return self::$pdo;
    }

    public static function migrate(): void
    {
        static $done = false;
        if ($done) return;
        $done = true;

        $db = self::get();

        $db->exec("CREATE TABLE IF NOT EXISTS messenger_conversations (
            id           INT UNSIGNED      AUTO_INCREMENT PRIMARY KEY,
            page_id      VARCHAR(64)       NOT NULL,
            fb_user_id   VARCHAR(64)       NOT NULL,
            fb_conv_id   VARCHAR(128)      DEFAULT NULL,
            user_name    VARCHAR(255)      NOT NULL DEFAULT 'User',
            user_picture TEXT              DEFAULT NULL,
            snippet      TEXT              DEFAULT NULL,
            is_unread    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            updated_at   DATETIME          DEFAULT NULL,
            created_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_page_user  (page_id, fb_user_id),
            KEY          idx_updated  (page_id, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $db->exec("CREATE TABLE IF NOT EXISTS messenger_messages (
            id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNSIGNED  NOT NULL,
            page_id         VARCHAR(64)   NOT NULL,
            user_id         VARCHAR(64)   DEFAULT NULL,
            message_id      VARCHAR(128)  DEFAULT NULL,
            message         TEXT          DEFAULT NULL,
            from_me         TINYINT(1)    NOT NULL DEFAULT 0,
            attachment_url  TEXT          DEFAULT NULL,
            attachment_type VARCHAR(100)  DEFAULT NULL,
            is_read         TINYINT(1)    NOT NULL DEFAULT 0,
            delivered_at    DATETIME      DEFAULT NULL,
            created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_message_id (message_id),
            KEY idx_conv_time (conversation_id, created_at),
            KEY idx_page_time (page_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        // Safe column additions — fail silently if column already exists
        foreach ([
            "ALTER TABLE messenger_conversations ADD COLUMN fb_conv_id   VARCHAR(128) DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE messenger_conversations MODIFY COLUMN is_unread SMALLINT UNSIGNED NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN message_id      VARCHAR(128) DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN attachment_url  TEXT DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN attachment_type VARCHAR(100) DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN is_read         TINYINT(1) NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN delivered_at    DATETIME DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE messenger_messages ADD UNIQUE KEY uq_message_id (message_id)",
        ] as $sql) {
            try { $db->exec($sql); } catch (Exception $e) {}
        }
    }
}
