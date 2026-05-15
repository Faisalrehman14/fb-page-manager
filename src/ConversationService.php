<?php
declare(strict_types=1);

/**
 * All database operations for messenger_conversations.
 * No HTTP calls, no business logic — pure data access.
 */
class ConversationService
{
    public function __construct(private readonly PDO $db) {}

    // ── Reads ────────────────────────────────────────────────────────────────

    public function list(string $pageId): array
    {
        // Correlated subquery kept intentionally simple — 200 rows max, indexed on conversation_id+created_at
        $stmt = $this->db->prepare("
            SELECT c.*,
                   m.message    AS last_msg,
                   m.from_me    AS last_from_me,
                   m.created_at AS last_msg_at
            FROM messenger_conversations c
            LEFT JOIN messenger_messages m ON m.id = (
                SELECT id FROM messenger_messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC LIMIT 1
            )
            WHERE c.page_id = ?
            ORDER BY COALESCE(c.updated_at, c.created_at) DESC
            LIMIT 200
        ");
        $stmt->execute([$pageId]);
        return $stmt->fetchAll();
    }

    public function findByPsid(string $pageId, string $psid): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?"
        );
        $stmt->execute([$pageId, $psid]);
        return $stmt->fetch() ?: null;
    }

    public function updatedSince(string $pageId, string $since): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM messenger_conversations WHERE page_id = ? AND updated_at > ? ORDER BY updated_at DESC"
        );
        $stmt->execute([$pageId, $since]);
        return $stmt->fetchAll();
    }

    public function totalUnread(string $pageId): int
    {
        $stmt = $this->db->prepare(
            "SELECT COALESCE(SUM(is_unread), 0) FROM messenger_conversations WHERE page_id = ?"
        );
        $stmt->execute([$pageId]);
        return (int) $stmt->fetchColumn();
    }

    public function search(string $pageId, string $q): array
    {
        $like = '%' . $q . '%';
        $stmt = $this->db->prepare("
            SELECT c.*,
                   m.message    AS last_msg,
                   m.created_at AS last_msg_at
            FROM messenger_conversations c
            LEFT JOIN messenger_messages m ON m.id = (
                SELECT id FROM messenger_messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC LIMIT 1
            )
            WHERE c.page_id = ? AND (c.user_name LIKE ? OR c.snippet LIKE ?)
            ORDER BY COALESCE(c.updated_at, c.created_at) DESC
            LIMIT 50
        ");
        $stmt->execute([$pageId, $like, $like]);
        return $stmt->fetchAll();
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Insert or update a conversation row.
     * Never overwrites a real name with 'User', never clears snippet with empty string.
     */
    public function upsert(
        string  $pageId,
        string  $psid,
        ?string $fbConvId,
        string  $userName,
        string  $snippet,
        ?string $updatedAt
    ): void {
        $this->db->prepare("
            INSERT INTO messenger_conversations
                (page_id, fb_user_id, fb_conv_id, user_name, snippet, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                fb_conv_id = COALESCE(VALUES(fb_conv_id), fb_conv_id),
                snippet    = IF(VALUES(snippet) != '', VALUES(snippet), snippet),
                updated_at = GREATEST(
                    COALESCE(updated_at,        '2000-01-01 00:00:00'),
                    COALESCE(VALUES(updated_at), '2000-01-01 00:00:00')
                ),
                user_name  = IF(
                    VALUES(user_name) != '' AND VALUES(user_name) != 'User',
                    VALUES(user_name),
                    user_name
                )
        ")->execute([$pageId, $psid, $fbConvId ?: null, $userName ?: 'User', $snippet, $updatedAt]);
    }

    /**
     * Returns conversation id, creating the row if it doesn't exist.
     * Used before saving a message to guarantee the foreign key.
     */
    public function ensureExists(string $pageId, string $psid): int
    {
        $conv = $this->findByPsid($pageId, $psid);
        if ($conv) return (int) $conv['id'];

        $this->db->prepare(
            "INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at)
             VALUES (?, ?, 'User', '', NOW())"
        )->execute([$pageId, $psid]);

        return (int) $this->db->lastInsertId();
    }

    public function markRead(string $pageId, string $psid): void
    {
        $this->db->prepare(
            "UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND fb_user_id = ?"
        )->execute([$pageId, $psid]);
    }

    /**
     * Called when a customer message arrives via webhook.
     * Increments unread counter and updates snippet + timestamp in one query.
     */
    public function onIncomingMessage(string $pageId, string $psid, string $snippet): void
    {
        $this->db->prepare("
            UPDATE messenger_conversations
            SET is_unread  = is_unread + 1,
                snippet    = IF(? != '', ?, snippet),
                updated_at = NOW()
            WHERE page_id = ? AND fb_user_id = ?
        ")->execute([$snippet, $snippet, $pageId, $psid]);
    }

    /**
     * Called when WE send a message — updates snippet but does NOT touch is_unread.
     */
    public function onOutgoingMessage(string $pageId, string $psid, string $snippet): void
    {
        $this->db->prepare("
            UPDATE messenger_conversations
            SET snippet    = IF(? != '', ?, snippet),
                updated_at = NOW()
            WHERE page_id = ? AND fb_user_id = ?
        ")->execute([$snippet, $snippet, $pageId, $psid]);
    }

    public function updateProfile(string $pageId, string $psid, string $name, ?string $picture): void
    {
        $this->db->prepare(
            "UPDATE messenger_conversations SET user_name = ?, user_picture = ? WHERE page_id = ? AND fb_user_id = ?"
        )->execute([$name, $picture, $pageId, $psid]);
    }
}
