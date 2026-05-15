<?php
declare(strict_types=1);

/**
 * All database operations for messenger_messages.
 * No HTTP calls — pure data access.
 */
class MessageService
{
    public function __construct(private readonly PDO $db) {}

    // ── Reads ────────────────────────────────────────────────────────────────

    public function list(int $convId, int $limit = 50, ?string $before = null): array
    {
        if ($before) {
            $stmt = $this->db->prepare(
                "SELECT * FROM messenger_messages
                 WHERE conversation_id = ? AND created_at < ?
                 ORDER BY created_at DESC LIMIT ?"
            );
            $stmt->execute([$convId, $before, $limit]);
        } else {
            $stmt = $this->db->prepare(
                "SELECT * FROM messenger_messages
                 WHERE conversation_id = ?
                 ORDER BY created_at DESC LIMIT ?"
            );
            $stmt->execute([$convId, $limit]);
        }
        return array_reverse($stmt->fetchAll());
    }

    public function newSince(int $convId, string $since): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM messenger_messages
             WHERE conversation_id = ? AND created_at > ?
             ORDER BY created_at ASC"
        );
        $stmt->execute([$convId, $since]);
        return $stmt->fetchAll();
    }

    public function search(string $pageId, string $q): array
    {
        $like = '%' . $q . '%';
        $stmt = $this->db->prepare("
            SELECT m.*, c.user_name, c.user_picture, c.fb_user_id AS psid
            FROM messenger_messages m
            JOIN messenger_conversations c ON m.conversation_id = c.id
            WHERE m.page_id = ? AND m.message LIKE ?
            ORDER BY m.created_at DESC
            LIMIT 50
        ");
        $stmt->execute([$pageId, $like]);
        return $stmt->fetchAll();
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Inserts a message row. Returns true on success, false if duplicate (webhook retry).
     * The UNIQUE KEY on message_id makes deduplication atomic — no SELECT before INSERT race.
     */
    public function save(
        int     $convId,
        string  $pageId,
        string  $psid,
        ?string $messageId,
        ?string $text,
        bool    $fromMe,
        ?string $attachmentUrl,
        ?string $attachmentType,
        string  $createdAt
    ): bool {
        try {
            $this->db->prepare("
                INSERT INTO messenger_messages
                    (conversation_id, page_id, user_id, message_id, message,
                     from_me, attachment_url, attachment_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ")->execute([
                $convId, $pageId, $psid,
                $messageId ?: null,   // null avoids UNIQUE KEY conflicts on empty string
                $text,
                $fromMe ? 1 : 0,
                $attachmentUrl,
                $attachmentType,
                $createdAt,
            ]);
            return true;
        } catch (Exception $e) {
            // Duplicate message_id = webhook retry. Silently ignore.
            return false;
        }
    }

    public function markDelivered(string $messageId): void
    {
        $this->db->prepare(
            "UPDATE messenger_messages SET delivered_at = NOW() WHERE message_id = ?"
        )->execute([$messageId]);
    }

    public function markRead(string $pageId, string $psid): void
    {
        // Only mark customer-sent messages as read (from_me = 0)
        $this->db->prepare(
            "UPDATE messenger_messages
             SET is_read = 1
             WHERE page_id = ? AND user_id = ? AND from_me = 0 AND is_read = 0"
        )->execute([$pageId, $psid]);
    }
}
