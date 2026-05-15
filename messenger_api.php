<?php
declare(strict_types=1);

/**
 * messenger_api.php — HTTP router for the Messenger inbox.
 *
 * This file contains ONLY routing. All business logic lives in src/.
 *
 * GET  ?action=load_conversations  &page_id=
 * GET  ?action=load_messages       &page_id= &psid= [&limit=] [&before=]
 * GET  ?action=poll                &page_id= &since= [&psid=]
 * GET  ?action=search              &page_id= &q=
 * GET  ?action=unread_count        &page_id=
 * POST { action: send_message,     page_id, psid, message|image_url, page_token }
 * POST { action: mark_read,        page_id, psid }
 * POST { action: save_conversations, page_id, conversations: [] }
 * POST { action: fetch_user_name,  page_id, psid, page_token }
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/src/Db.php';
require_once __DIR__ . '/src/FacebookClient.php';
require_once __DIR__ . '/src/ConversationService.php';
require_once __DIR__ . '/src/MessageService.php';
require_once __DIR__ . '/src/PageService.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

function respond(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
try {
    $db = Db::get();
    Db::migrate();
} catch (Exception $e) {
    respond(['error' => 'Database unavailable'], 503);
}

$convs  = new ConversationService($db);
$msgs   = new MessageService($db);
$pages  = new PageService($db);
$method = $_SERVER['REQUEST_METHOD'];
$raw    = file_get_contents('php://input') ?: '{}';
$body   = json_decode($raw, true) ?: [];
$action = trim($_GET['action'] ?? $body['action'] ?? '');

// ── GET ──────────────────────────────────────────────────────────────────────
if ($method === 'GET') {

    if ($action === 'load_conversations') {
        $pageId = trim($_GET['page_id'] ?? '');
        if (!$pageId) respond(['error' => 'Missing page_id'], 400);
        respond(['conversations' => $convs->list($pageId)]);
    }

    if ($action === 'load_messages') {
        $pageId = trim($_GET['page_id'] ?? '');
        $psid   = trim($_GET['psid']    ?? '');
        $limit  = min(100, max(20, (int) ($_GET['limit'] ?? 50)));
        $before = trim($_GET['before']  ?? '') ?: null;
        if (!$pageId || !$psid) respond(['error' => 'Missing page_id or psid'], 400);
        $conv = $convs->findByPsid($pageId, $psid);
        if (!$conv) respond(['messages' => [], 'conv_id' => null]);
        respond([
            'messages' => $msgs->list((int) $conv['id'], $limit, $before),
            'conv_id'  => $conv['id'],
        ]);
    }

    if ($action === 'poll') {
        $pageId = trim($_GET['page_id'] ?? '');
        $since  = trim($_GET['since']   ?? '') ?: date('Y-m-d H:i:s', time() - 30);
        $psid   = trim($_GET['psid']    ?? '');
        if (!$pageId) respond(['error' => 'Missing page_id'], 400);

        $newMsgs = [];
        if ($psid) {
            $conv = $convs->findByPsid($pageId, $psid);
            if ($conv) $newMsgs = $msgs->newSince((int) $conv['id'], $since);
        }

        respond([
            'new_messages'  => $newMsgs,
            'updated_convs' => $convs->updatedSince($pageId, $since),
            'total_unread'  => $convs->totalUnread($pageId),
            'server_time'   => date('Y-m-d H:i:s'),
        ]);
    }

    if ($action === 'search') {
        $pageId = trim($_GET['page_id'] ?? '');
        $q      = trim($_GET['q']       ?? '');
        if (!$pageId || $q === '') respond(['conversations' => [], 'messages' => []]);
        respond([
            'conversations' => $convs->search($pageId, $q),
            'messages'      => $msgs->search($pageId, $q),
        ]);
    }

    if ($action === 'unread_count') {
        $pageId = trim($_GET['page_id'] ?? '');
        respond(['unread' => $convs->totalUnread($pageId)]);
    }

    respond(['error' => 'Unknown GET action: ' . $action], 400);
}

// ── POST ─────────────────────────────────────────────────────────────────────
if ($method === 'POST') {

    if ($action === 'send_message') {
        $pageId   = trim($body['page_id']    ?? '');
        $psid     = trim($body['psid']       ?? '');
        $text     = trim($body['message']    ?? '');
        $token    = trim($body['page_token'] ?? '');
        $imageUrl = trim($body['image_url']  ?? '');

        if (!$pageId || !$psid) respond(['error' => 'Missing required fields'], 400);
        if (!$text && !$imageUrl) respond(['error' => 'No message content'], 400);

        // Auto-register token in pages table; fall back to stored token if not supplied
        if ($token && $pageId) {
            $pages->upsert($pageId, $token);
        } elseif (!$token) {
            $token = $pages->findToken($pageId) ?? '';
        }
        if (!$token) respond(['error' => 'No page token available'], 400);

        $fb  = new FacebookClient($token);
        $res = $imageUrl ? $fb->sendImage($psid, $imageUrl) : $fb->sendText($psid, $text);

        if (isset($res['error'])) {
            respond(['error' => $res['error']['message'] ?? 'Facebook send failed'], 422);
        }

        $content = $imageUrl ? '[Image] ' . $imageUrl : $text;
        $now     = date('Y-m-d H:i:s');
        $convId  = $convs->ensureExists($pageId, $psid);

        $msgs->save($convId, $pageId, $psid, $res['message_id'] ?? null, $content, true, null, null, $now);
        $convs->onOutgoingMessage($pageId, $psid, $content);

        respond(['success' => true, 'message_id' => $res['message_id'] ?? '', 'saved_at' => $now, 'content' => $content]);
    }

    if ($action === 'mark_read') {
        $pageId = trim($body['page_id'] ?? '');
        $psid   = trim($body['psid']   ?? '');
        if (!$pageId || !$psid) respond(['error' => 'Missing fields'], 400);
        $convs->markRead($pageId, $psid);
        $msgs->markRead($pageId, $psid);
        respond(['success' => true]);
    }

    if ($action === 'save_conversations') {
        $pageId = trim($body['page_id'] ?? '');
        $list   = $body['conversations'] ?? [];
        if (!$pageId) respond(['error' => 'Missing page_id'], 400);
        foreach ($list as $c) {
            $convs->upsert($pageId, $c['psid'] ?? '', $c['fb_conv_id'] ?? null, $c['user_name'] ?? 'User', $c['last_message'] ?? '', null);
        }
        respond(['success' => true, 'saved' => count($list)]);
    }

    if ($action === 'fetch_user_name') {
        $pageId = trim($body['page_id']    ?? '');
        $psid   = trim($body['psid']       ?? '');
        $token  = trim($body['page_token'] ?? '');
        if (!$psid || !$token) respond(['error' => 'Missing fields'], 400);

        if ($token && $pageId) $pages->upsert($pageId, $token);

        $fb   = new FacebookClient($token);
        $info = $fb->getUserProfile($psid);
        if (!empty($info['name']) && $pageId) {
            $convs->updateProfile($pageId, $psid, $info['name'], $info['profile_pic'] ?? null);
        }
        respond(['success' => true, 'name' => $info['name'] ?? '', 'picture' => $info['profile_pic'] ?? null]);
    }

    respond(['error' => 'Unknown POST action: ' . $action], 400);
}

respond(['error' => 'Method not allowed'], 405);
