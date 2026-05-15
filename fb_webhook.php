<?php
/**
 * fb_webhook.php — Facebook Messenger Platform Webhook
 *
 * This endpoint receives real-time messages from Facebook Messenger Platform.
 * Configure in Facebook Developer Console:
 *   Webhooks → Callback URL: https://yoursite.com/fb_webhook.php
 *   Verify Token: Set FB_WEBHOOK_VERIFY_TOKEN in your .env
 *
 * Events to subscribe:
 *   - messages
 *   - messaging_postbacks
 *   - message_deliveries
 *   - message_reads
 *   - messaging_optins
 * ───────────────────────────────────────────────────────── */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

error_reporting(E_ALL & ~E_NOTICE);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$verifyToken = defined('FB_WEBHOOK_VERIFY_TOKEN') ? FB_WEBHOOK_VERIFY_TOKEN : '';
$expectedToken = $_GET['hub_verify_token'] ?? '';

try {
    $db = getDB();
} catch (Exception $e) {
    error_log('FB Webhook DB error: ' . $e->getMessage());
    http_response_code(503);
    exit;
}

// ── VERIFICATION (GET) ──
if ($method === 'GET') {
    $challenge = $_GET['hub_challenge'] ?? '';

    // Allow empty token for debugging (remove in production!)
    if ($verifyToken !== '' && !hash_equals($verifyToken, $expectedToken)) {
        http_response_code(403);
        exit('Forbidden - Invalid verify token');
    }

    echo $challenge;
    exit;
}

// ── WEBHOOK EVENTS (POST) ──
if ($method === 'POST') {
    // Log ALL POST requests to see if Facebook is calling us
    error_log('FB Webhook POST received: ' . ($_SERVER['REQUEST_URI'] ?? 'no uri'));

    $payload = file_get_contents('php://input') ?: '';
    if ($payload === '') {
        error_log('FB Webhook POST: Empty payload');
        http_response_code(400);
        exit(json_encode(['error' => 'Empty payload']));
    }

    error_log('FB Webhook POST payload size: ' . strlen($payload));

    $data = json_decode($payload, true);
    if (!$data || !isset($data['entry'])) {
        error_log('FB Webhook POST: Invalid payload - ' . substr($payload, 0, 200));
        http_response_code(400);
        exit(json_encode(['error' => 'Invalid payload']));
    }

    // Log webhook receipt
    $entryCount = count($data['entry'] ?? []);
    error_log('FB Webhook received: entries=' . $entryCount . ', size=' . strlen($payload));
    logger('info', 'FB Webhook received', ['entries' => $entryCount, 'size' => strlen($payload)]);

    $processed = 0;
    $errors = 0;

    foreach ($data['entry'] as $entry) {
        $pageId = $entry['id'] ?? '';
        $time = $entry['time'] ?? time();

        // Process messaging events
        foreach ($entry['messaging'] ?? [] as $event) {
            $senderId = $event['sender']['id'] ?? '';
            $recipientId = $event['recipient']['id'] ?? '';

            try {
                processMessengerEvent($db, $pageId, $event);
                $processed++;
            } catch (Exception $e) {
                $errors++;
                error_log('FB Webhook event error: ' . $e->getMessage());
            }
        }
    }

    // Return 200 immediately (don't wait for processing)
    echo json_encode([
        'status' => 'received',
        'processed' => $processed,
        'errors' => $errors
    ]);
    exit;
}

// ── PROCESS MESSENGER EVENTS ──
function processMessengerEvent(PDO $db, string $pageId, array $event): void {
    $senderId = $event['sender']['id'] ?? '';
    $recipientId = $event['recipient']['id'] ?? '';
    $timestamp = isset($event['timestamp']) ? date('Y-m-d H:i:s', (int)($event['timestamp'] / 1000)) : date('Y-m-d H:i:s');

    // Log ALL incoming events for debugging
    error_log('FB Webhook Event: pageId=' . $pageId . ', senderId=' . $senderId . ', event=' . json_encode(array_keys($event)));

    // ── MESSAGE EVENT ──
    if (isset($event['message'])) {
        $msg = $event['message'];
        $messageId = $msg['mid'] ?? '';
        $text = $msg['text'] ?? '';
        $hasAttachment = isset($msg['attachments']) && !empty($msg['attachments']);
        $isEcho = $msg['is_echo'] ?? false;

        error_log('FB Webhook Message: mid=' . $messageId . ', text=' . substr($text, 0, 50) . ', isEcho=' . ($isEcho ? 'true' : 'false'));

        // Skip echoes (messages sent by our bot)
        if ($isEcho) {
            error_log('Skipping echo message');
            return;
        }

        $attachments = $msg['attachments'] ?? [];
        $attachmentUrl = null;
        $attachmentType = null;

        if (!empty($attachments)) {
            $att = $attachments[0];
            $attachmentType = $att['type'] ?? 'file';
            $attachmentUrl = $att['payload']['url'] ?? null;
            if (!$text && $attachmentType === 'image') {
                $text = '[Image]';
            } elseif (!$text && $attachmentType === 'location') {
                $text = '[Location]';
            } elseif (!$text && $attachmentType === 'audio') {
                $text = '[Audio]';
            }
        }

        // Upsert conversation
        $userName = '';
        $userPicture = null;

        // Get or create conversation
        $convId = upsertConversation($db, $pageId, $senderId, $userName, $userPicture);
        error_log('Conversation upserted, convId=' . $convId);

        // Save message - isFromUser=true means customer sent it
        saveMessage($db, $convId, $pageId, $senderId, $messageId, 'text', $text, true, $hasAttachment, $attachmentUrl, $attachmentType, $timestamp);
        error_log('Message saved: pageId=' . $pageId . ', userId=' . $senderId . ', text=' . substr($text, 0, 50));

        // Update unread count
        updateUnreadCount($db, $pageId, $senderId, 1);
        error_log('Unread count updated');

        logger('info', 'New message received', [
            'page' => $pageId,
            'psid' => $senderId,
            'mid' => $messageId,
            'text_len' => strlen($text)
        ]);
    }

    // ── DELIVERY RECEIPT ──
    if (isset($event['delivery'])) {
        $delivery = $event['delivery'];
        $mids = $delivery['mids'] ?? [];

        foreach ($mids as $mid) {
            $db->prepare("UPDATE messenger_messages SET delivered_at = NOW() WHERE message_id = ?")
               ->execute([$mid]);
        }
    }

    // ── READ RECEIPT ──
    if (isset($event['read'])) {
        // Use correct column names: page_id, user_id
        $db->prepare("UPDATE messenger_messages SET is_read = 1 WHERE page_id = ? AND user_id = ? AND is_read = 0")
           ->execute([$pageId, $senderId]);

        // Use correct column names: page_id, fb_user_id, is_unread
        $db->prepare("UPDATE messenger_conversations SET is_unread = 0 WHERE page_id = ? AND fb_user_id = ?")
           ->execute([$pageId, $senderId]);
    }

    // ── OPTIN (Send to Messenger) ──
    if (isset($event['optin'])) {
        $optin = $event['optin'];
        $ref = $optin['ref'] ?? '';
        $userId = $optin['user_ref'] ?? '';

        logger('info', 'User optin received', [
            'page' => $pageId,
            'ref' => $ref,
            'user_ref' => $userId
        ]);
    }
}

// ── UPSERT CONVERSATION ──
function upsertConversation(PDO $db, string $pageId, string $psid, string $userName, ?string $userPicture): int {
    // Check if exists - use correct column names: page_id, fb_user_id
    $stmt = $db->prepare("SELECT id FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
    $stmt->execute([$pageId, $psid]);
    $row = $stmt->fetch();

    if ($row) {
        // Update timestamp and snippet
        $db->prepare("UPDATE messenger_conversations SET updated_at = NOW() WHERE id = ?")
           ->execute([$row['id']]);
        return (int)$row['id'];
    }

    // Create new - use correct column names
    $db->prepare("
        INSERT INTO messenger_conversations (page_id, fb_user_id, user_name, user_picture, snippet, updated_at)
        VALUES (?, ?, ?, ?, '', NOW())
    ")->execute([$pageId, $psid, $userName ?: 'User', $userPicture]);

    return (int)$db->lastInsertId();
}

// ── SAVE MESSAGE ──
function saveMessage(PDO $db, int $convId, string $pageId, string $psid, string $messageId,
                     string $type, ?string $content, bool $isFromUser, bool $hasAttachment,
                     ?string $attachmentUrl, ?string $attachmentType, string $sentAt): void {
    // Avoid duplicates by message_id
    if ($messageId) {
        $stmt = $db->prepare("SELECT id FROM messenger_messages WHERE message_id = ? LIMIT 1");
        $stmt->execute([$messageId]);
        if ($stmt->fetch()) return;
    }

    $fromMe = $isFromUser ? 0 : 1;
    try {
        $db->prepare("
            INSERT INTO messenger_messages
            (conversation_id, page_id, user_id, message_id, message, from_me, attachment_url, attachment_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ")->execute([$convId, $pageId, $psid, $messageId ?: null, $content, $fromMe, $attachmentUrl, $attachmentType, $sentAt]);
    } catch (Exception $e) {
        // Duplicate key on message_id — ignore
        error_log('saveMessage duplicate or error: ' . $e->getMessage());
    }
}

// ── UPDATE UNREAD COUNT ──
function updateUnreadCount(PDO $db, string $pageId, string $psid, int $increment): void {
    // Use correct column names: page_id, fb_user_id, is_unread
    $db->prepare("
        UPDATE messenger_conversations
        SET is_unread = is_unread + 1, updated_at = NOW()
        WHERE page_id = ? AND fb_user_id = ?
    ")->execute([$pageId, $psid]);
}

// ── GET OR CREATE USER INFO (for future enhancement) ──
function getOrCreateUserInfo(PDO $db, string $pageId, string $psid): array {
    $stmt = $db->prepare("SELECT * FROM messenger_conversations WHERE page_id = ? AND fb_user_id = ?");
    $stmt->execute([$pageId, $psid]);
    return $stmt->fetch() ?: [];
}