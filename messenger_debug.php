<?php
/**
 * messenger_debug.php — Diagnostics for the Messenger system.
 * Access at: https://yoursite.com/messenger_debug.php
 * DELETE THIS FILE after fixing the issue.
 */

define('FBCAST_PAGE_CONTEXT', 'debug');
try { require_once __DIR__ . '/config/load-env.php'; } catch (Throwable $e) {}
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/src/Db.php';
require_once __DIR__ . '/src/ConversationService.php';
require_once __DIR__ . '/src/MessageService.php';

header('Content-Type: application/json');

$result = ['time' => date('Y-m-d H:i:s'), 'timezone' => date_default_timezone_get()];

// ── 1. DB connection ──────────────────────────────────────────────────────────
try {
    $db = Db::get();
    Db::migrate();
    $result['db'] = 'connected';
} catch (Exception $e) {
    $result['db']    = 'FAILED';
    $result['db_err'] = $e->getMessage();
    echo json_encode($result, JSON_PRETTY_PRINT);
    exit;
}

// ── 2. Table row counts ───────────────────────────────────────────────────────
foreach (['messenger_conversations', 'messenger_messages', 'messenger_pages'] as $tbl) {
    try {
        $result['counts'][$tbl] = (int) $db->query("SELECT COUNT(*) FROM $tbl")->fetchColumn();
    } catch (Exception $e) {
        $result['counts'][$tbl] = 'TABLE_MISSING';
    }
}

// ── 3. Recent conversations ───────────────────────────────────────────────────
try {
    $stmt = $db->query("SELECT id, page_id, fb_user_id, user_name, snippet, is_unread, updated_at
                        FROM messenger_conversations ORDER BY updated_at DESC LIMIT 5");
    $result['recent_convs'] = $stmt->fetchAll();
} catch (Exception $e) {
    $result['recent_convs'] = 'ERROR: ' . $e->getMessage();
}

// ── 4. Recent messages ────────────────────────────────────────────────────────
try {
    $stmt = $db->query("SELECT id, conversation_id, page_id, user_id, message_id,
                               LEFT(message,80) AS message, from_me, created_at
                        FROM messenger_messages ORDER BY created_at DESC LIMIT 10");
    $result['recent_messages'] = $stmt->fetchAll();
} catch (Exception $e) {
    $result['recent_messages'] = 'ERROR: ' . $e->getMessage();
}

// ── 5. Messages with conversation_id = 0 (race condition) ────────────────────
try {
    $bad = (int) $db->query("SELECT COUNT(*) FROM messenger_messages WHERE conversation_id = 0")->fetchColumn();
    $result['orphaned_messages_conv0'] = $bad;
} catch (Exception $e) {
    $result['orphaned_messages_conv0'] = 'ERROR';
}

// ── 6. Env var check ─────────────────────────────────────────────────────────
$result['env'] = [
    'FB_APP_ID'              => defined('FB_APP_ID')              ? (FB_APP_ID              ? 'SET' : 'EMPTY') : 'NOT_DEFINED',
    'FB_APP_SECRET'          => defined('FB_APP_SECRET')          ? (FB_APP_SECRET          ? 'SET' : 'EMPTY') : 'NOT_DEFINED',
    'FB_WEBHOOK_VERIFY_TOKEN'=> defined('FB_WEBHOOK_VERIFY_TOKEN')? (FB_WEBHOOK_VERIFY_TOKEN? 'SET (' . FB_WEBHOOK_VERIFY_TOKEN . ')' : 'EMPTY') : 'NOT_DEFINED',
    'DB_HOST'                => defined('DB_HOST')                ? (DB_HOST                ? 'SET' : 'EMPTY') : 'NOT_DEFINED',
    'DB_NAME'                => defined('DB_NAME')                ? (DB_NAME                ? 'SET' : 'EMPTY') : 'NOT_DEFINED',
];

// ── 7. Simulate saving a test message ─────────────────────────────────────────
// POST to this URL with ?action=inject&page_id=XXX&psid=YYY to test the chain
if (($_GET['action'] ?? '') === 'inject') {
    $pageId = trim($_GET['page_id'] ?? '');
    $psid   = trim($_GET['psid']   ?? 'test_psid_debug');
    if ($pageId) {
        $convs  = new ConversationService($db);
        $msgs   = new MessageService($db);
        $convId = $convs->ensureExists($pageId, $psid);
        $mid    = 'debug_mid_' . time();
        $saved  = $msgs->save($convId, $pageId, $psid, $mid, 'Debug test message ' . date('H:i:s'), false, null, null, date('Y-m-d H:i:s'));
        if ($saved) $convs->onIncomingMessage($pageId, $psid, 'Debug test message');
        $result['inject'] = [
            'conv_id' => $convId,
            'saved'   => $saved,
            'page_id' => $pageId,
            'psid'    => $psid,
        ];
    } else {
        $result['inject'] = 'ERROR: page_id required';
    }
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
