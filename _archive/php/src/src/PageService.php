<?php
declare(strict_types=1);

/**
 * CRUD for messenger_pages — the multi-tenant registry.
 *
 * Every Facebook Page that connects to this system gets one row here.
 * The stored access_token lets the backend send messages without the
 * frontend having to pass it in every request.
 */
class PageService
{
    public function __construct(private readonly PDO $db) {}

    // ── Reads ─────────────────────────────────────────────────────────────────

    public function findById(string $fbPageId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM messenger_pages WHERE fb_page_id = ? AND is_active = 1"
        );
        $stmt->execute([$fbPageId]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Look up the stored access token for a page.
     * Returns null if the page is unknown — caller must fall back to the
     * token supplied in the request body.
     */
    public function findToken(string $fbPageId): ?string
    {
        $row = $this->findById($fbPageId);
        return $row ? $row['access_token'] : null;
    }

    public function listActive(): array
    {
        $stmt = $this->db->query(
            "SELECT * FROM messenger_pages WHERE is_active = 1 ORDER BY name"
        );
        return $stmt->fetchAll();
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    /**
     * Register or refresh a page. Call this when a user connects their page
     * (OAuth callback or manual token entry).
     */
    public function upsert(string $fbPageId, string $token, string $name = '', ?string $avatarUrl = null): void
    {
        $this->db->prepare("
            INSERT INTO messenger_pages (fb_page_id, access_token, name, avatar_url)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                access_token = VALUES(access_token),
                name         = IF(VALUES(name) != '', VALUES(name), name),
                avatar_url   = COALESCE(VALUES(avatar_url), avatar_url),
                is_active    = 1,
                updated_at   = NOW()
        ")->execute([$fbPageId, $token, $name, $avatarUrl]);
    }

    public function deactivate(string $fbPageId): void
    {
        $this->db->prepare(
            "UPDATE messenger_pages SET is_active = 0 WHERE fb_page_id = ?"
        )->execute([$fbPageId]);
    }
}
