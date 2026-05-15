<?php
declare(strict_types=1);

/**
 * fb_webhook.php — Facebook Messenger webhook receiver.
 *
 * Facebook Developer Console settings:
 *   Callback URL:  https://yoursite.com/fb_webhook.php
 *   Verify Token:  FB_WEBHOOK_VERIFY_TOKEN (in .env)
 *   Subscriptions: messages, message_deliveries, message_reads
 *
 * Design rule: respond to Facebook within 20 s or it will retry.
 * Heavy work happens AFTER echo (PHP keeps executing after flush).
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/src/Db.php';
require_once __DIR__ . '/src/ConversationService.php';
require_once __DIR__ . '/src/MessageService.php';

error_reporting(0);
ini_set('log_errors', '1');
ignore_user_abort(true);

header('Content-Type: application/json');
header('Cache-Control: no-store');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ── Webhook Verification (GET) ────────────────────────────────────────────────
if ($method === 'GET') {
    $token    = defined('FB_WEBHOOK_VERIFY_TOKEN') ? FB_WEBHOOK_VERIFY_TOKEN : '';
    $received = $_GET['hub_verify_token'] ?? '';

    if ($token !== '' && !hash_equals($token, $received)) {
        http_response_code(403);
        exit('Forbidden');
    }

    echo $_GET['hub_challenge'] ?? '';
    exit;
}

if ($method !== 'POST') {
    http_response_code(405);
    exit;
}

// ── Event Processing (POST) ───────────────────────────────────────────────────
$raw     = file_get_contents('php://input') ?: '{}';
$payload = json_decode($raw, true);

if (empty($payload['entry'])) {
    http_response_code(400);
    exit(json_encode(['error' => 'Invalid payload']));
}

// Acknowledge Facebook immediately — must happen before any slow DB work
http_response_code(200);
echo json_encode(['status' => 'ok']);

// Flush response to Facebook now so the connection closes on their end
if (ob_get_level()) ob_end_flush();
flush();

// ── Process events after response is sent ─────────────────────────────────────
try {
    $db    = Db::get();
    $convs = new ConversationService($db);
    $msgs  = new MessageService($db);
} catch (Exception $e) {
    error_log('[webhook] DB unavailable: ' . $e->getMessage());
    exit;
}

foreach ($payload['entry'] as $entry) {
    $pageId = $entry['id'] ?? '';
    if (!$pageId) continue;

    foreach ($entry['messaging'] ?? [] as $event) {
        try {
            handleEvent($convs, $msgs, $pageId, $event);
        } catch (Exception $e) {
            error_log('[webhook] event error: ' . $e->getMessage());
        }
    }
}

// ── Event Handler ─────────────────────────────────────────────────────────────
function handleEvent(
    ConversationService $convs,
    MessageService      $msgs,
    string              $pageId,
    array               $event
): void {
    $psid = $event['sender']['id'] ?? '';
    if (!$psid || !$pageId) return;

    $ts = isset($event['timestamp'])
        ? date('Y-m-d H:i:s', (int) ($event['timestamp'] / 1000))
        : date('Y-m-d H:i:s');

    // ── Incoming message ──────────────────────────────────────────────────────
    if (isset($event['message'])) {
        $msg = $event['message'];

        // Echo = message we sent, already saved in send_message action
        if ($msg['is_echo'] ?? false) return;

        $mid  = $msg['mid'] ?? null;
        $text = $msg['text'] ?? '';

        // Resolve attachment type + friendly fallback text
        $attUrl  = null;
        $attType = null;
        if (!empty($msg['attachments'])) {
            $att     = $msg['attachments'][0];
            $attType = $att['type'] ?? 'file';
            $attUrl  = $att['payload']['url'] ?? null;
            if (!$text) {
                $text = match ($attType) {
                    'image'    => '[Image]',
                    'audio'    => '[Audio]',
                    'video'    => '[Video]',
                    'location' => '[Location]',
                    default    => '[Attachment]',
                };
            }
        }

        $convId = $convs->ensureExists($pageId, $psid);
        $saved  = $msgs->save($convId, $pageId, $psid, $mid, $text, false, $attUrl, $attType, $ts);

        // Only update counters if this wasn't a duplicate webhook retry
        if ($saved) {
            $convs->onIncomingMessage($pageId, $psid, $text);
        }

        error_log(sprintf('[webhook] message saved=%s page=%s psid=%s mid=%s', $saved ? 'yes' : 'dup', $pageId, $psid, $mid ?? 'null'));
        return;
    }

    // ── Delivery receipt ──────────────────────────────────────────────────────
    if (isset($event['delivery'])) {
        foreach ($event['delivery']['mids'] ?? [] as $mid) {
            $msgs->markDelivered($mid);
        }
        return;
    }

    // ── Read receipt ──────────────────────────────────────────────────────────
    if (isset($event['read'])) {
        $msgs->markRead($pageId, $psid);
        $convs->markRead($pageId, $psid);
    }
}
