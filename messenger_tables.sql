-- ═══════════════════════════════════════════════════════════════
-- FBCast Pro - Messenger Tables Update
-- Run this SQL in phpMyAdmin or MySQL CLI to add messenger tables
-- ═══════════════════════════════════════════════════════════════

-- Table: messenger_conversations
CREATE TABLE IF NOT EXISTS `messenger_conversations` (
  `id`               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `fb_user_id`       VARCHAR(50)  NOT NULL,
  `fb_page_id`       VARCHAR(50)  NOT NULL,
  `psid`             VARCHAR(50)  NOT NULL,
  `user_name`        VARCHAR(255) NOT NULL DEFAULT '',
  `user_picture`     VARCHAR(500) NULL DEFAULT NULL,
  `user_locale`      VARCHAR(10)  NULL DEFAULT NULL,
  `last_message`     TEXT NULL,
  `last_message_at`  DATETIME     NULL DEFAULT NULL,
  `unread_count`     INT UNSIGNED NOT NULL DEFAULT 0,
  `is_blocked`       TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_psid_page` (`psid`, `fb_page_id`),
  INDEX `idx_page` (`fb_page_id`),
  INDEX `idx_user` (`fb_user_id`),
  INDEX `idx_updated` (`updated_at`),
  INDEX `idx_unread` (`is_blocked`, `unread_count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: messenger_messages
CREATE TABLE IF NOT EXISTS `messenger_messages` (
  `id`               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `conversation_id`  BIGINT UNSIGNED NOT NULL,
  `fb_page_id`       VARCHAR(50)  NOT NULL,
  `psid`             VARCHAR(50)  NOT NULL,
  `message_id`       VARCHAR(255) NULL DEFAULT NULL,
  `message_type`     ENUM('text','image','audio','video','file','location','fallback','quick_reply') NOT NULL DEFAULT 'text',
  `content`          TEXT NULL,
  `is_from_user`     TINYINT(1)   NOT NULL DEFAULT 1,
  `is_read`          TINYINT(1)   NOT NULL DEFAULT 0,
  `has_attachment`   TINYINT(1)   NOT NULL DEFAULT 0,
  `attachment_url`   VARCHAR(500) NULL DEFAULT NULL,
  `attachment_type`  VARCHAR(20)  NULL DEFAULT NULL,
  `sent_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at`     DATETIME NULL DEFAULT NULL,
  `read_at`          DATETIME NULL DEFAULT NULL,
  INDEX `idx_conv` (`conversation_id`),
  INDEX `idx_page` (`fb_page_id`),
  INDEX `idx_psid` (`psid`),
  INDEX `idx_sent` (`sent_at`),
  INDEX `idx_unread` (`is_from_user`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;