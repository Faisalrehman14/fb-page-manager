<?php
declare(strict_types=1);

/**
 * All database operations for messenger_conversations.
 *
 * Denormalization contract:
 *   snippet       — text of the last message (set on every send/receive)
 *   last_from_me  — 1 if WE sent it, 0 if customer sent it
 *   updated_at    — timestamp of the last message
 *
 * Because these three fields are kept in sync, inbox load is a single
 * indexed scan on messenger_conversations — no JOIN, no subquery.
 */
class ConversationService
{
    public function __construct(private readonly PDO $db) {}

    // ── Reads ─────────────────────────────────────────────────────────────────

    /**
     * Full inbox list for a page — one index scan, zero joins.
     * Returns at most 200 rows ordered by recency.
     */
    public function list(string $pageId): array
    {
        $stmt = $this->db->prepare("
            SELECT *,
                   snippet      AS last_msg,
                   last_from_me AS last_from_me,
                   updated_at   AS last_msg_at
            FROM messenger_conversations
            WHERE page_id = ?
            ORDER BY COALESCE(updated_at, created_at) DESC
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
            "SELECT *,
                    snippet      AS last_msg,
                    last_from_me AS last_from_me,
                    updated_at   AS last_msg_at
             FROM messenger_conversations
             WHERE page_id = ? AND updated_at > ?
             ORDER BY updated_at DESC"
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

    /**
     * Search by name or snippet — single indexed scan per page_id.
     */
    public function search(string $pageId, string $q): array
    {
        $like = '%' . $q . '%';
        $stmt = $this->db->prepare("
            SELECT *,
                   snippet      AS last_msg,
                   last_from_me AS last_from_me,
                   updated_at   AS last_msg_at
            FROM messenger_conversations
            WHERE page_id = ? AND (user_name LIKE ? OR snippet LIKE ?)
            ORDER BY COALESCE(updated_at, created_at) DESC
            LIMIT 50
        ");
        $stmt->execute([$pageId, $like, $like]);
        return $stmt->fetchAll();
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    /**
     * Insert or update a conversation row.
     * Rules: never overwrite a real name with 'User', never clear snippet with ''.
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
                    COALESCE(updated_at,         '2000-01-01 00:00:00'),
                    COALESCE(VALUES(updated_at),  '2000-01-01 00:00:00')
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
     *
     * We always INSERT IGNORE first, then SELECT — never the other way round.
     * Reason: two Facebook webhook requests can arrive simultaneously for the
     * same sender. If both do findByPsid → not found → INSERT, one INSERT is
     * silently ignored. The thread whose INSERT was ignored gets lastInsertId()=0,
     * then passes 0 as conversation_id to MessageService::save(), and the message
     * is stored with the wrong ID and is never returned by the poll query.
     *
     * INSERT IGNORE + SELECT is atomic-safe: the SELECT always finds the row
     * regardless of which thread won the INSERT race.
     */
    public function ensureExists(string $pageId, string $psid): int
    {
        $this->db->prepare(
            "INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at)
             VALUES (?, ?, 'User', '', NOW())"
        )->execute([$pageId, $psid]);

        $conv = $this->findByPsid($pageId, $psid);
        return $conv ? (int) $conv['id'] : 0;
    }

    public function markRead(string $pageId, string $psid): void
    {
        $this->db->prepare(
            "UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND fb_user_id = ?"
        )->execute([$pageId, $psid]);
    }

    /**
     * Customer message arrived — increment unread, store denormalized snippet.
     */
    public function onIncomingMessage(string $pageId, string $psid, string $snippet): void
    {
        $this->db->prepare("
            UPDATE messenger_conversations
            SET is_unread    = is_unread + 1,
                snippet      = IF(? != '', ?, snippet),
                last_from_me = 0,
                updated_at   = NOW()
            WHERE page_id = ? AND fb_user_id = ?
        ")->execute([$snippet, $snippet, $pageId, $psid]);
    }

    /**
     * We sent a message — update snippet but do NOT touch is_unread.
     */
    public function onOutgoingMessage(string $pageId, string $psid, string $snippet): void
    {
        $this->db->prepare("
            UPDATE messenger_conversations
            SET snippet      = IF(? != '', ?, snippet),
                last_from_me = 1,
                updated_at   = NOW()
            WHERE page_id = ? AND fb_user_id = ?
        ")->execute([$snippet, $snippet, $pageId, $psid]);
    }

    public function updateProfile(string $pageId, string $psid, string $name, ?string $picture): void
    {
        $this->db->prepare(
            "UPDATE messenger_conversations
             SET user_name = ?, user_picture = ?
             WHERE page_id = ? AND fb_user_id = ?"
        )->execute([$name, $picture, $pageId, $psid]);
    }
}
