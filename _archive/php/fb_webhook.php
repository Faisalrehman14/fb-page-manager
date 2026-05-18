<?php
declare(strict_types=1);

/**
 * fb_webhook.php — Facebook Messenger webhook receiver.
 *
 * Facebook Developer Console settings:
 *   Callback URL:  https://yoursite.com/fb_webhook.php
 *   Verify Token:  value of WEBHOOK_VERIFY_TOKEN env var (currently: ADMIN12345)
 *   Subscriptions: messages, message_deliveries, message_reads
 *
 * Design rules:
 *  - Respond 200 to Facebook BEFORE any DB work (Facebook's 20s timeout)
 *  - Use fastcgi_finish_request() on PHP-FPM so Facebook sees the response instantly
 *  - Wrap load-env.php — missing FB_APP_ID must NOT kill the webhook
 *  - session_write_close() immediately — sessions create a file lock that
 *    serializes concurrent webhook requests (one blocks the other)
 */

// FBCAST_PAGE_CONTEXT makes load-env.php throw RuntimeException instead of
// calling die() when optional vars (FB_APP_ID) are absent.
define('FBCAST_PAGE_CONTEXT', 'webhook');
try {
    require_once __DIR__ . '/config/load-env.php';
} catch (RuntimeException $e) {
    // FB_APP_ID or Stripe keys may not be set — that's fine for the webhook.
    // DB credentials and FB_APP_SECRET are what we actually need here.
    error_log('[webhook] Config (non-fatal): ' . $e->getMessage());
}

// Release session file lock immediately.
// Without this, concurrent Facebook webhook POSTs block each other on the
// PHP session mutex, causing timeouts and missed message events.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

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

// ── Resolve verify token — handles both Railway env var names ─────────────────
function getVerifyToken(): string
{
    // Check defined constant first (set by load-env.php if the var exists)
    if (defined('FB_WEBHOOK_VERIFY_TOKEN') && FB_WEBHOOK_VERIFY_TOKEN !== '') {
        return FB_WEBHOOK_VERIFY_TOKEN;
    }
    // Fallback: Railway uses WEBHOOK_VERIFY_TOKEN (without FB_ prefix)
    foreach (['WEBHOOK_VERIFY_TOKEN', 'FB_WEBHOOK_VERIFY_TOKEN'] as $key) {
        $v = getenv($key);
        if ($v !== false && $v !== '') return trim($v);
        if (!empty($_ENV[$key]))    return trim($_ENV[$key]);
        if (!empty($_SERVER[$key])) return trim($_SERVER[$key]);
    }
    return '';
}

// ── Webhook Verification (GET) ────────────────────────────────────────────────
if ($method === 'GET') {
    $token    = getVerifyToken();
    $received = $_GET['hub_verify_token'] ?? '';

    if ($token !== '' && !hash_equals($token, $received)) {
        error_log('[webhook] Verify token mismatch. Expected: ' . $token . ' Got: ' . $received);
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

// ── Validate Facebook signature (HMAC-SHA256) ─────────────────────────────────
// FB_APP_SECRET is set in Railway — this prevents spoofed webhook calls.
$raw = file_get_contents('php://input') ?: '{}';

$appSecret = defined('FB_APP_SECRET') ? FB_APP_SECRET : (getenv('FB_APP_SECRET') ?: '');
if ($appSecret) {
    $sigHeader = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
    if ($sigHeader) {
        $expected = 'sha256=' . hash_hmac('sha256', $raw, $appSecret);
        if (!hash_equals($expected, $sigHeader)) {
            error_log('[webhook] Invalid signature — possible spoofed request');
            http_response_code(403);
            exit;
        }
    }
}

// ── Parse payload ─────────────────────────────────────────────────────────────
$payload = json_decode($raw, true);

if (empty($payload['entry'])) {
    http_response_code(400);
    exit(json_encode(['error' => 'Invalid payload']));
}

// ── Acknowledge Facebook immediately — BEFORE any DB work ─────────────────────
// Facebook requires a 200 within 20 seconds or it retries the event.
// fastcgi_finish_request() (PHP-FPM) closes the connection instantly.
// The script continues executing in the background after this point.
http_response_code(200);
echo json_encode(['status' => 'ok']);

if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();   // PHP-FPM: closes TCP connection immediately
} else {
    if (ob_get_level()) ob_end_flush();
    flush();
}

// ── Process events after response is sent ─────────────────────────────────────
try {
    $db    = Db::get();
    Db::migrate();
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
        ? gmdate('Y-m-d H:i:s', (int) ($event['timestamp'] / 1000))
        : gmdate('Y-m-d H:i:s');

    // ── Incoming message ──────────────────────────────────────────────────────
    if (isset($event['message'])) {
        $msg = $event['message'];

        // Echo = message we sent, already saved in send_message action
        if ($msg['is_echo'] ?? false) return;

        $mid  = $msg['mid'] ?? null;
        $text = $msg['text'] ?? '';

        // Resolve attachment type + friendly fallback text
        $attUrl    = null;
        $attType   = null;
        $metadata  = null;

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

        // Capture full FB metadata (reactions, stickers, reply_to, etc.)
        if (!empty($msg['sticker_id']) || !empty($msg['reply_to']) || !empty($msg['reactions'])) {
            $metadata = array_filter([
                'sticker_id' => $msg['sticker_id'] ?? null,
                'reply_to'   => $msg['reply_to']   ?? null,
                'reactions'  => $msg['reactions']  ?? null,
            ]);
        }

        $convId = $convs->ensureExists($pageId, $psid);

        if ($convId === 0) {
            error_log("[webhook] WARN: ensureExists returned 0 for page=$pageId psid=$psid — skipping save");
            return;
        }

        $saved = $msgs->save($convId, $pageId, $psid, $mid, $text, false, $attUrl, $attType, $ts, $metadata ?: null);

        // Only update counters if this wasn't a duplicate webhook retry
        if ($saved) {
            $convs->onIncomingMessage($pageId, $psid, $text);
        }

        error_log(sprintf(
            '[webhook] message saved=%s page=%s psid=%s mid=%s convId=%d',
            $saved ? 'yes' : 'dup', $pageId, $psid, $mid ?? 'null', $convId
        ));
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
