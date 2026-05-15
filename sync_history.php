<?php
/**
 * sync_history.php — Bulk-sync last 30 days of Facebook conversations & messages to DB.
 * Called automatically after user connects a Facebook page.
 *
 * POST body: { page_id: string, page_token: string }
 * Response:  { success: bool, conversations_synced: int, messages_synced: int }
 */

set_time_limit(120);
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

$since         = time() - (30 * 24 * 3600); // 30 days ago
$convsSynced   = 0;
$msgsSynced    = 0;
$errors        = [];

// ── 1. Fetch all conversations ──────────────────────────────────────────────

$nextUrl   = buildConvUrl($pageId, $pageToken, $since);
$pageCount = 0;

do {
    $data = fbGet($nextUrl);

    if (isset($data['error'])) {
        $errors[] = 'Conversations: ' . ($data['error']['message'] ?? 'Unknown error');
        break;
    }

    $convItems = $data['data'] ?? [];
    if (empty($convItems)) break;

    foreach ($convItems as $conv) {
        $fbConvId  = $conv['id'] ?? '';
        $snippet   = $conv['snippet'] ?? '';
        $updatedAt = !empty($conv['updated_time'])
            ? date('Y-m-d H:i:s', strtotime($conv['updated_time']))
            : null;

        // Find the customer (the non-page participant)
        $participants = $conv['participants']['data'] ?? [];
        $customer = null;
        foreach ($participants as $p) {
            if ($p['id'] !== $pageId) { $customer = $p; break; }
        }
        if (!$customer) continue;

        $psid     = $customer['id'];
        $userName = $customer['name'] ?? 'User';

        // Upsert conversation
        $convDbId = upsertConversation($db, $pageId, $psid, $fbConvId, $userName, $snippet, $updatedAt);
        $convsSynced++;

        // Fetch messages for this conversation (up to 300 per conv)
        $msgs = fetchMessages($fbConvId, $pageToken, $pageId);
        foreach ($msgs as $m) {
            if (saveMessage($db, $convDbId, $pageId, $psid, $m)) {
                $msgsSynced++;
            }
        }
    }

    $nextUrl = $data['paging']['next'] ?? null;
    $pageCount++;

} while ($nextUrl && $pageCount < 5); // Max 5 pages = 250 conversations

// ── 2. Fetch user names & profile pics (up to 50) ─────────────────────────

fetchAndUpdateUserInfo($db, $pageId, $pageToken);

// ── 3. Respond ─────────────────────────────────────────────────────────────

exit(json_encode([
    'success'              => true,
    'conversations_synced' => $convsSynced,
    'messages_synced'      => $msgsSynced,
    'errors'               => $errors,
]));

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function buildConvUrl(string $pageId, string $token, int $since): string {
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
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body ?: '{}', true) ?: [];
}

function fetchMessages(string $fbConvId, string $token, string $pageId): array {
    $msgs    = [];
    $url     = 'https://graph.facebook.com/' . FB_API_VER . '/' . $fbConvId . '/messages?' .
        http_build_query([
            'fields'       => 'id,message,from,created_time,attachments{image_data,file_url,mime_type}',
            'limit'        => 100,
            'access_token' => $token,
        ]);
    $pages   = 0;
    $maxPages = 3; // Max 300 messages per conversation

    do {
        $data = fbGet($url);
        if (isset($data['error']) || empty($data['data'])) break;

        foreach ($data['data'] as $m) {
            $fromId  = $m['from']['id'] ?? '';
            $fromMe  = ($fromId === $pageId) ? 1 : 0;
            $att     = $m['attachments']['data'][0] ?? null;
            $attUrl  = $att['image_data']['url'] ?? $att['file_url'] ?? null;
            $attMime = $att['mime_type'] ?? null;
            $attType = $attMime ? (strpos($attMime, 'image') !== false ? 'image' : 'file') : null;
            $text    = $m['message'] ?? '';

            if ($text === '' && !$attUrl) continue;

            $msgs[] = [
                'message_id'     => $m['id'] ?? '',
                'message'        => $text,
                'from_me'        => $fromMe,
                'attachment_url' => $attUrl,
                'attachment_type'=> $attType,
                'created_at'     => !empty($m['created_time'])
                    ? date('Y-m-d H:i:s', strtotime($m['created_time']))
                    : date('Y-m-d H:i:s'),
            ];
        }

        $url = $data['paging']['next'] ?? null;
        $pages++;
    } while ($url && $pages < $maxPages);

    return $msgs;
}

function upsertConversation(PDO $db, string $pageId, string $psid, string $fbConvId,
                             string $userName, string $snippet, ?string $updatedAt): int {
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
                VALUES(user_name),
                user_name
            )
    ")->execute([$pageId, $psid, $fbConvId, $userName ?: 'User', $snippet, $updatedAt]);

    $stmt = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
    $stmt->execute([$pageId, $psid]);
    return (int)$stmt->fetchColumn();
}

function saveMessage(PDO $db, int $convId, string $pageId, string $psid, array $m): bool {
    // Dedup by Facebook message ID
    if ($m['message_id']) {
        $chk = $db->prepare("SELECT id FROM messenger_messages WHERE message_id = ? LIMIT 1");
        $chk->execute([$m['message_id']]);
        if ($chk->fetch()) return false;
    }

    $db->prepare("
        INSERT INTO messenger_messages
            (conversation_id, page_id, user_id, message_id, message, from_me,
             attachment_url, attachment_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ")->execute([
        $convId, $pageId, $psid,
        $m['message_id'], $m['message'], $m['from_me'],
        $m['attachment_url'], $m['attachment_type'],
        $m['created_at'],
    ]);
    return true;
}

function fetchAndUpdateUserInfo(PDO $db, string $pageId, string $token): void {
    // Fetch profile pics for conversations that don't have them yet
    $stmt = $db->prepare("
        SELECT fb_user_id FROM messenger_conversations
        WHERE page_id = ? AND (user_picture IS NULL OR user_picture = '')
        LIMIT 50
    ");
    $stmt->execute([$pageId]);
    $psids = $stmt->fetchAll(PDO::FETCH_COLUMN);

    foreach ($psids as $psid) {
        try {
            $ch = curl_init('https://graph.facebook.com/' . FB_API_VER . '/' . $psid . '?' . http_build_query([
                'fields'       => 'name,profile_pic',
                'access_token' => $token,
            ]));
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_SSL_VERIFYPEER => true]);
            $info = json_decode(curl_exec($ch) ?: '{}', true);
            curl_close($ch);

            if (!empty($info['name'])) {
                $db->prepare("
                    UPDATE messenger_conversations
                    SET user_name = ?, user_picture = ?
                    WHERE page_id = ? AND fb_user_id = ?
                ")->execute([$info['name'], $info['profile_pic'] ?? null, $pageId, $psid]);
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
        id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        conversation_id  INT UNSIGNED NOT NULL,
        page_id          VARCHAR(64)  NOT NULL,
        user_id          VARCHAR(64)  DEFAULT NULL,
        message_id       VARCHAR(128) DEFAULT NULL,
        message          TEXT         DEFAULT NULL,
        from_me          TINYINT(1)   NOT NULL DEFAULT 0,
        attachment_url   TEXT         DEFAULT NULL,
        attachment_type  VARCHAR(100) DEFAULT NULL,
        created_at       DATETIME     DEFAULT NULL,
        KEY idx_conv_time (conversation_id, created_at),
        KEY idx_page_time (page_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    // Migrate existing installs — add columns if missing
    $alterations = [
        "ALTER TABLE messenger_conversations ADD COLUMN fb_conv_id VARCHAR(128) DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN message_id VARCHAR(128) DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN attachment_url TEXT DEFAULT NULL",
        "ALTER TABLE messenger_messages ADD COLUMN attachment_type VARCHAR(100) DEFAULT NULL",
    ];
    foreach ($alterations as $sql) {
        try { $db->exec($sql); } catch (Exception $e) { /* column already exists */ }
    }

    // Add unique index on message_id to prevent duplicates
    try {
        $db->exec("ALTER TABLE messenger_messages ADD UNIQUE KEY uq_msg_id (message_id)");
    } catch (Exception $e) {}
}
