<?php
declare(strict_types=1);

/**
 * All database operations for messenger_messages.
 *
 * Hot / Cold storage contract:
 *   is_archived = 0  →  hot  (all normal reads)
 *   is_archived = 1  →  cold (archiver cron sets this for rows older than 2 years)
 *
 * The archive() method can be called by a nightly cron to keep the active
 * dataset small and fast, without ever deleting data.
 */
class MessageService
{
    public function __construct(private readonly PDO $db) {}

    // ── Reads ─────────────────────────────────────────────────────────────────

    /**
     * Load messages for a conversation — hot rows only, newest first then reversed.
     * Hits idx_conv_time (conversation_id, created_at DESC) directly.
     */
    public function list(int $convId, int $limit = 50, ?string $before = null): array
    {
        if ($before) {
            $stmt = $this->db->prepare("
                SELECT * FROM messenger_messages
                WHERE conversation_id = ? AND created_at < ? AND is_archived = 0
                ORDER BY created_at DESC LIMIT ?
            ");
            $stmt->execute([$convId, $before, $limit]);
        } else {
            $stmt = $this->db->prepare("
                SELECT * FROM messenger_messages
                WHERE conversation_id = ? AND is_archived = 0
                ORDER BY created_at DESC LIMIT ?
            ");
            $stmt->execute([$convId, $limit]);
        }
        return array_reverse($stmt->fetchAll());
    }

    public function newSince(int $convId, string $since): array
    {
        $stmt = $this->db->prepare("
            SELECT * FROM messenger_messages
            WHERE conversation_id = ? AND created_at > ? AND is_archived = 0
            ORDER BY created_at ASC
        ");
        $stmt->execute([$convId, $since]);
        return $stmt->fetchAll();
    }

    /**
     * Full-text search across a page's messages.
     * Hits idx_page_time (page_id, created_at DESC).
     */
    public function search(string $pageId, string $q): array
    {
        $like = '%' . $q . '%';
        $stmt = $this->db->prepare("
            SELECT m.*, c.user_name, c.user_picture, c.fb_user_id AS psid
            FROM messenger_messages m
            JOIN messenger_conversations c ON m.conversation_id = c.id
            WHERE m.page_id = ? AND m.message LIKE ? AND m.is_archived = 0
            ORDER BY m.created_at DESC
            LIMIT 50
        ");
        $stmt->execute([$pageId, $like]);
        return $stmt->fetchAll();
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    /**
     * Insert a message. Returns true on success, false on duplicate (webhook retry).
     * Dedup is atomic — the UNIQUE KEY on message_id means no SELECT+INSERT race.
     *
     * @param array|null $metadata  Arbitrary JSON payload (reactions, reply_to,
     *                              sticker_id, story_mention, etc.)
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
        string  $createdAt,
        ?array  $metadata = null
    ): bool {
        try {
            $this->db->prepare("
                INSERT INTO messenger_messages
                    (conversation_id, page_id, user_id, message_id, message,
                     from_me, attachment_url, attachment_type, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ")->execute([
                $convId, $pageId, $psid,
                $messageId ?: null,
                $text,
                $fromMe ? 1 : 0,
                $attachmentUrl,
                $attachmentType,
                $metadata ? json_encode($metadata, JSON_UNESCAPED_UNICODE) : null,
                $createdAt,
            ]);
            return true;
        } catch (Exception) {
            return false; // duplicate message_id = webhook retry
        }
    }

    public function markDelivered(string $messageId): void
    {
        $this->db->prepare(
            "UPDATE messenger_messages SET delivered_at = NOW() WHERE message_id = ?"
        )->execute([$messageId]);
    }

    /**
     * Mark customer messages as read. Only touches from_me = 0 rows.
     * Hits idx_user_page_time (user_id, page_id, created_at DESC).
     */
    public function markRead(string $pageId, string $psid): void
    {
        $this->db->prepare(
            "UPDATE messenger_messages
             SET is_read = 1
             WHERE page_id = ? AND user_id = ? AND from_me = 0 AND is_read = 0"
        )->execute([$pageId, $psid]);
    }

    // ── Hot / Cold tiering ────────────────────────────────────────────────────

    /**
     * Move old messages to cold storage by setting is_archived = 1.
     * Call this from a nightly cron; it keeps the hot dataset lean without
     * deleting anything.
     *
     * Example cron (daily at 3 am):
     *   0 3 * * * php /var/www/html/artisan messenger:archive
     */
    public function archive(int $daysOld = 730, int $batchSize = 5000): int
    {
        $cutoff = date('Y-m-d H:i:s', strtotime("-{$daysOld} days"));
        $stmt   = $this->db->prepare("
            UPDATE messenger_messages
            SET is_archived = 1
            WHERE created_at < ? AND is_archived = 0
            LIMIT ?
        ");
        $stmt->execute([$cutoff, $batchSize]);
        return $stmt->rowCount();
    }
}
