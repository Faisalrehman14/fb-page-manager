<?php
declare(strict_types=1);

/**
 * sync_history.php — Pull conversation list from Facebook (names + metadata only).
 *
 * Messages are NOT fetched here. They arrive in real-time via fb_webhook.php.
 *
 * POST body: { page_id, page_token }
 * Response:  { success: true, synced: N }
 */

set_time_limit(60);
ignore_user_abort(true);

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/src/Db.php';
require_once __DIR__ . '/src/FacebookClient.php';
require_once __DIR__ . '/src/ConversationService.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit(json_encode(['error' => 'Method not allowed']));
}

$raw       = file_get_contents('php://input') ?: '{}';
$body      = json_decode($raw, true) ?: [];
$pageId    = trim($body['page_id']    ?? '');
$pageToken = trim($body['page_token'] ?? '');

if (!$pageId || !$pageToken) {
    http_response_code(400);
    exit(json_encode(['error' => 'Missing page_id or page_token']));
}

try {
    $db = Db::get();
    Db::migrate();
} catch (Exception $e) {
    http_response_code(503);
    exit(json_encode(['error' => 'Database unavailable']));
}

$convs  = new ConversationService($db);
$fb     = new FacebookClient($pageToken);
$synced = 0;
$since  = time() - (30 * 24 * 3600); // last 30 days
$cursor = '';
$pages  = 0;

// ── Fetch conversation list from Facebook (max 5 pages × 50 = 250 conversations) ──
do {
    $data = $fb->getConversations($pageId, $since, $cursor);
    if (isset($data['error']) || empty($data['data'])) break;

    foreach ($data['data'] as $conv) {
        $fbConvId  = $conv['id'] ?? '';
        $snippet   = $conv['snippet'] ?? '';
        $updatedAt = !empty($conv['updated_time'])
            ? date('Y-m-d H:i:s', strtotime($conv['updated_time']))
            : null;

        // Find the customer (the participant who is NOT the page)
        $customer = null;
        foreach ($conv['participants']['data'] ?? [] as $p) {
            if ($p['id'] !== $pageId) { $customer = $p; break; }
        }
        if (!$customer) continue;

        $convs->upsert($pageId, $customer['id'], $fbConvId, $customer['name'] ?? 'User', $snippet, $updatedAt);
        $synced++;
    }

    $cursor = $data['paging']['cursors']['after'] ?? '';
    $next   = $data['paging']['next'] ?? null;
    $pages++;
} while ($next && $cursor && $pages < 5);

// ── Fetch profile pictures for conversations that are still missing one ────────
fetchMissingProfilePics($db, $fb, $pageId, $convs);

exit(json_encode(['success' => true, 'synced' => $synced]));

// ── Helper ────────────────────────────────────────────────────────────────────
function fetchMissingProfilePics(PDO $db, FacebookClient $fb, string $pageId, ConversationService $convs): void
{
    $stmt = $db->prepare(
        "SELECT fb_user_id FROM messenger_conversations
         WHERE page_id = ? AND (user_picture IS NULL OR user_picture = '')
         LIMIT 50"
    );
    $stmt->execute([$pageId]);
    $psids = $stmt->fetchAll(PDO::FETCH_COLUMN);

    foreach ($psids as $psid) {
        try {
            $info = $fb->getUserProfile($psid);
            if (!empty($info['name'])) {
                $convs->updateProfile($pageId, $psid, $info['name'], $info['profile_pic'] ?? null);
            }
        } catch (Exception $e) {
            error_log('[sync] profile pic error for ' . $psid . ': ' . $e->getMessage());
        }
    }
}
