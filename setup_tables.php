<?php
/**
 * setup_tables.php — Fix messenger tables
 * Run via: yoursite.com/setup_tables.php
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

try {
    $db = getDB();

    echo "<h2>Fixing messenger tables...</h2>";

    // Drop existing tables and recreate
    try {
        $db->exec("DROP TABLE IF EXISTS messenger_messages");
        $db->exec("DROP TABLE IF EXISTS messenger_conversations");
        echo "<p style='color:red'>Dropped old tables</p>";
    } catch (Exception $e) {
        echo "<p style='color:orange'>Drop: " . $e->getMessage() . "</p>";
    }

    // Create conversations table
    $db->exec("
        CREATE TABLE messenger_conversations (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          page_id VARCHAR(50) NOT NULL DEFAULT '',
          fb_user_id VARCHAR(50) NOT NULL DEFAULT '',
          user_name VARCHAR(255) DEFAULT '',
          user_picture VARCHAR(500) DEFAULT NULL,
          snippet TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_unread TINYINT(1) DEFAULT 0,
          UNIQUE KEY uk_page_user (page_id, fb_user_id),
          INDEX idx_page (page_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    echo "<p style='color:green'>Created messenger_conversations</p>";

    // Create messages table
    $db->exec("
        CREATE TABLE messenger_messages (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          conversation_id BIGINT UNSIGNED NOT NULL,
          page_id VARCHAR(50) NOT NULL DEFAULT '',
          user_id VARCHAR(50) NOT NULL DEFAULT '',
          message TEXT,
          from_me TINYINT(1) DEFAULT 0,
          attachment_type VARCHAR(20) DEFAULT NULL,
          attachment_url VARCHAR(500) DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_conv (conversation_id),
          INDEX idx_page (page_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    echo "<p style='color:green'>Created messenger_messages</p>";

    // Show final structure
    $msgCols = $db->query("DESCRIBE messenger_messages")->fetchAll(PDO::FETCH_COLUMN, 0);
    $convCols = $db->query("DESCRIBE messenger_conversations")->fetchAll(PDO::FETCH_COLUMN, 0);

    echo "<h3>Final columns:</h3>";
    echo "<p>conversations: " . implode(', ', $convCols) . "</p>";
    echo "<p>messages: " . implode(', ', $msgCols) . "</p>";

    echo "<h2 style='color:green'>Done! Tables recreated with AUTO_INCREMENT.</h2>";

} catch (Exception $e) {
    echo "<h2 style='color:red'>Error:</h2><pre>" . $e->getMessage() . "</pre>";
}