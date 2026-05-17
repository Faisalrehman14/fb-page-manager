<?php
/**
 * messenger_api.php — Save/load Messenger conversations & messages
 * Matches existing database schema
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Authorization, Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

function json($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function auth() {
    $token = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    $expected = defined('FB_APP_SECRET') ? FB_APP_SECRET : '';
    if (!$expected) return false;
    if (strpos($token, 'Bearer ') !== 0) return false;
    return hash_equals($expected, substr($token, 7));
}

// Auth disabled for debugging
// if (!auth()) { json(['error' => 'Unauthorized'], 401); }

try {
    $db = getDB();
} catch (Exception $e) {
    error_log('DB connection failed: ' . $e->getMessage());
    json(['error' => 'Database connection failed', 'debug' => $e->getMessage()], 500);
}

$method = $_SERVER['REQUEST_METHOD'];

// Debug: log request details
$debugAction = $_GET['action'] ?? $_POST['action'] ?? 'none';

try {
    // ── SAVE CONVERSATIONS ──
    if ($method === 'POST' && isset($_POST['action']) && $_POST['action'] === 'save_conversations') {
        $pageId = trim($_POST['page_id'] ?? '');
        $conversations = json_decode($_POST['conversations'] ?? '[]', true);

        if (!$pageId) {
            json(['error' => 'Missing page_id'], 400);
        }

        $stmt = $db->prepare("
            INSERT INTO messenger_conversations
            (page_id, fb_user_id, user_name, user_picture, snippet, updated_at, is_unread)
            VALUES (?, ?, ?, ?, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE
            user_name = VALUES(user_name),
            user_picture = VALUES(user_picture),
            snippet = VALUES(snippet),
            updated_at = NOW(),
            is_unread = VALUES(is_unread)
        ");

        $saved = 0;
        foreach ($conversations as $conv) {
            $stmt->execute([
                $pageId,
                $conv['psid'] ?? $conv['fb_user_id'] ?? '',
                $conv['user_name'] ?? 'User',
                $conv['user_picture'] ?? null,
                $conv['last_message'] ?? $conv['snippet'] ?? '',
                (int)($conv['unread_count'] ?? 0),
            ]);
            $saved++;
        }

        json(['success' => true, 'saved' => $saved]);
    }

    // ── SAVE MESSAGES ──
    if ($method === 'POST' && isset($_POST['action']) && $_POST['action'] === 'save_messages') {
        $pageId = trim($_POST['page_id'] ?? '');
        $psid = trim($_POST['psid'] ?? '');
        $messages = json_decode($_POST['messages'] ?? '[]', true);

        if (!$pageId || !$psid) {
            json(['error' => 'Missing page_id or psid'], 400);
        }

        // Get conversation by page_id and fb_user_id (psid)
        $convRow = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
        $convRow->execute([$pageId, $psid]);
        $conv = $convRow->fetch();

        if (!$conv) {
            // Create conversation if it doesn't exist
            $db->prepare("INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at) VALUES (?, ?, 'User', '', NOW())")
                ->execute([$pageId, $psid]);
            $convRow->execute([$pageId, $psid]);
            $conv = $convRow->fetch();
        }

        if (!$conv) {
            json(['error' => 'Failed to create conversation', 'page_id' => $pageId, 'psid' => $psid], 500);
        }
        $convId = $conv['id'];

        $stmt = $db->prepare("
            INSERT INTO messenger_messages
            (conversation_id, page_id, user_id, message, from_me, attachment_type, attachment_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ");

        $saved = 0;
        foreach ($messages as $msg) {
            $stmt->execute([
                $convId,
                $pageId,
                $psid,
                $msg['content'] ?? $msg['message'] ?? '',
                (int)($msg['is_from_user'] ?? 1),
                $msg['attachment_type'] ?? null,
                $msg['attachment_url'] ?? null,
                isset($msg['sent_at']) ? date('Y-m-d H:i:s', strtotime($msg['sent_at'])) : date('Y-m-d H:i:s'),
            ]);
            $saved++;
        }

        // Update conversation snippet
        $lastMsg = end($messages);
        $db->prepare("UPDATE messenger_conversations SET snippet = ?, updated_at = NOW() WHERE id = ?")
            ->execute([$lastMsg['content'] ?? $lastMsg['message'] ?? '', $convId]);

        json(['success' => true, 'saved' => $saved]);
    }

    // ── LOAD CONVERSATIONS ──
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'load_conversations') {
        $fbUserId = trim($_GET['fb_user_id'] ?? '');
        $pageId = trim($_GET['page_id'] ?? '');

        if (!$pageId) {
            json(['error' => 'Missing page_id'], 400);
        }

        $query = "
            SELECT * FROM messenger_conversations
            WHERE page_id = ?
            ORDER BY updated_at DESC
            LIMIT 500
        ";

        $stmt = $db->prepare($query);
        $stmt->execute([$pageId]);
        $conversations = $stmt->fetchAll();

        json(['conversations' => $conversations]);
    }

    // ── LOAD MESSAGES ──
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'load_messages') {
        $pageId = trim($_GET['page_id'] ?? '');
        $psid = trim($_GET['psid'] ?? '');
        $limit = min(100, max(10, (int)($_GET['limit'] ?? 50)));

        if (!$pageId || !$psid) {
            json(['error' => 'Missing page_id or psid'], 400);
        }

        $query = "
            SELECT * FROM messenger_messages
            WHERE page_id = ? AND user_id = ?
            ORDER BY created_at ASC
            LIMIT ?
        ";

        $stmt = $db->prepare($query);
        $stmt->execute([$pageId, $psid, $limit]);
        $messages = $stmt->fetchAll();

        json(['messages' => $messages]);
    }

    // ── MARK AS READ ──
    if ($method === 'POST' && isset($_POST['action']) && $_POST['action'] === 'mark_read') {
        $pageId = trim($_POST['page_id'] ?? '');
        $psid = trim($_POST['psid'] ?? '');

        if (!$pageId || !$psid) {
            json(['error' => 'Missing page_id or psid'], 400);
        }

        $db->prepare("UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND fb_user_id = ?")
            ->execute([$pageId, $psid]);

        json(['success' => true]);
    }

    // ── UPDATE LAST MESSAGE ──
    if ($method === 'POST' && isset($_POST['action']) && $_POST['action'] === 'update_conversation') {
        $pageId = trim($_POST['page_id'] ?? '');
        $psid = trim($_POST['psid'] ?? '');
        $lastMessage = trim($_POST['last_message'] ?? '');

        if (!$pageId || !$psid) {
            json(['error' => 'Missing page_id or psid'], 400);
        }

        $db->prepare("UPDATE messenger_conversations SET snippet = ?, updated_at = NOW() WHERE page_id = ? AND fb_user_id = ?")
            ->execute([$lastMessage, $pageId, $psid]);

        json(['success' => true]);
    }

    // ── GET TOTAL UNREAD COUNT ──
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'unread_count') {
        $pageId = trim($_GET['page_id'] ?? '');

        $stmt = $db->prepare("SELECT SUM(is_unread) as total_unread FROM messenger_conversations WHERE page_id = ?");
        $stmt->execute([$pageId]);
        $row = $stmt->fetch();

        json(['unread' => (int)($row['total_unread'] ?? 0)]);
    }

    // ── GET RECENT CHANGES (for polling) ──
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'recent_changes') {
        $pageId = trim($_GET['page_id'] ?? '');
        $since = isset($_GET['since']) ? date('Y-m-d H:i:s', strtotime($_GET['since'])) : date('Y-m-d H:i:s', strtotime('-5 minutes'));

        if (!$pageId) {
            json(['error' => 'Missing page_id'], 400);
        }

        // Get updated conversations
        $stmt = $db->prepare("SELECT * FROM messenger_conversations WHERE page_id = ? AND updated_at > ? ORDER BY updated_at DESC");
        $stmt->execute([$pageId, $since]);
        $conversations = $stmt->fetchAll();

        // Get new messages
        $stmt2 = $db->prepare("SELECT * FROM messenger_messages WHERE page_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 50");
        $stmt2->execute([$pageId, $since]);
        $messages = $stmt2->fetchAll();

        // Unread count
        $stmt3 = $db->prepare("SELECT SUM(is_unread) as total_unread FROM messenger_conversations WHERE page_id = ?");
        $stmt3->execute([$pageId]);
        $unreadRow = $stmt3->fetch();

        json([
            'conversations' => $conversations,
            'messages' => $messages,
            'total_unread' => (int)($unreadRow['total_unread'] ?? 0),
            'server_time' => date('Y-m-d H:i:s')
        ]);
    }

    // ── GET OR CREATE CONVERSATION ──
    if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'get_conversation') {
        $pageId = trim($_GET['page_id'] ?? '');
        $psid = trim($_GET['psid'] ?? '');

        if (!$pageId || !$psid) {
            json(['error' => 'Missing page_id or psid'], 400);
        }

        $stmt = $db->prepare("SELECT * FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
        $stmt->execute([$pageId, $psid]);
        $conv = $stmt->fetch();

        if (!$conv) {
            $db->prepare("INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at) VALUES (?, ?, 'User', '', NOW())")
                ->execute([$pageId, $psid]);
            $stmt->execute([$pageId, $psid]);
            $conv = $stmt->fetch();
        }

        json(['conversation' => $conv]);
    }

    // ── SYNC FROM WEBHOOK (internal use) ──
    if ($method === 'POST' && isset($_POST['action']) && $_POST['action'] === 'webhook_sync') {
        $pageId = trim($_POST['page_id'] ?? '');
        $events = json_decode($_POST['events'] ?? '[]', true);

        if (!$pageId || empty($events)) {
            json(['error' => 'Missing data'], 400);
        }

        $processed = 0;
        foreach ($events as $event) {
            $psid = $event['psid'] ?? '';
            $messageId = $event['message_id'] ?? '';
            $text = $event['text'] ?? '';
            $isFromUser = (bool)($event['is_from_user'] ?? true);
            $sentAt = $event['sent_at'] ?? date('Y-m-d H:i:s');
            $attachmentUrl = $event['attachment_url'] ?? null;
            $attachmentType = $event['attachment_type'] ?? null;

            if (!$psid) continue;

            // Get or create conversation - use fb_user_id (not user_id) in conversations table
            $stmt = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
            $stmt->execute([$pageId, $psid]);
            $conv = $stmt->fetch();

            if (!$conv) {
                $db->prepare("INSERT IGNORE INTO messenger_conversations (page_id, fb_user_id, user_name, snippet, updated_at) VALUES (?, ?, 'User', ?, NOW())")
                    ->execute([$pageId, $psid, $text ?: 'New message']);
                $stmt->execute([$pageId, $psid]);
                $conv = $stmt->fetch();
            }

            if (!$conv) continue;
            $convId = $conv['id'];

            // Check for duplicate message
            if ($messageId || $text) {
                $check = $db->prepare("SELECT id FROM messenger_messages WHERE page_id = ? AND user_id = ? AND message = ?");
                $check->execute([$pageId, $psid, $text]);
                if ($check->fetch()) {
                    $processed++;
                    continue;
                }
            }

            // Save message - from_me: 1 = from page (me), 0 = from user
            // isFromUser = true means customer sent it, so from_me = 0
            $fromMe = $isFromUser ? 0 : 1;
            $db->prepare("INSERT INTO messenger_messages (conversation_id, page_id, user_id, message, from_me, attachment_type, attachment_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([$convId, $pageId, $psid, $text, $fromMe, $attachmentType, $attachmentUrl, $sentAt]);

            $processed++;
        }

        json(['success' => true, 'processed' => $processed]);
    }

    json(['error' => 'Unknown action: ' . $debugAction, 'method' => $method, 'available' => 'save_conversations, save_messages, load_conversations, load_messages, mark_read, update_conversation, get_conversation, webhook_sync'], 400);

} catch (PDOException $e) {
    error_log('Messenger API PDO error: ' . $e->getMessage());
    json(['error' => 'Database error', 'debug' => $e->getMessage()], 500);
} catch (Exception $e) {
    error_log('Messenger API error: ' . $e->getMessage());
    json(['error' => $e->getMessage()], 500);
}