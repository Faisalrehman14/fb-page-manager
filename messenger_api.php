<?php
/**
 * messenger_api.php — Pro Messenger API
 * Endpoints: load_conversations, load_messages, send_message, poll, mark_read, save_conversations
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

function api_json(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fb_post(string $url, array $payload): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($err) return ['error' => ['message' => 'Network error: ' . $err]];
    return json_decode($body ?: '{}', true) ?: [];
}

function fb_get_api(string $endpoint, string $token, array $params = []): array {
    $params['access_token'] = $token;
    $url = 'https://graph.facebook.com/' . FB_API_VER . '/' . ltrim($endpoint, '/') . '?' . http_build_query($params);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body ?: '{}', true) ?: [];
}

try {
    $db = getDB();
} catch (Exception $e) {
    api_json(['error' => 'Database unavailable'], 503);
}

// Auto-create messenger tables if they don't exist
try {
    $db->exec("CREATE TABLE IF NOT EXISTS messenger_conversations (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        page_id       VARCHAR(64)  NOT NULL,
        fb_user_id    VARCHAR(64)  NOT NULL,
        user_name     VARCHAR(255) DEFAULT 'User',
        user_picture  TEXT         DEFAULT NULL,
        snippet       TEXT         DEFAULT NULL,
        is_unread     TINYINT(1)   NOT NULL DEFAULT 0,
        updated_at    DATETIME     DEFAULT NULL,
        UNIQUE KEY uq_page_user (page_id, fb_user_id),
        KEY idx_page_updated (page_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $db->exec("CREATE TABLE IF NOT EXISTS messenger_messages (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        conversation_id INT UNSIGNED NOT NULL,
        page_id         VARCHAR(64)  NOT NULL,
        user_id         VARCHAR(64)  DEFAULT NULL,
        message         TEXT         DEFAULT NULL,
        from_me         TINYINT(1)   NOT NULL DEFAULT 0,
        fb_message_id   VARCHAR(128) DEFAULT NULL,
        attachments     TEXT         DEFAULT NULL,
        created_at      DATETIME     DEFAULT NULL,
        KEY idx_conv_time (conversation_id, created_at),
        KEY idx_page_time (page_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
} catch (Exception $e) {
    // Tables already exist or DB error — log and continue
    error_log('[messenger_api] table init error: ' . $e->getMessage());
}

$method = $_SERVER['REQUEST_METHOD'];
$rawBody = file_get_contents('php://input');
$body    = json_decode($rawBody ?: '{}', true) ?: [];
$action  = $_GET['action'] ?? $body['action'] ?? $_POST['action'] ?? '';

// ══════════════════════════════════════════════════════════════
// GET ENDPOINTS
// ══════════════════════════════════════════════════════════════

if ($method === 'GET') {

    // ── LOAD CONVERSATIONS ──────────────────────────────────────
    if ($action === 'load_conversations') {
        $pageId = trim($_GET['page_id'] ?? '');
        if (!$pageId) api_json(['error' => 'Missing page_id'], 400);

        $stmt = $db->prepare("
            SELECT c.*,
                   (SELECT m.message FROM messenger_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_msg,
                   (SELECT m.from_me FROM messenger_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_from_me,
                   (SELECT m.created_at FROM messenger_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_msg_at
            FROM messenger_conversations c
            WHERE c.page_id = ?
            ORDER BY COALESCE(c.updated_at, c.id) DESC
            LIMIT 200
        ");
        $stmt->execute([$pageId]);
        api_json(['conversations' => $stmt->fetchAll()]);
    }

    // ── LOAD MESSAGES ───────────────────────────────────────────
    if ($action === 'load_messages') {
        $pageId  = trim($_GET['page_id'] ?? '');
        $psid    = trim($_GET['psid'] ?? '');
        $limit   = min(100, max(20, (int)($_GET['limit'] ?? 50)));
        $before  = trim($_GET['before'] ?? '');

        if (!$pageId || !$psid) api_json(['error' => 'Missing page_id or psid'], 400);

        $convStmt = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
        $convStmt->execute([$pageId, $psid]);
        $conv = $convStmt->fetch();
        if (!$conv) api_json(['messages' => [], 'conv_id' => null]);

        if ($before) {
            $stmt = $db->prepare("SELECT * FROM messenger_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?");
            $stmt->execute([$conv['id'], $before, $limit]);
        } else {
            $stmt = $db->prepare("SELECT * FROM messenger_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?");
            $stmt->execute([$conv['id'], $limit]);
        }
        $msgs = array_reverse($stmt->fetchAll());
        api_json(['messages' => $msgs, 'conv_id' => $conv['id']]);
    }

    // ── POLL (real-time updates, called every 3s) ───────────────
    if ($action === 'poll') {
        $pageId = trim($_GET['page_id'] ?? '');
        $since  = trim($_GET['since']   ?? '');
        $psid   = trim($_GET['psid']    ?? '');

        if (!$pageId) api_json(['error' => 'Missing page_id'], 400);
        if (!$since)  $since = date('Y-m-d H:i:s', time() - 30);

        // New messages for the open conversation
        $newMsgs = [];
        if ($psid) {
            $convRow = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
            $convRow->execute([$pageId, $psid]);
            $conv = $convRow->fetch();
            if ($conv) {
                $mStmt = $db->prepare("SELECT * FROM messenger_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC");
                $mStmt->execute([$conv['id'], $since]);
                $newMsgs = $mStmt->fetchAll();
            }
        }

        // Updated conversations since last poll
        $cStmt = $db->prepare("SELECT * FROM messenger_conversations WHERE page_id = ? AND updated_at > ? ORDER BY updated_at DESC");
        $cStmt->execute([$pageId, $since]);
        $updatedConvs = $cStmt->fetchAll();

        // Total unread
        $uStmt = $db->prepare("SELECT COALESCE(SUM(is_unread),0) as n FROM messenger_conversations WHERE page_id = ?");
        $uStmt->execute([$pageId]);
        $totalUnread = (int)$uStmt->fetchColumn();

        api_json([
            'new_messages'  => $newMsgs,
            'updated_convs' => $updatedConvs,
            'total_unread'  => $totalUnread,
            'server_time'   => date('Y-m-d H:i:s'),
        ]);
    }

    // ── UNREAD COUNT ────────────────────────────────────────────
    if ($action === 'unread_count') {
        $pageId = trim($_GET['page_id'] ?? '');
        $stmt = $db->prepare("SELECT COALESCE(SUM(is_unread),0) as n FROM messenger_conversations WHERE page_id = ?");
        $stmt->execute([$pageId]);
        api_json(['unread' => (int)$stmt->fetchColumn()]);
    }

    api_json(['error' => 'Unknown GET action: ' . $action], 400);
}

// ══════════════════════════════════════════════════════════════
// POST ENDPOINTS
// ══════════════════════════════════════════════════════════════

if ($method === 'POST') {

    // ── SEND MESSAGE ────────────────────────────────────────────
    if ($action === 'send_message') {
        $pageId     = trim($body['page_id']    ?? '');
        $psid       = trim($body['psid']       ?? '');
        $text       = trim($body['message']    ?? '');
        $pageToken  = trim($body['page_token'] ?? '');
        $imageUrl   = trim($body['image_url']  ?? '');

        if (!$pageId || !$psid || !$pageToken) api_json(['error' => 'Missing required fields'], 400);
        if (!$text && !$imageUrl) api_json(['error' => 'No message or image'], 400);

        // Build Facebook message payload
        if ($imageUrl) {
            $fbPayload = [
                'recipient'    => ['id' => $psid],
                'message'      => ['attachment' => ['type' => 'image', 'payload' => ['url' => $imageUrl, 'is_reusable' => true]]],
                'access_token' => $pageToken,
            ];
            $msgContent = '[Image] ' . $imageUrl;
        } else {
            $fbPayload = [
                'recipient'    => ['id' => $psid],
                'message'      => ['text' => $text],
                'access_token' => $pageToken,
            ];
            $msgContent = $text;
        }

        $fbResp = fb_post('https://graph.facebook.com/' . FB_API_VER . '/me/messages', $fbPayload);

        if (isset($fbResp['error'])) {
            api_json(['error' => $fbResp['error']['message'] ?? 'Facebook send failed'], 422);
        }

        // Save sent message to DB
        $convStmt = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
        $convStmt->execute([$pageId, $psid]);
        $conv = $convStmt->fetch();

        if (!$conv) {
            $db->prepare("INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at) VALUES (?, ?, 'User', '', NOW())")
               ->execute([$pageId, $psid]);
            $convStmt->execute([$pageId, $psid]);
            $conv = $convStmt->fetch();
        }

        $convId = $conv['id'];
        $now    = date('Y-m-d H:i:s');

        $db->prepare("INSERT INTO messenger_messages (conversation_id, page_id, user_id, message, from_me, created_at) VALUES (?, ?, ?, ?, 1, ?)")
           ->execute([$convId, $pageId, $psid, $msgContent, $now]);

        $db->prepare("UPDATE messenger_conversations SET snippet = ?, updated_at = NOW() WHERE id = ?")
           ->execute([$msgContent, $convId]);

        api_json([
            'success'    => true,
            'message_id' => $fbResp['message_id'] ?? '',
            'saved_at'   => $now,
            'content'    => $msgContent,
        ]);
    }

    // ── SAVE CONVERSATIONS (from Facebook Graph API) ────────────
    if ($action === 'save_conversations') {
        $pageId        = trim($body['page_id'] ?? $_POST['page_id'] ?? '');
        $conversations = $body['conversations'] ?? json_decode($_POST['conversations'] ?? '[]', true) ?? [];
        if (!$pageId) api_json(['error' => 'Missing page_id'], 400);

        $stmt = $db->prepare("
            INSERT INTO messenger_conversations (page_id, fb_user_id, user_name, user_picture, snippet, updated_at, is_unread)
            VALUES (?, ?, ?, ?, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE user_name=VALUES(user_name), user_picture=VALUES(user_picture),
            snippet=VALUES(snippet), updated_at=NOW(), is_unread=VALUES(is_unread)
        ");

        $saved = 0;
        foreach ($conversations as $c) {
            $stmt->execute([$pageId, $c['psid'] ?? '', $c['user_name'] ?? 'User',
                $c['user_picture'] ?? null, $c['last_message'] ?? '', (int)($c['unread_count'] ?? 0)]);
            $saved++;
        }
        api_json(['success' => true, 'saved' => $saved]);
    }

    // ── MARK READ ───────────────────────────────────────────────
    if ($action === 'mark_read') {
        $pageId = trim($body['page_id'] ?? $_POST['page_id'] ?? '');
        $psid   = trim($body['psid']    ?? $_POST['psid']    ?? '');
        if (!$pageId || !$psid) api_json(['error' => 'Missing fields'], 400);

        $db->prepare("UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND fb_user_id = ?")
           ->execute([$pageId, $psid]);
        api_json(['success' => true]);
    }

    // ── FETCH USER NAME FROM FACEBOOK ───────────────────────────
    if ($action === 'fetch_user_name') {
        $psid      = trim($body['psid']       ?? '');
        $pageToken = trim($body['page_token'] ?? '');
        $pageId    = trim($body['page_id']    ?? '');
        if (!$psid || !$pageToken) api_json(['error' => 'Missing fields'], 400);

        $data = fb_get_api($psid, $pageToken, ['fields' => 'name,profile_pic']);
        $name = $data['name'] ?? '';
        $pic  = $data['profile_pic'] ?? null;

        if ($name && $pageId) {
            $db->prepare("UPDATE messenger_conversations SET user_name = ?, user_picture = ? WHERE page_id = ? AND fb_user_id = ?")
               ->execute([$name, $pic, $pageId, $psid]);
        }
        api_json(['success' => true, 'name' => $name, 'picture' => $pic]);
    }

    api_json(['error' => 'Unknown POST action: ' . $action], 400);
}

api_json(['error' => 'Method not allowed'], 405);
