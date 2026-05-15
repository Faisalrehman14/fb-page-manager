<?php
declare(strict_types=1);

/**
 * Database singleton + idempotent schema migrations.
 * Migrations run once per PHP-FPM worker process via a static flag.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 * messenger_pages         – Multi-tenant: one row per Facebook Page
 * messenger_conversations – Denormalized inbox row (last_message stored here,
 *                           zero-join inbox load)
 * messenger_messages      – Full message history with JSON metadata column
 *                           (reactions, stickers, replies, future FB features)
 *                           + is_archived flag for hot/cold tiering
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

        // ── 1. Pages table — one row per Facebook Page ────────────────────────
        // Stores the long-lived page access token so the backend can re-send
        // messages without requiring the token in every request.
        $db->exec("CREATE TABLE IF NOT EXISTS messenger_pages (
            id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            fb_page_id   VARCHAR(64)  NOT NULL,
            access_token TEXT         NOT NULL,
            name         VARCHAR(255) DEFAULT NULL,
            avatar_url   TEXT         DEFAULT NULL,
            is_active    TINYINT(1)   NOT NULL DEFAULT 1,
            created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME     DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_fb_page_id (fb_page_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        // ── 2. Conversations table ────────────────────────────────────────────
        // Denormalization: snippet + last_from_me + updated_at are kept in sync
        // by the service layer so inbox load = ONE indexed table scan, no JOIN.
        $db->exec("CREATE TABLE IF NOT EXISTS messenger_conversations (
            id            INT UNSIGNED      AUTO_INCREMENT PRIMARY KEY,
            page_id       VARCHAR(64)       NOT NULL,
            fb_user_id    VARCHAR(64)       NOT NULL,
            fb_conv_id    VARCHAR(128)      DEFAULT NULL,
            user_name     VARCHAR(255)      NOT NULL DEFAULT 'User',
            user_picture  TEXT              DEFAULT NULL,
            snippet       TEXT              DEFAULT NULL,
            last_from_me  TINYINT(1)        DEFAULT NULL,
            is_unread     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            updated_at    DATETIME          DEFAULT NULL,
            created_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,

            -- Isolation: (page_id, fb_user_id) is the natural PK
            UNIQUE KEY uq_page_user (page_id, fb_user_id),

            -- Covering index for inbox load — page → recency
            KEY idx_inbox (page_id, updated_at DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        // ── 3. Messages table ─────────────────────────────────────────────────
        // Composite indexes follow the two main read patterns:
        //   a) Open a conversation  → WHERE conversation_id ORDER BY created_at
        //   b) Cross-conv user query → WHERE user_id + page_id ORDER BY created_at
        // metadata JSON: stores reactions, sticker_id, reply_to, story_mention,
        //   etc. so new Facebook features never require a schema migration.
        // is_archived: hot (0) / cold (1) flag — archiver cron moves rows older
        //   than 2 years; all queries default to is_archived = 0.
        $db->exec("CREATE TABLE IF NOT EXISTS messenger_messages (
            id              INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNSIGNED  NOT NULL,
            page_id         VARCHAR(64)   NOT NULL,
            user_id         VARCHAR(64)   DEFAULT NULL,
            message_id      VARCHAR(128)  DEFAULT NULL,
            message         TEXT          DEFAULT NULL,
            from_me         TINYINT(1)    NOT NULL DEFAULT 0,
            attachment_url  TEXT          DEFAULT NULL,
            attachment_type VARCHAR(100)  DEFAULT NULL,
            metadata        JSON          DEFAULT NULL,
            is_read         TINYINT(1)    NOT NULL DEFAULT 0,
            is_archived     TINYINT(1)    NOT NULL DEFAULT 0,
            delivered_at    DATETIME      DEFAULT NULL,
            created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

            -- Atomic dedup: INSERT IGNORE on duplicate message_id
            UNIQUE KEY uq_message_id (message_id),

            -- Pattern (a): load conversation messages newest→oldest
            KEY idx_conv_time (conversation_id, created_at DESC),

            -- Pattern (b): user activity across pages (search / analytics)
            KEY idx_user_page_time (user_id, page_id, created_at DESC),

            -- Page-level timeline (poll, unread sweep)
            KEY idx_page_time (page_id, created_at DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        // ── 4. Safe column additions for existing installs ────────────────────
        // Each ALTER fails silently if the column / key already exists.
        foreach ([
            // conversations
            "ALTER TABLE messenger_conversations ADD COLUMN last_from_me TINYINT(1) DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN fb_conv_id   VARCHAR(128) DEFAULT NULL",
            "ALTER TABLE messenger_conversations ADD COLUMN created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
            "ALTER TABLE messenger_conversations MODIFY COLUMN is_unread SMALLINT UNSIGNED NOT NULL DEFAULT 0",
            // messages
            "ALTER TABLE messenger_messages ADD COLUMN metadata        JSON DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN is_archived     TINYINT(1) NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN message_id      VARCHAR(128) DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN attachment_url  TEXT DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN attachment_type VARCHAR(100) DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN is_read         TINYINT(1) NOT NULL DEFAULT 0",
            "ALTER TABLE messenger_messages ADD COLUMN delivered_at    DATETIME DEFAULT NULL",
            "ALTER TABLE messenger_messages ADD COLUMN created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
            // indexes (ADD UNIQUE fails silently if exists)
            "ALTER TABLE messenger_messages ADD UNIQUE KEY uq_message_id (message_id)",
            "ALTER TABLE messenger_messages ADD KEY idx_user_page_time (user_id, page_id, created_at)",
        ] as $sql) {
            try { $db->exec($sql); } catch (Exception $e) {}
        }
    }
}
