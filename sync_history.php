<?php
/**
 * sync_history.php — Sync conversation list from Facebook (names + metadata only).
 * Messages are stored via webhook in real-time — NOT bulk-imported here.
 *
 * POST: { page_id, page_token }
 * Returns: { success, synced }
 */

set_time_limit(60);
ignore_user_abort(true);

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit(json_encode(['error' => 'Method not allowed']));
}

$body      = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
$pageId    = trim($body['page_id']    ?? '');
$pageToken = trim($body['page_token'] ?? '');

if (!$pageId || !$pageToken) {
    http_response_code(400);
    exit(json_encode(['error' => 'Missing page_id or page_token']));
}

try {
    $db = getDB();
} catch (Exception $e) {
    http_response_code(503);
    exit(json_encode(['error' => 'Database unavailable']));
}

ensureTables($db);

$synced = 0;
$since  = time() - (30 * 24 * 3600); // last 30 days

// ── Fetch conversation list (names + metadata, NO messages) ─────────────────

$url      = buildUrl($pageId, $pageToken, $since);
$pages    = 0;
$psids    = []; // collect PSIDs to fetch profile pics

do {
    $data = fbGet($url);
    if (isset($data['error']) || empty($data['data'])) break;

    foreach ($data['data'] as $conv) {
        $fbConvId  = $conv['id'] ?? '';
        $snippet   = $conv['snippet'] ?? '';
        $updatedAt = !empty($conv['updated_time'])
            ? date('Y-m-d H:i:s', strtotime($conv['updated_time']))
            : null;

        // Find the customer (non-page participant)
        $customer = null;
        foreach ($conv['participants']['data'] ?? [] as $p) {
            if ($p['id'] !== $pageId) { $customer = $p; break; }
        }
        if (!$customer) continue;

        $psid     = $customer['id'];
        $userName = $customer['name'] ?? 'User';

        upsertConversation($db, $pageId, $psid, $fbConvId, $userName, $snippet, $updatedAt);
        $psids[] = $psid;
        $synced++;
    }

    $url = $data['paging']['next'] ?? null;
    $pages++;
} while ($url && $pages < 5); // max 250 conversations

// ── Fetch profile pictures for conversations missing them ───────────────────
fetchProfilePics($db, $pageId, $pageToken, array_unique($psids));

exit(json_encode(['success' => true, 'synced' => $synced]));

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

function buildUrl(string $pageId, string $token, int $since): string {
    return 'https://graph.facebook.com/' . FB_API_VER . '/' . $pageId . '/conversations?' .
        http_build_query([
            'fields'       => 'id,updated_time,participants,snippet',
            'limit'        => 50,
            'since'        => $since,
            'access_token' => $token,
        ]);
}

function fbGet(string $url): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body ?: '{}', true) ?: [];
}

function upsertConversation(PDO $db, string $pageId, string $psid, string $fbConvId,
                             string $userName, string $snippet, ?string $updatedAt): void {
    $db->prepare("
        INSERT INTO messenger_conversations
            (page_id, fb_user_id, fb_conv_id, user_name, snippet, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            fb_conv_id = VALUES(fb_conv_id),
            snippet    = IF(VALUES(snippet) != '', VALUES(snippet), snippet),
            updated_at = GREATEST(
                COALESCE(updated_at, '2000-01-01 00:00:00'),
                COALESCE(VALUES(updated_at), '2000-01-01 00:00:00')
            ),
            user_name  = IF(
                VALUES(user_name) != '' AND VALUES(user_name) != 'User',
                VALUES(user_name), user_name
            )
    ")->execute([$pageId, $psid, $fbConvId, $userName ?: 'User', $snippet, $updatedAt]);
}

function fetchProfilePics(PDO $db, string $pageId, string $token, array $psids): void {
    // Only update conversations that don't have a picture yet
    $stmt = $db->prepare("
        SELECT fb_user_id FROM messenger_conversations
        WHERE page_id = ? AND fb_user_id IN (" . implode(',', array_fill(0, count($psids), '?')) . ")
        AND (user_picture IS NULL OR user_picture = '')
    ");
    if (!$psids) return;
    $stmt->execute(array_merge([$pageId], $psids));
    $missing = $stmt->fetchAll(PDO::FETCH_COLUMN);

    foreach ($missing as $psid) {
        try {
            $ch = curl_init('https://graph.facebook.com/' . FB_API_VER . '/' . $psid . '?' .
                http_build_query(['fields' => 'name,profile_pic', 'access_token' => $token]));
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_SSL_VERIFYPEER => true]);
            $info = json_decode(curl_exec($ch) ?: '{}', true);
            curl_close($ch);

            if (!empty($info['name'])) {
                $db->prepare("UPDATE messenger_conversations SET user_name=?, user_picture=? WHERE page_id=? AND fb_user_id=?")
                   ->execute([$info['name'], $info['profile_pic'] ?? null, $pageId, $psid]);
            }
        } catch (Exception $e) {}
    }
}

function ensureTables(PDO $db): void {
    $db->exec("CREATE TABLE IF NOT EXISTS messenger_conversations (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id      VARCHAR(64)  NOT NULL,
        fb_user_id   VARCHAR(64)  NOT NULL,
        fb_conv_id   VARCHAR(128) DEFAULT NULL,
        user_name    VARCHAR(255) DEFAULT 'User',
        user_picture TEXT         DEFAULT NULL,
        snippet      TEXT         DEFAULT NULL,
        is_unread    TINYINT(1)   NOT NULL DEFAULT 0,
        updated_at   DATETIME     DEFAULT NULL,
        UNIQUE KEY uq_page_user (page_id, fb_user_id),
        KEY idx_page_updated (page_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $db->exec("CREATE TABLE IF NOT EXISTS messenger_messages (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        conversation_id INT UNSIGNED NOT NULL,
        page_id         VARCHAR(64)  NOT NULL,
        user_id         VARCHAR(64)  DEFAULT NULL,
        message_id      VARCHAR(128) DEFAULT NULL,
        message         TEXT         DEFAULT NULL,
        from_me         TINYINT(1)   NOT NULL DEFAULT 0,
        attachment_url  TEXT         DEFAULT NULL,
        attachment_type VARCHAR(100) DEFAULT NULL,
        created_at      DATETIME     DEFAULT NULL,
        KEY idx_conv_time (conversation_id, created_at),
        KEY idx_page_time (page_id, created_at),
        KEY idx_msg_id (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    foreach ([
        "ALTER TABLE messenger_conversations ADD COLUMN fb_conv_id VARCHAR(128) DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN message_id VARCHAR(128) DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN attachment_url TEXT DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN attachment_type VARCHAR(100) DEFAULT NULL",
    ] as $sql) {
        try { $db->exec($sql); } catch (Exception $e) {}
    }
}
