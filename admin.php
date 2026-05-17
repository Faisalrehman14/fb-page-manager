<?php
ob_start();
require_once 'config/load-env.php';
require_once 'config/validators.php';
require_once __DIR__ . '/config/rate_limit.php';
require_once 'db_config.php';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    requireCsrfToken();
}

$db = getDB();

function getSetting($db, $key, $default = '') {
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = ?");
    $stmt->execute([$key]);
    $v = $stmt->fetchColumn();
    return ($v !== false) ? $v : $default;
}
function setSetting($db, $key, $value) {
    $db->prepare("INSERT INTO settings (setting_key, setting_value) VALUES (?,?)
                  ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)")
       ->execute([$key, $value]);
}
function sanitizeHttpUrl(string $url): string {
    $trimmed = trim($url);
    if ($trimmed === '') return '';
    $validated = filter_var($trimmed, FILTER_VALIDATE_URL);
    if ($validated === false) return '';
    $parts = parse_url($validated);
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    if (!in_array($scheme, ['http', 'https'], true)) return '';
    return $validated;
}
function getAnnouncementPayload(PDO $db): array {
    $enabled = getSetting($db, 'announcement_enabled', '0') === '1';
    $type = strtolower(trim(getSetting($db, 'announcement_type', 'text')));
    if (!in_array($type, ['text', 'image', 'video'], true)) {
        $type = 'text';
    }

    $text = trim(getSetting($db, 'announcement_text', ''));
    if (strlen($text) > 280) {
        $text = substr($text, 0, 280);
    }

    $mediaUrl = sanitizeHttpUrl(getSetting($db, 'announcement_media_url', ''));
    $linkUrl = sanitizeHttpUrl(getSetting($db, 'announcement_link_url', ''));

    return [
        'enabled' => $enabled,
        'type' => $type,
        'text' => $text,
        'media_url' => $mediaUrl,
        'link_url' => $linkUrl,
        'active' => $enabled && ($text !== '' || $mediaUrl !== ''),
    ];
}
function jsonOut($data, $code = 200) {
    if (ob_get_length()) ob_clean();
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}
function getClientIp(): string {
    $candidates = [];

    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
        $candidates[] = $_SERVER['HTTP_CF_CONNECTING_IP'];
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        if (!empty($parts[0])) {
            $candidates[] = trim($parts[0]);
        }
    }
    if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
        $candidates[] = $_SERVER['HTTP_X_REAL_IP'];
    }
    $candidates[] = $_SERVER['REMOTE_ADDR'] ?? '';

    foreach ($candidates as $ip) {
        $valid = filter_var(trim((string)$ip), FILTER_VALIDATE_IP);
        if ($valid) {
            return $valid;
        }
    }
    return 'unknown';
}
function requireAuth() {
    if (empty($_SESSION['fbcast_admin'])) {
        jsonOut(['error' => 'Unauthorized'], 401);
    }
    $ipCheckEnabled = defined('SESSION_IP_CHECK') ? (bool)SESSION_IP_CHECK : true;
    if (!$ipCheckEnabled) {
        return;
    }
    $currentIp = getClientIp();
    $sessionIp = $_SESSION['fbcast_admin_ip'] ?? '';
    if ($sessionIp && !hash_equals((string)$sessionIp, (string)$currentIp)) {
        session_destroy();
        jsonOut(['error' => 'Session validation failed. Please log in again.'], 401);
    }
}
function checkExpiredSubscriptions($db, $freeLimit) {
    try {
        $db->prepare("UPDATE users SET plan='free', messages_limit=?, messages_used=0
                      WHERE subscription_expires IS NOT NULL AND subscription_expires != ''
                      AND subscription_expires < NOW() AND plan != 'free'")
           ->execute([$freeLimit]);
    } catch(Exception $e) {}
}

// Brute-force lockout: 5 failed attempts = 15-minute lockout (session-keyed by IP)
define('ADMIN_MAX_ATTEMPTS', 5);
define('ADMIN_LOCKOUT_SECONDS', 900); // 15 minutes

function getAdminLockoutKey(): string {
    $ip = getClientIp();
    return 'admin_brute_' . md5($ip);
}
function checkAdminLockout(): bool {
    $key = getAdminLockoutKey();
    $data = $_SESSION[$key] ?? null;
    if (!$data) return false;
    if ((time() - ($data['since'] ?? 0)) > ADMIN_LOCKOUT_SECONDS) {
        unset($_SESSION[$key]);
        return false;
    }
    return ($data['count'] ?? 0) >= ADMIN_MAX_ATTEMPTS;
}
function recordAdminFailure(): void {
    $key  = getAdminLockoutKey();
    $data = $_SESSION[$key] ?? ['count' => 0, 'since' => time()];
    if ((time() - ($data['since'] ?? 0)) > ADMIN_LOCKOUT_SECONDS) {
        $data = ['count' => 0, 'since' => time()];
    }
    $data['count']++;
    $_SESSION[$key] = $data;
}
function clearAdminFailures(): void {
    unset($_SESSION[getAdminLockoutKey()]);
}
function getUsersColumns(PDO $db): array {
    static $cols = null;
    if ($cols !== null) return $cols;
    $cols = [];
    try {
        $rows = $db->query("SHOW COLUMNS FROM users")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) {
            $name = (string)($r['Field'] ?? '');
            if ($name !== '') $cols[$name] = true;
        }
    } catch (Exception $e) {}
    return $cols;
}
function userCol(PDO $db, string $preferred, string $legacy): string {
    $cols = getUsersColumns($db);
    if (isset($cols[$preferred])) return $preferred;
    if (isset($cols[$legacy])) return $legacy;
    return $preferred;
}

$action = $_GET['action'] ?? '';

if ($action === 'login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $ip = getClientIp();
    if (!rateLimitCheck('admin_login:' . $ip, 10, 300)) {
        jsonOut(['error' => 'Too many login attempts. Please wait and try again.'], 429);
    }

    if (checkAdminLockout()) {
        jsonOut(['error' => 'Too many failed attempts. Try again in 15 minutes.'], 429);
    }
    $body        = json_decode(get_raw_input(), true) ?: [];
    $password    = trim($body['password'] ?? '');
    $stored_hash = getSetting($db, 'admin_password', ADMIN_PASSWORD_HASH);
    if (!$stored_hash) jsonOut(['error' => 'Admin password not configured.'], 500);
    if ($password && password_verify($password, $stored_hash)) {
        clearAdminFailures();
        session_regenerate_id(true);
        $_SESSION['fbcast_admin'] = true;
        $_SESSION['fbcast_admin_ip'] = getClientIp();
        try {
            $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES ('admin', 'admin_login', ?)")
               ->execute(['IP: ' . ($_SESSION['fbcast_admin_ip'] ?? 'unknown')]);
        } catch (Exception $e) {}
        jsonOut(['success' => true]);
    } else {
        recordAdminFailure();
        $key   = getAdminLockoutKey();
        $fails = $_SESSION[$key]['count'] ?? 1;
        $left  = max(0, ADMIN_MAX_ATTEMPTS - $fails);
        $msg   = $left > 0 ? "Incorrect password. {$left} attempt(s) remaining." : 'Too many failed attempts. Locked for 15 minutes.';
        jsonOut(['error' => $msg], 401);
    }
}

if ($action === 'logout') {
    session_destroy();
    header('Location: admin.php');
    exit;
}

if ($action === 'announcement') {
    $payload = getAnnouncementPayload($db);
    jsonOut(['success' => true] + $payload);
}

if ($action === 'stats') {
    requireAuth();
    try {
        $planCol = userCol($db, 'plan', 'subscriptionStatus');
        $usedCol = userCol($db, 'messages_used', 'messagesUsed');
        $totalUsers = (int)$db->query("SELECT COUNT(*) FROM users")->fetchColumn();
        $freeUsers = (int)$db->query("SELECT COUNT(*) FROM users WHERE $planCol='free'")->fetchColumn();
        $paidUsers = (int)$db->query("SELECT COUNT(*) FROM users WHERE $planCol!='free'")->fetchColumn();
        $sumSent   = $db->query("SELECT SUM($usedCol) FROM users")->fetchColumn();
        $totalSent = (int)($sumSent ?: 0);
        $todayLogins = 0; $todaySent = 0;
        try {
            $todayLogins = (int)$db->query("SELECT COUNT(*) FROM activity_log WHERE action='login' AND DATE(created_at)=CURDATE()")->fetchColumn();
            $todaySent   = (int)$db->query("SELECT COUNT(*) FROM activity_log WHERE action='send' AND DATE(created_at)=CURDATE()")->fetchColumn();
        } catch (Exception $e) {}

        $monthLogins=$totalLogins=$todayRevenueCents=$monthRevenueCents=$totalRevenueCents=0;
        $todayTransactions=$monthTransactions=$totalTransactions=0;
        $monthBasicTx=$monthProTx=$todayBasicTx=$todayProTx=$totalBasicTx=$totalProTx=0;
        $dailyRevenue = []; $paidEvents = [];

        $basicCents = (int)(STRIPE_PLANS['basic']['amount'] ?? 0);
        $proCents   = (int)(STRIPE_PLANS['pro']['amount'] ?? 0);
        $detailLc   = "LOWER(COALESCE(detail,''))";
        $isBasic    = "($detailLc LIKE '%basic%')";
        $isPro      = "($detailLc LIKE '%pro%')";
        $paidAction = "action IN ('payment','renewal','subscription')";
        $isPaidPlan = "($isBasic OR $isPro)";
        $validPaid  = "($paidAction AND $isPaidPlan AND $detailLc NOT LIKE '%cancelled%')";
        $revCase    = "CASE WHEN $isPro THEN $proCents WHEN $isBasic THEN $basicCents ELSE 0 END";

        try {
            $sql = "SELECT
              SUM(CASE WHEN action='login' THEN 1 ELSE 0 END) AS total_logins,
              SUM(CASE WHEN action='login' AND DATE(created_at)=CURDATE() THEN 1 ELSE 0 END) AS today_logins,
              SUM(CASE WHEN action='login' AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) THEN 1 ELSE 0 END) AS month_logins,
              SUM(CASE WHEN $validPaid THEN $revCase ELSE 0 END) AS total_revenue_cents,
              SUM(CASE WHEN $validPaid AND DATE(created_at)=CURDATE() THEN $revCase ELSE 0 END) AS today_revenue_cents,
              SUM(CASE WHEN $validPaid AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) THEN $revCase ELSE 0 END) AS month_revenue_cents,
              SUM(CASE WHEN $validPaid THEN 1 ELSE 0 END) AS total_transactions,
              SUM(CASE WHEN $validPaid AND DATE(created_at)=CURDATE() THEN 1 ELSE 0 END) AS today_transactions,
              SUM(CASE WHEN $validPaid AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) THEN 1 ELSE 0 END) AS month_transactions,
              SUM(CASE WHEN $validPaid AND $isBasic THEN 1 ELSE 0 END) AS total_basic_tx,
              SUM(CASE WHEN $validPaid AND $isPro THEN 1 ELSE 0 END) AS total_pro_tx,
              SUM(CASE WHEN $validPaid AND DATE(created_at)=CURDATE() AND $isBasic THEN 1 ELSE 0 END) AS today_basic_tx,
              SUM(CASE WHEN $validPaid AND DATE(created_at)=CURDATE() AND $isPro THEN 1 ELSE 0 END) AS today_pro_tx,
              SUM(CASE WHEN $validPaid AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) AND $isBasic THEN 1 ELSE 0 END) AS month_basic_tx,
              SUM(CASE WHEN $validPaid AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) AND $isPro THEN 1 ELSE 0 END) AS month_pro_tx
            FROM activity_log";
            $a = $db->query($sql)->fetch(PDO::FETCH_ASSOC) ?: [];
            $totalLogins=$a['total_logins']??0; $todayLogins=$a['today_logins']??$todayLogins; $monthLogins=$a['month_logins']??0;
            $totalRevenueCents=$a['total_revenue_cents']??0; $todayRevenueCents=$a['today_revenue_cents']??0; $monthRevenueCents=$a['month_revenue_cents']??0;
            $totalTransactions=$a['total_transactions']??0; $todayTransactions=$a['today_transactions']??0; $monthTransactions=$a['month_transactions']??0;
            $totalBasicTx=$a['total_basic_tx']??0; $totalProTx=$a['total_pro_tx']??0;
            $todayBasicTx=$a['today_basic_tx']??0; $todayProTx=$a['today_pro_tx']??0;
            $monthBasicTx=$a['month_basic_tx']??0; $monthProTx=$a['month_pro_tx']??0;
        } catch (Exception $e) {}

        try {
            $rows = $db->query("SELECT DATE(created_at) AS day, SUM($revCase) AS revenue_cents,
              SUM(CASE WHEN $isPaidPlan THEN 1 ELSE 0 END) AS transactions,
              SUM(CASE WHEN $isBasic THEN 1 ELSE 0 END) AS basic_tx,
              SUM(CASE WHEN $isPro THEN 1 ELSE 0 END) AS pro_tx
            FROM activity_log WHERE $paidAction AND $detailLc NOT LIKE '%cancelled%'
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
            GROUP BY DATE(created_at) ORDER BY day ASC")->fetchAll(PDO::FETCH_ASSOC) ?: [];
            foreach ($rows as $r) {
                $dailyRevenue[] = ['day'=>$r['day'],'revenue'=>round((int)($r['revenue_cents']??0)/100,2),'transactions'=>(int)($r['transactions']??0),'basic'=>(int)($r['basic_tx']??0),'pro'=>(int)($r['pro_tx']??0)];
            }
        } catch (Exception $e) {}

        // 7-day totals
        $week7RevenueCents=0; $week7Transactions=0; $week7Logins=0; $week7BasicTx=0; $week7ProTx=0;
        try {
            $w7 = $db->query("SELECT
              SUM(CASE WHEN action='login' THEN 1 ELSE 0 END) AS logins,
              SUM(CASE WHEN $validPaid THEN $revCase ELSE 0 END) AS revenue_cents,
              SUM(CASE WHEN $validPaid THEN 1 ELSE 0 END) AS transactions,
              SUM(CASE WHEN $validPaid AND $isBasic THEN 1 ELSE 0 END) AS basic_tx,
              SUM(CASE WHEN $validPaid AND $isPro THEN 1 ELSE 0 END) AS pro_tx
              FROM activity_log WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)")->fetch(PDO::FETCH_ASSOC) ?: [];
            $week7RevenueCents=$w7['revenue_cents']??0; $week7Transactions=(int)($w7['transactions']??0);
            $week7Logins=(int)($w7['logins']??0); $week7BasicTx=(int)($w7['basic_tx']??0); $week7ProTx=(int)($w7['pro_tx']??0);
        } catch(Exception $e) {}

        // weekly revenue last 12 weeks
        $weeklyRevenue = [];
        try {
            $wrows = $db->query("SELECT YEARWEEK(created_at,1) AS yw, MIN(DATE(created_at)) AS week_start,
              SUM($revCase) AS revenue_cents,
              SUM(CASE WHEN $isPaidPlan THEN 1 ELSE 0 END) AS transactions
              FROM activity_log WHERE $paidAction AND $detailLc NOT LIKE '%cancelled%'
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL 12 WEEK)
              GROUP BY YEARWEEK(created_at,1) ORDER BY yw ASC LIMIT 12")->fetchAll(PDO::FETCH_ASSOC) ?: [];
            foreach ($wrows as $r) {
                $weeklyRevenue[] = ['week_start'=>$r['week_start'],'revenue'=>round((int)($r['revenue_cents']??0)/100,2),'transactions'=>(int)($r['transactions']??0)];
            }
        } catch(Exception $e) {}

        // monthly revenue last 12 months
        $monthlyRevenue = [];
        try {
            $mrows = $db->query("SELECT DATE_FORMAT(created_at,'%Y-%m') AS month,
              SUM($revCase) AS revenue_cents,
              SUM(CASE WHEN $isPaidPlan THEN 1 ELSE 0 END) AS transactions
              FROM activity_log WHERE $paidAction AND $detailLc NOT LIKE '%cancelled%'
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
              GROUP BY DATE_FORMAT(created_at,'%Y-%m') ORDER BY month ASC")->fetchAll(PDO::FETCH_ASSOC) ?: [];
            foreach ($mrows as $r) {
                $monthlyRevenue[] = ['month'=>$r['month'],'revenue'=>round((int)($r['revenue_cents']??0)/100,2),'transactions'=>(int)($r['transactions']??0)];
            }
        } catch(Exception $e) {}

        // paid events with email (fallback without)
        try {
            $evRows = $db->query("SELECT al.created_at, al.fb_user_id,
              COALESCE(NULLIF(u.fb_name,''),al.fb_user_id) AS fb_name,
              COALESCE(u.email,'') AS email,
              al.action,
              CASE WHEN LOWER(COALESCE(al.detail,'')) LIKE '%pro%' THEN 'pro'
                   WHEN LOWER(COALESCE(al.detail,'')) LIKE '%basic%' THEN 'basic' ELSE 'unknown' END AS plan,
              CASE WHEN LOWER(COALESCE(al.detail,'')) LIKE '%pro%' THEN $proCents
                   WHEN LOWER(COALESCE(al.detail,'')) LIKE '%basic%' THEN $basicCents ELSE 0 END AS amount_cents
            FROM activity_log al LEFT JOIN users u ON u.fb_user_id=al.fb_user_id
            WHERE al.action IN ('payment','renewal','subscription')
              AND (LOWER(COALESCE(al.detail,'')) LIKE '%basic%' OR LOWER(COALESCE(al.detail,'')) LIKE '%pro%')
              AND LOWER(COALESCE(al.detail,'')) NOT LIKE '%cancelled%'
              AND al.created_at >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
            ORDER BY al.created_at DESC LIMIT 500")->fetchAll(PDO::FETCH_ASSOC) ?: [];
            foreach ($evRows as $r) {
                $paidEvents[] = ['created_at'=>$r['created_at'],'fb_user_id'=>$r['fb_user_id'],'fb_name'=>$r['fb_name'],'email'=>$r['email']??'','action'=>$r['action'],'plan'=>$r['plan'],'amount'=>round((int)($r['amount_cents']??0)/100,2)];
            }
        } catch (Exception $e) {
            try {
                $evRows = $db->query("SELECT al.created_at, al.fb_user_id,
                  COALESCE(NULLIF(u.fb_name,''),al.fb_user_id) AS fb_name, '' AS email, al.action,
                  CASE WHEN LOWER(COALESCE(al.detail,'')) LIKE '%pro%' THEN 'pro'
                       WHEN LOWER(COALESCE(al.detail,'')) LIKE '%basic%' THEN 'basic' ELSE 'unknown' END AS plan,
                  CASE WHEN LOWER(COALESCE(al.detail,'')) LIKE '%pro%' THEN $proCents
                       WHEN LOWER(COALESCE(al.detail,'')) LIKE '%basic%' THEN $basicCents ELSE 0 END AS amount_cents
                FROM activity_log al LEFT JOIN users u ON u.fb_user_id=al.fb_user_id
                WHERE al.action IN ('payment','renewal','subscription')
                  AND (LOWER(COALESCE(al.detail,'')) LIKE '%basic%' OR LOWER(COALESCE(al.detail,'')) LIKE '%pro%')
                  AND LOWER(COALESCE(al.detail,'')) NOT LIKE '%cancelled%'
                  AND al.created_at >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
                ORDER BY al.created_at DESC LIMIT 500")->fetchAll(PDO::FETCH_ASSOC) ?: [];
                foreach ($evRows as $r) {
                    $paidEvents[] = ['created_at'=>$r['created_at'],'fb_user_id'=>$r['fb_user_id'],'fb_name'=>$r['fb_name'],'email'=>'','action'=>$r['action'],'plan'=>$r['plan'],'amount'=>round((int)($r['amount_cents']??0)/100,2)];
                }
            } catch(Exception $e2) {}
        }

        jsonOut([
            'total_users'=>$totalUsers,'free_users'=>$freeUsers,'paid_users'=>$paidUsers,
            'total_sent'=>$totalSent,'today_logins'=>(int)$todayLogins,'month_logins'=>(int)$monthLogins,
            'total_logins'=>(int)$totalLogins,'today_sends'=>$todaySent,
            'free_limit'=>(int)getSetting($db,'free_limit','2000'),
            'today_revenue'=>round($todayRevenueCents/100,2),'month_revenue'=>round($monthRevenueCents/100,2),
            'total_revenue'=>round($totalRevenueCents/100,2),
            'today_transactions'=>(int)$todayTransactions,'month_transactions'=>(int)$monthTransactions,
            'total_transactions'=>(int)$totalTransactions,
            'week7_revenue'=>round($week7RevenueCents/100,2),'week7_transactions'=>$week7Transactions,
            'week7_logins'=>$week7Logins,
            'plan_breakdown_today'=>['basic'=>(int)$todayBasicTx,'pro'=>(int)$todayProTx],
            'plan_breakdown_week7'=>['basic'=>$week7BasicTx,'pro'=>$week7ProTx],
            'plan_breakdown_month'=>['basic'=>(int)$monthBasicTx,'pro'=>(int)$monthProTx],
            'plan_breakdown_total'=>['basic'=>(int)$totalBasicTx,'pro'=>(int)$totalProTx],
            'daily_revenue'=>$dailyRevenue,'weekly_revenue'=>$weeklyRevenue,'monthly_revenue'=>$monthlyRevenue,
            'paid_events'=>$paidEvents,
            'server_today'=>date('Y-m-d'),'server_month'=>date('Y-m'),
        ]);
    } catch (Exception $e) {
        jsonOut(['error'=>'Failed to load stats.'],500);
    }
}

if ($action === 'users') {
    requireAuth();
    try {
        $planCol  = userCol($db, 'plan', 'subscriptionStatus');
        $limitCol = userCol($db, 'messages_limit', 'messageLimit');
        $usedCol  = userCol($db, 'messages_used', 'messagesUsed');
        $search  = trim($_GET['q'] ?? '');
        $page    = max(1,(int)($_GET['p']??1));
        $perPage = 25;
        $offset  = ($page-1)*$perPage;
        $where   = $search ? "WHERE fb_name LIKE ? OR fb_user_id LIKE ?" : '';
        $params  = $search ? ["%$search%","%$search%"] : [];
        $countStmt = $db->prepare("SELECT COUNT(*) FROM users $where");
        $countStmt->execute($params);
        $total = (int)$countStmt->fetchColumn();
        $orderBy = "fb_user_id DESC";
        try { $db->query("SELECT last_login FROM users LIMIT 1"); $orderBy="last_login DESC"; } catch(Exception $e){}
        $stmt = $db->prepare("SELECT * FROM users $where ORDER BY $orderBy LIMIT $perPage OFFSET $offset");
        $stmt->execute($params);
        $users = $stmt->fetchAll();
        foreach ($users as &$u) {
            $used = (int)($u[$usedCol] ?? 0);
            $limit = (int)($u[$limitCol] ?? 0);
            $plan = (string)($u[$planCol] ?? 'free');
            $u['remaining']=(int)max(0,$limit-$used); $u['messagesUsed']=(int)$used; $u['messageLimit']=(int)$limit;
            $u['subscriptionStatus']=$plan; $u['messages_used']=(int)$used; $u['messages_limit']=(int)$limit; $u['plan']=$plan;
        }
        jsonOut(['users'=>$users,'total'=>$total,'page'=>$page,'per_page'=>$perPage]);
    } catch (Exception $e) { jsonOut(['error'=>'Failed to load users.'],500); }
}

if ($action === 'export_users') {
    requireAuth();
    try {
        $planCol  = userCol($db, 'plan', 'subscriptionStatus');
        $limitCol = userCol($db, 'messages_limit', 'messageLimit');
        $usedCol  = userCol($db, 'messages_used', 'messagesUsed');
        if (ob_get_length()) ob_clean();
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="fbcast_users_' . date('Y-m-d') . '.csv"');
        $orderBy = "fb_user_id DESC";
        try { $db->query("SELECT last_login FROM users LIMIT 1"); $orderBy="last_login DESC"; } catch(Exception $e){}
        $rows = $db->query("SELECT fb_user_id, fb_name,
            COALESCE($planCol, 'free') AS plan,
            COALESCE($usedCol, 0) AS messages_used,
            COALESCE($limitCol, 0) AS messages_limit,
            COALESCE(first_login, created_at, '') AS first_login,
            COALESCE(last_login, '') AS last_login,
            COALESCE(subscription_expires, '') AS subscription_expires
            FROM users ORDER BY $orderBy")->fetchAll(PDO::FETCH_ASSOC);
        $out = fopen('php://output','w');
        fputcsv($out,['FB User ID','Name','Plan','Messages Used','Message Limit','Remaining','First Login','Last Login','Sub Expires']);
        foreach ($rows as $r) {
            fputcsv($out,[$r['fb_user_id'],$r['fb_name'],$r['plan'],(int)$r['messages_used'],(int)$r['messages_limit'],max(0,(int)$r['messages_limit']-(int)$r['messages_used']),$r['first_login'],$r['last_login'],$r['subscription_expires']]);
        }
        fclose($out);
        exit;
    } catch (Exception $e) { http_response_code(500); echo 'Export failed'; exit; }
}

if ($action === 'bulk_update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    requireCsrfToken();
    $planCol = userCol($db, 'plan', 'subscriptionStatus');
    $limitCol = userCol($db, 'messages_limit', 'messageLimit');
    $usedCol = userCol($db, 'messages_used', 'messagesUsed');
    $body  = json_decode(get_raw_input(), true) ?: [];
    $ids   = $body['ids'] ?? [];
    $plan  = $body['plan'] ?? null;
    $limit = isset($body['limit']) ? (int)$body['limit'] : null;
    if (empty($ids) || !is_array($ids)) jsonOut(['error'=>'No users selected'],400);
    $ids = array_filter(array_map(fn($id)=>validateFbId($id), $ids));
    if (empty($ids)) jsonOut(['error'=>'Invalid user IDs'],400);
    $placeholders = implode(',',array_fill(0,count($ids),'?'));
    $updated = 0;
    try {
        if ($plan && in_array($plan,['free','basic','pro'])) {
            $vals = array_values($ids);
            $stmt = $db->prepare("UPDATE users SET $planCol=? WHERE fb_user_id IN ($placeholders)");
            $stmt->execute(array_merge([$plan],$vals));
            $updated = $stmt->rowCount();
        }
        if ($limit !== null && $limit >= 0) {
            $vals = array_values($ids);
            $db->prepare("UPDATE users SET $limitCol=? WHERE fb_user_id IN ($placeholders)")->execute(array_merge([$limit],$vals));
        }
        if (isset($body['reset_quota']) && $body['reset_quota']) {
            $vals = array_values($ids);
            $db->prepare("UPDATE users SET $usedCol=0 WHERE fb_user_id IN ($placeholders)")->execute($vals);
        }
        jsonOut(['success'=>true,'count'=>count($ids)]);
    } catch (Exception $e) { jsonOut(['error'=>'Bulk update failed: '.$e->getMessage()],500); }
}

if ($action === 'update_user' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    requireCsrfToken();
    $planCol = userCol($db, 'plan', 'subscriptionStatus');
    $limitCol = userCol($db, 'messages_limit', 'messageLimit');
    $usedCol = userCol($db, 'messages_used', 'messagesUsed');
    $body  = json_decode(get_raw_input(), true) ?: [];
    $fbId  = validateFbId($body['fb_user_id'] ?? '');
    $plan  = $body['subscriptionStatus'] ?? $body['plan'] ?? null;
    $limit = isset($body['messageLimit']) ? (int)$body['messageLimit'] : (isset($body['messages_limit']) ? (int)$body['messages_limit'] : null);
    if (!$fbId) jsonOut(['error'=>'Invalid or missing fb_user_id'],400);
    $sets=[]; $vals=[];
    if ($plan && in_array($plan,['free','basic','pro'])) { $sets[]="$planCol = ?"; $vals[]=$plan; }
    if ($limit!==null && $limit>=0) { $sets[]="$limitCol = ?"; $vals[]=$limit; }
    if (isset($body['messagesUsed'])||isset($body['messages_used'])) { $sets[]="$usedCol = ?"; $vals[]=max(0,(int)($body['messagesUsed']??$body['messages_used'])); }
    if (isset($body['subscription_expires'])) { $sets[]='subscription_expires = ?'; $vals[]=$body['subscription_expires']?:null; }
    if (empty($sets)) jsonOut(['error'=>'Nothing to update'],400);
    $vals[]=$fbId;
    try { $db->prepare("UPDATE users SET ".implode(', ',$sets)." WHERE fb_user_id = ?")->execute($vals); }
    catch (Exception $e) { jsonOut(['error'=>'Update failed: '.$e->getMessage()],500); }
    jsonOut(['success'=>true]);
}

if ($action === 'reset_quota' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    requireCsrfToken();
    $usedCol = userCol($db, 'messages_used', 'messagesUsed');
    $body=$json=json_decode(get_raw_input(),true)?:[];
    $fbId=validateFbId($body['fb_user_id']??'');
    if (!$fbId) jsonOut(['error'=>'Invalid fb_user_id'],400);
    $db->prepare("UPDATE users SET $usedCol=0 WHERE fb_user_id=?")->execute([$fbId]);
    jsonOut(['success'=>true]);
}

if ($action === 'update_settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    requireCsrfToken();
    $body=json_decode(get_raw_input(),true)?:[];
    if (isset($body['free_limit'])) setSetting($db,'free_limit',(string)max(1,(int)$body['free_limit']));
    if (!empty($body['admin_password'])) {
        $np=trim($body['admin_password']);
        if (strlen($np)<8) jsonOut(['error'=>'Password must be at least 8 characters'],400);
        setSetting($db,'admin_password',password_hash($np,PASSWORD_BCRYPT,['cost'=>12]));
    }
    if (!empty($body['site_name'])) setSetting($db,'site_name',trim($body['site_name']));
    if (isset($body['announcement_enabled'])) {
        setSetting($db, 'announcement_enabled', !empty($body['announcement_enabled']) ? '1' : '0');
    }
    if (isset($body['announcement_type'])) {
        $annType = strtolower(trim((string)$body['announcement_type']));
        if (!in_array($annType, ['text', 'image', 'video'], true)) {
            jsonOut(['error' => 'Invalid announcement type'], 400);
        }
        setSetting($db, 'announcement_type', $annType);
    }
    if (isset($body['announcement_text'])) {
        $annText = trim((string)$body['announcement_text']);
        if (strlen($annText) > 280) {
            $annText = substr($annText, 0, 280);
        }
        setSetting($db, 'announcement_text', $annText);
    }
    if (isset($body['announcement_media_url'])) {
        $mediaUrlRaw = trim((string)$body['announcement_media_url']);
        $mediaUrl = sanitizeHttpUrl($mediaUrlRaw);
        if ($mediaUrlRaw !== '' && $mediaUrl === '') {
            jsonOut(['error' => 'Media URL must be a valid http/https URL'], 400);
        }
        setSetting($db, 'announcement_media_url', $mediaUrl);
    }
    if (isset($body['announcement_link_url'])) {
        $linkUrlRaw = trim((string)$body['announcement_link_url']);
        $linkUrl = sanitizeHttpUrl($linkUrlRaw);
        if ($linkUrlRaw !== '' && $linkUrl === '') {
            jsonOut(['error' => 'Link URL must be a valid http/https URL'], 400);
        }
        setSetting($db, 'announcement_link_url', $linkUrl);
    }
    jsonOut(['success'=>true]);
}

if ($action === 'activity') {
    requireAuth();
    try {
        $page=$_GET['p']??1; $perPage=30; $offset=(max(1,(int)$page)-1)*$perPage;
        $filter=$_GET['filter']??'';
        $where=$filter&&$filter!=='all' ? "WHERE al.action=?" : '';
        $params=$filter&&$filter!=='all' ? [$filter] : [];
        $total=(int)$db->prepare("SELECT COUNT(*) FROM activity_log al $where")->execute($params)&&$db->query("SELECT FOUND_ROWS()")->fetchColumn();
        $countStmt=$db->prepare("SELECT COUNT(*) FROM activity_log al $where"); $countStmt->execute($params); $total=(int)$countStmt->fetchColumn();
        $stmt=$db->prepare("SELECT al.*, COALESCE(u.fb_name,al.fb_user_id) AS fb_name FROM activity_log al LEFT JOIN users u ON u.fb_user_id=al.fb_user_id $where ORDER BY al.created_at DESC LIMIT $perPage OFFSET $offset");
        $stmt->execute($params);
        jsonOut(['rows'=>$stmt->fetchAll(PDO::FETCH_ASSOC),'total'=>$total,'page'=>(int)$page,'per_page'=>$perPage]);
    } catch (Exception $e) { jsonOut(['error'=>'Failed to load activity log.'],500); }
}

if ($action === 'grant_unlimited' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    $planCol = userCol($db, 'plan', 'subscriptionStatus');
    $limitCol = userCol($db, 'messages_limit', 'messageLimit');
    $usedCol = userCol($db, 'messages_used', 'messagesUsed');
    $body=json_decode(get_raw_input(),true)?:[];
    $fbId=validateFbId($body['fb_user_id']??'');
    if (!$fbId) jsonOut(['error'=>'Invalid fb_user_id'],400);
    $db->prepare("UPDATE users SET $planCol='pro',$limitCol=999999999,$usedCol=0 WHERE fb_user_id=?")->execute([$fbId]);
    jsonOut(['success'=>true]);
}

if ($action === 'delete_user' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAuth();
    $body=json_decode(get_raw_input(),true)?:[];
    $fbId=validateFbId($body['fb_user_id']??'');
    if (!$fbId) jsonOut(['error'=>'Invalid fb_user_id'],400);
    $db->prepare("DELETE FROM users WHERE fb_user_id=?")->execute([$fbId]);
    $db->prepare("DELETE FROM activity_log WHERE fb_user_id=?")->execute([$fbId]);
    jsonOut(['success'=>true]);
}

$isLoggedIn=!empty($_SESSION['fbcast_admin']);
$freeLimit=(int)getSetting($db,'free_limit','2000');
$announcementEnabled = getSetting($db, 'announcement_enabled', '0') === '1';
$announcementType = strtolower(trim(getSetting($db, 'announcement_type', 'text')));
if (!in_array($announcementType, ['text', 'image', 'video'], true)) {
    $announcementType = 'text';
}
$announcementText = trim(getSetting($db, 'announcement_text', ''));
if (strlen($announcementText) > 280) {
    $announcementText = substr($announcementText, 0, 280);
}
$announcementMediaUrl = sanitizeHttpUrl(getSetting($db, 'announcement_media_url', ''));
$announcementLinkUrl = sanitizeHttpUrl(getSetting($db, 'announcement_link_url', ''));
$csrfToken=getCsrfToken();
if ($isLoggedIn) checkExpiredSubscriptions($db, $freeLimit);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>FBCast Admin</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/images/castpro2.png">
<link rel="apple-touch-icon" href="/images/castpro2.png">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060910;--bg2:#0c1018;--bg3:#111827;--bg4:#161d2a;
  --border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.11);
  --text:#e8eaf0;--text2:#8b95a8;--text3:#4b5563;
  --blue:#1877f2;--blue2:#3b82f6;--blue-dim:rgba(24,119,242,.12);
  --green:#22c55e;--red:#ef4444;--amber:#f59e0b;--purple:#7c3aed;
  --radius:10px;--radius-lg:14px;
  --shadow:0 4px 24px rgba(0,0,0,.45);
}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased;font-size:14px}
a{text-decoration:none;color:inherit}

/* ─── LOGIN ─── */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;
  background:radial-gradient(ellipse 60% 50% at 50% 0%,rgba(24,119,242,.08),transparent)}
.login-card{background:var(--bg2);border:1px solid var(--border2);border-radius:20px;padding:48px 40px;width:100%;max-width:400px;text-align:center;box-shadow:var(--shadow)}
.login-logo{width:60px;height:60px;background:linear-gradient(135deg,#1877f2,#7c3aed);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 22px;box-shadow:0 4px 20px rgba(24,119,242,.3)}
.login-card h1{font-size:22px;font-weight:800;margin-bottom:6px;letter-spacing:-.4px}
.login-card p{color:var(--text2);font-size:13px;margin-bottom:30px}
.login-card input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:14px;padding:13px 16px;border-radius:var(--radius);margin-bottom:12px;outline:none;transition:border .2s}
.login-card input:focus{border-color:var(--blue);background:rgba(24,119,242,.04)}
.login-card button{width:100%;background:var(--blue);color:#fff;font-family:inherit;font-size:14px;font-weight:700;padding:13px;border:none;border-radius:var(--radius);cursor:pointer;transition:opacity .2s,transform .15s}
.login-card button:hover{opacity:.88;transform:translateY(-1px)}
.login-err{color:var(--red);font-size:12px;margin-top:10px;display:none;padding:8px 12px;background:rgba(239,68,68,.08);border-radius:8px;border:1px solid rgba(239,68,68,.18)}

/* ─── LAYOUT ─── */
.layout{display:flex;min-height:100vh}

/* ─── SIDEBAR ─── */
.sidebar{width:232px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;position:sticky;top:0;height:100vh;overflow-y:auto}
.sb-brand{display:flex;align-items:center;gap:10px;padding:22px 18px;border-bottom:1px solid var(--border)}
.sb-brand-icon{width:36px;height:36px;background:linear-gradient(135deg,var(--blue),var(--purple));border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:15px;color:#fff;flex-shrink:0}
.sb-brand-name{font-size:14px;font-weight:800;letter-spacing:-.3px}
.sb-brand-name span{color:#60a5fa}
.sb-brand-sub{font-size:10px;color:var(--text3);font-weight:500;margin-top:1px}
.sb-nav{padding:14px 10px;flex:1}
.sb-label{font-size:10px;font-weight:700;letter-spacing:.8px;color:var(--text3);text-transform:uppercase;padding:8px 10px 6px}
.sb-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:500;color:var(--text2);transition:all .18s;margin-bottom:2px;border:1px solid transparent}
.sb-item i{width:16px;text-align:center;font-size:13px;flex-shrink:0}
.sb-item:hover{background:rgba(255,255,255,.05);color:var(--text)}
.sb-item.active{background:rgba(24,119,242,.14);color:#60a5fa;font-weight:600;border-color:rgba(24,119,242,.2)}
.sb-badge{margin-left:auto;background:rgba(24,119,242,.18);color:#60a5fa;font-size:10px;font-weight:800;padding:2px 7px;border-radius:20px}
.sb-footer{padding:14px 12px;border-top:1px solid var(--border)}
.sb-logout{display:flex;align-items:center;gap:9px;color:var(--text2);font-size:13px;cursor:pointer;padding:9px 12px;border-radius:var(--radius);transition:all .2s}
.sb-logout:hover{color:var(--red);background:rgba(239,68,68,.08)}

/* ─── MAIN ─── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:center;gap:12px;padding:0 24px;height:56px;background:var(--bg2);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20;flex-shrink:0}
.topbar-title{font-size:15px;font-weight:700;letter-spacing:-.2px}
.topbar-spacer{flex:1}
.topbar-actions{display:flex;align-items:center;gap:10px}
.refresh-badge{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:5px 10px}
.refresh-dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)}
.refresh-dot.stale{background:var(--amber);box-shadow:0 0 6px var(--amber)}
.content{flex:1;overflow-y:auto;padding:24px}

/* ─── SECTION ─── */
.section{display:none}
.section.active{display:block}

/* ─── STAT GRID ─── */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}
.stat-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.c-blue::before{background:linear-gradient(90deg,#1877f2,#6366f1)}
.stat-card.c-green::before{background:linear-gradient(90deg,#16a34a,#22c55e)}
.stat-card.c-amber::before{background:linear-gradient(90deg,#b45309,#f59e0b)}
.stat-card.c-red::before{background:linear-gradient(90deg,#b91c1c,#ef4444)}
.stat-card.c-purple::before{background:linear-gradient(90deg,#5b21b6,#7c3aed)}
.stat-card.c-teal::before{background:linear-gradient(90deg,#0e7490,#06b6d4)}
.stat-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;margin-bottom:14px}
.c-blue .stat-icon{background:rgba(24,119,242,.12);color:#60a5fa}
.c-green .stat-icon{background:rgba(34,197,94,.12);color:#4ade80}
.c-amber .stat-icon{background:rgba(245,158,11,.12);color:#fbbf24}
.c-red .stat-icon{background:rgba(239,68,68,.12);color:#f87171}
.c-purple .stat-icon{background:rgba(124,58,237,.12);color:#a78bfa}
.c-teal .stat-icon{background:rgba(6,182,212,.12);color:#67e8f9}
.stat-val{font-size:28px;font-weight:800;line-height:1;letter-spacing:-.8px;font-family:'JetBrains Mono',monospace}
.stat-lbl{font-size:11px;color:var(--text2);margin-top:5px;font-weight:500}

/* ─── SECTION HEADER ─── */
.sec-hdr{display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.sec-hdr h2{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.sec-hdr h2 i{font-size:14px}
.sec-hdr-right{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ─── BUTTONS ─── */
.btn{display:inline-flex;align-items:center;gap:6px;font-family:inherit;font-size:12px;font-weight:600;padding:7px 13px;border-radius:8px;border:none;cursor:pointer;transition:all .18s;white-space:nowrap}
.btn-primary{background:var(--blue);color:#fff}
.btn-primary:hover{background:#2563eb}
.btn-success{background:rgba(34,197,94,.14);color:#4ade80;border:1px solid rgba(34,197,94,.25)}
.btn-success:hover{background:rgba(34,197,94,.22)}
.btn-danger{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.2)}
.btn-danger:hover{background:rgba(239,68,68,.22)}
.btn-ghost{background:rgba(255,255,255,.05);color:var(--text2);border:1px solid var(--border)}
.btn-ghost:hover{background:rgba(255,255,255,.09);color:var(--text)}
.btn-warning{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.2)}
.btn-warning:hover{background:rgba(245,158,11,.22)}
.btn-purple{background:rgba(124,58,237,.14);color:#a78bfa;border:1px solid rgba(124,58,237,.25)}
.btn-purple:hover{background:rgba(124,58,237,.22)}
.btn-sm{padding:5px 9px;font-size:11px}
.btn-lg{padding:10px 18px;font-size:13px}

/* ─── SEARCH ─── */
.search-box{display:flex;align-items:center;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:border .2s}
.search-box:focus-within{border-color:rgba(24,119,242,.4)}
.search-box input{background:transparent;border:none;color:var(--text);font-family:inherit;font-size:13px;padding:7px 12px;outline:none;width:200px}
.search-box i{padding:0 12px 0 4px;color:var(--text3);font-size:12px}

/* ─── TABLE ─── */
.table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden}
.table-wrap table{width:100%;border-collapse:collapse}
.table-wrap th{background:rgba(255,255,255,.025);font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text2);padding:11px 16px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
.table-wrap th.sortable{cursor:pointer;user-select:none}
.table-wrap th.sortable:hover{color:var(--text)}
.table-wrap td{padding:12px 16px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.035);vertical-align:middle}
.table-wrap tr:last-child td{border-bottom:none}
.table-wrap tr:hover td{background:rgba(255,255,255,.018)}
.td-name{font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.td-mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-actions{display:flex;gap:5px;flex-wrap:wrap}
.table-wrap.tx-light{background:#f8fafc;border-color:#e2e8f0}
.table-wrap.tx-light th{background:#f1f5f9;color:#64748b;border-bottom:1px solid #e2e8f0}
.table-wrap.tx-light td{border-bottom:1px solid #e2e8f0}
.table-wrap.tx-light tr:hover td{background:#f1f5f9}
.tx-count-pill{display:inline-flex;min-width:38px;justify-content:center;align-items:center;padding:4px 10px;border-radius:999px;background:#22c55e;color:#fff;font-size:12px;font-weight:800}
.tx-status-pill{display:inline-flex;padding:4px 12px;border-radius:999px;background:#22c55e;color:#fff;font-size:12px;font-weight:700}
.tx-action-link{color:#2563eb;font-weight:700}
.tx-action-link:hover{text-decoration:underline}
.tx-amount{color:#16a34a;font-weight:800;font-family:'JetBrains Mono',monospace}
td.cb-cell{width:40px;padding:12px 8px 12px 16px}
th.cb-cell{width:40px;padding:11px 8px 11px 16px}
input[type=checkbox]{width:14px;height:14px;accent-color:var(--blue);cursor:pointer}

/* ─── PLAN BADGES ─── */
.badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;padding:3px 9px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.b-free{background:rgba(107,114,128,.15);color:#9ca3af;border:1px solid rgba(107,114,128,.2)}
.b-basic{background:rgba(59,130,246,.12);color:#60a5fa;border:1px solid rgba(59,130,246,.22)}
.b-pro{background:rgba(124,58,237,.12);color:#a78bfa;border:1px solid rgba(124,58,237,.22)}
.b-agency{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.22)}

/* ─── QUOTA BAR ─── */
.quota-bar-wrap{width:90px}
.quota-bar{height:4px;background:rgba(255,255,255,.07);border-radius:4px;overflow:hidden;margin-bottom:4px}
.quota-fill{height:100%;border-radius:4px;background:var(--green);transition:width .3s}
.quota-fill.warn{background:var(--amber)}
.quota-fill.danger{background:var(--red)}
.quota-txt{font-size:10px;color:var(--text2)}
/* ─── EXPIRY ─── */
.exp-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;white-space:nowrap}
.exp-expired{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.25)}
.exp-soon{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
.exp-ok{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.2)}
.exp-none{color:var(--text3);font-size:11px}

/* ─── BULK ACTIONS BAR ─── */
.bulk-bar{
  display:none;align-items:center;gap:12px;
  padding:10px 16px;margin-bottom:14px;
  background:rgba(24,119,242,.1);border:1px solid rgba(24,119,242,.25);
  border-radius:var(--radius);
}
.bulk-bar.visible{display:flex}
.bulk-count{font-size:13px;font-weight:700;color:#60a5fa}
.bulk-actions{display:flex;gap:8px;margin-left:auto}

/* ─── PAGINATION ─── */
.pagination{display:flex;align-items:center;gap:6px;margin-top:16px;justify-content:flex-end;flex-wrap:wrap}
.pg-btn{background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--text2);font-family:inherit;font-size:12px;font-weight:600;padding:6px 11px;border-radius:7px;cursor:pointer;transition:all .18s}
.pg-btn:hover:not(:disabled){background:rgba(255,255,255,.1);color:var(--text)}
.pg-btn.active{background:var(--blue);border-color:var(--blue);color:#fff}
.pg-btn:disabled{opacity:.3;cursor:not-allowed}
.pg-info{font-size:11px;color:var(--text2);padding:0 6px}

/* ─── ANALYTICS CARDS ─── */
.analytics-period{display:inline-flex;gap:4px;background:rgba(255,255,255,.03);border:1px solid var(--border);padding:4px;border-radius:var(--radius)}
.period-btn{border:none;background:transparent;color:var(--text2);font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:inherit;transition:all .18s}
.period-btn.active{background:rgba(24,119,242,.16);color:#60a5fa}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
.kpi-card{border-radius:var(--radius-lg);padding:20px 22px;color:#fff;position:relative;overflow:hidden}
.kpi-card::after{content:'';position:absolute;right:-20px;top:-20px;width:80px;height:80px;border-radius:50%;background:rgba(255,255,255,.06)}
.kpi-green{background:linear-gradient(135deg,#14532d,#16a34a)}
.kpi-blue{background:linear-gradient(135deg,#1e3a8a,#1877f2)}
.kpi-purple{background:linear-gradient(135deg,#3b0764,#7c3aed)}
.kpi-label{font-size:11px;font-weight:600;opacity:.85;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.kpi-value{font-size:34px;font-weight:800;line-height:1;letter-spacing:-1px;margin-bottom:6px;font-family:'JetBrains Mono',monospace}
.kpi-sub{font-size:12px;opacity:.8}

/* ─── CHART ─── */
.chart-card{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:20px}
.chart-card-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.chart-card-title{font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px;color:#111827}
.chart-container{position:relative;height:220px}

/* ─── ACTIVITY ─── */
.filter-tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
.filter-tab{border:1px solid var(--border);background:transparent;color:var(--text2);font-family:inherit;font-size:11px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;transition:all .18s}
.filter-tab:hover{border-color:var(--border2);color:var(--text)}
.filter-tab.active{background:rgba(24,119,242,.14);border-color:rgba(24,119,242,.3);color:#60a5fa}
.activity-list{display:flex;flex-direction:column}
.activity-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.035);transition:background .15s}
.activity-row:last-child{border-bottom:none}
.activity-row:hover{background:rgba(255,255,255,.018)}
.act-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.ai-login{background:rgba(24,119,242,.12);color:#60a5fa}
.ai-payment{background:rgba(34,197,94,.12);color:#4ade80}
.ai-subscription{background:rgba(124,58,237,.12);color:#a78bfa}
.ai-send{background:rgba(245,158,11,.12);color:#fbbf24}
.ai-renewal{background:rgba(34,197,94,.1);color:#4ade80}
.ai-default{background:rgba(255,255,255,.06);color:var(--text2)}
.act-name{font-size:12px;font-weight:600;color:var(--text)}
.act-desc{font-size:11px;color:var(--text2);margin-top:2px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-time{font-size:11px;color:var(--text3);white-space:nowrap;flex-shrink:0;margin-left:auto}

/* ─── SETTINGS ─── */
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.settings-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px}
.settings-card h3{font-size:14px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.settings-card p{font-size:12px;color:var(--text2);margin-bottom:20px;line-height:1.7}
.form-row{margin-bottom:14px}
.form-row label{display:block;font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
.form-row input,.form-row select{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:13px;padding:10px 12px;border-radius:var(--radius);outline:none;transition:border .2s}
.form-row input:focus,.form-row select:focus{border-color:rgba(24,119,242,.5);background:rgba(24,119,242,.03)}
.form-row select option{background:#111827}
.sys-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:12px}
.sys-row:last-child{border-bottom:none}
.sys-row span{color:var(--text2)}

/* ─── MODAL ─── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:200;padding:20px}
.modal-overlay.open{display:flex}
.modal-box{background:var(--bg2);border:1px solid var(--border2);border-radius:18px;padding:32px;width:100%;max-width:460px;box-shadow:var(--shadow);animation:modal-in .2s cubic-bezier(.16,1,.3,1)}
@keyframes modal-in{from{transform:scale(.95) translateY(10px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
.modal-title{font-size:17px;font-weight:700;margin-bottom:4px;letter-spacing:-.3px}
.modal-sub{font-size:12px;color:var(--text2);margin-bottom:22px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:22px;flex-wrap:wrap}

/* ─── TOAST ─── */
.toast{position:fixed;bottom:24px;right:24px;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:13px 18px;font-size:13px;font-weight:600;color:var(--text);display:none;align-items:center;gap:9px;z-index:300;box-shadow:var(--shadow);animation:toast-in .25s cubic-bezier(.16,1,.3,1);max-width:340px}
@keyframes toast-in{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
.toast.open{display:flex}
.toast.success{border-color:rgba(34,197,94,.3);color:#4ade80}
.toast.error{border-color:rgba(239,68,68,.3);color:#f87171}
.toast.info{border-color:rgba(96,165,250,.3);color:#93c5fd}

/* ─── SKELETON ─── */
@keyframes sk{0%{background-position:-200% 0}100%{background-position:200% 0}}
.skeleton{background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.08) 50%,rgba(255,255,255,.04) 75%);background-size:200% 100%;animation:sk 1.4s infinite;border-radius:6px;color:transparent!important}
.skeleton *{visibility:hidden}

/* ─── EMPTY STATE ─── */
.empty-state{text-align:center;padding:56px 24px;color:var(--text2)}
.empty-state i{font-size:36px;opacity:.2;display:block;margin-bottom:14px}
.empty-state p{font-size:13px;line-height:1.8}

/* ─── RESPONSIVE ─── */
@media(max-width:1100px){.kpi-grid{grid-template-columns:1fr 1fr}.settings-grid{grid-template-columns:1fr}}
@media(max-width:900px){.kpi-grid{grid-template-columns:1fr}}
@media(max-width:700px){.sidebar{display:none}.content{padding:16px}}
</style>
</head>
<body>

<?php if (!$isLoggedIn): ?>
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo" style="background:none;box-shadow:none;"><img src="images/castpro2.png" alt="FBCast Pro" style="width:60px;height:60px;object-fit:contain;border-radius:12px;display:block;margin:0 auto;"></div>
    <h1>FBCast Admin</h1>
    <p>Enter your admin password to continue</p>
    <input type="password" id="pwInput" placeholder="Admin password" autocomplete="current-password">
    <button id="loginBtn"><i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In</button>
    <div class="login-err" id="loginErr">Incorrect password. Please try again.</div>
  </div>
</div>
<script>
const CSRF = '<?php echo $csrfToken; ?>';
async function doLogin() {
  const pw = document.getElementById('pwInput').value.trim();
  if (!pw) return;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…';
  try {
    const r = await fetch('admin.php?action=login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':CSRF},body:JSON.stringify({password:pw})});
    const d = await r.json();
    if (d.success) { location.reload(); return; }
    document.getElementById('loginErr').style.display = 'block';
  } catch(e) { document.getElementById('loginErr').textContent = 'Connection error.'; document.getElementById('loginErr').style.display = 'block'; }
  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
}
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('pwInput').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
</script>

<?php else: ?>
<div class="layout">

  <!-- SIDEBAR -->
  <div class="sidebar">
    <div class="sb-brand">
      <div class="sb-brand-icon" style="background:none;padding:0;overflow:hidden;"><img src="images/castpro2.png" alt="FBCast Pro" style="width:36px;height:36px;object-fit:contain;border-radius:8px;display:block;"></div>
      <div>
        <div class="sb-brand-name">FBCast <span>Pro</span></div>
        <div class="sb-brand-sub">Admin Panel</div>
      </div>
    </div>
    <nav class="sb-nav">
      <div class="sb-label">Navigation</div>
      <div class="sb-item active" data-sec="dashboard"><i class="fa-solid fa-chart-pie"></i> Dashboard</div>
      <div class="sb-item" data-sec="analytics"><i class="fa-solid fa-chart-line"></i> Analytics</div>
      <div class="sb-item" data-sec="users"><i class="fa-solid fa-users"></i> Users</div>
      <div class="sb-item" data-sec="activity"><i class="fa-solid fa-clock-rotate-left"></i> Activity Log</div>
      <div class="sb-item" data-sec="settings"><i class="fa-solid fa-gear"></i> Settings</div>
    </nav>
    <div class="sb-footer">
      <a href="admin.php?action=logout" class="sb-logout"><i class="fa-solid fa-arrow-right-from-bracket"></i> Logout</a>
    </div>
  </div>

  <!-- MAIN -->
  <div class="main">
    <div class="topbar">
      <span class="topbar-title" id="topbarTitle">Dashboard</span>
      <div class="topbar-spacer"></div>
      <div class="topbar-actions">
        <div class="refresh-badge" id="refreshBadge">
          <div class="refresh-dot" id="refreshDot"></div>
          <span id="refreshTime">Live</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="manualRefresh()"><i class="fa-solid fa-rotate-right"></i> Refresh</button>
      </div>
    </div>

    <div class="content">

      <!-- ── DASHBOARD ── -->
      <div class="section active" id="sec-dashboard">
        <div class="stat-grid" id="statGrid">
          <div class="stat-card c-blue"><div class="stat-icon"><i class="fa-solid fa-users"></i></div><div class="stat-val skeleton" id="s-total" style="height:32px;width:60px">—</div><div class="stat-lbl">Total Users</div></div>
          <div class="stat-card c-green"><div class="stat-icon"><i class="fa-solid fa-user-check"></i></div><div class="stat-val skeleton" id="s-free" style="height:32px;width:40px">—</div><div class="stat-lbl">Free Trial</div></div>
          <div class="stat-card c-purple"><div class="stat-icon"><i class="fa-solid fa-crown"></i></div><div class="stat-val skeleton" id="s-paid" style="height:32px;width:40px">—</div><div class="stat-lbl">Paid Users</div></div>
          <div class="stat-card c-amber"><div class="stat-icon"><i class="fa-solid fa-paper-plane"></i></div><div class="stat-val skeleton" id="s-sent" style="height:32px;width:60px">—</div><div class="stat-lbl">Total Sent</div></div>
          <div class="stat-card c-teal"><div class="stat-icon"><i class="fa-solid fa-arrow-right-to-bracket"></i></div><div class="stat-val skeleton" id="s-logins" style="height:32px;width:40px">—</div><div class="stat-lbl">Logins Today</div></div>
          <div class="stat-card c-green"><div class="stat-icon"><i class="fa-solid fa-dollar-sign"></i></div><div class="stat-val skeleton" id="s-rev" style="height:32px;width:60px">—</div><div class="stat-lbl">Month Revenue</div></div>
        </div>

        <div class="sec-hdr">
          <h2><i class="fa-solid fa-users" style="color:#60a5fa"></i> Recent Users</h2>
          <div class="sec-hdr-right">
            <button class="btn btn-ghost btn-sm" onclick="loadDashboard()"><i class="fa-solid fa-rotate-right"></i></button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Plan</th><th>Used</th><th>Remaining</th><th>Last Login</th><th>Actions</th></tr></thead>
            <tbody id="dashBody"><tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text2)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- ── ANALYTICS ── -->
      <div class="section" id="sec-analytics">
        <div class="sec-hdr">
          <h2><i class="fa-solid fa-chart-line" style="color:#4ade80"></i> Revenue Analytics</h2>
          <div class="sec-hdr-right">
            <div class="analytics-period" id="periodSwitch">
              <button class="period-btn active" data-range="7d">7 Days</button>
              <button class="period-btn" data-range="30d">30 Days</button>
              <button class="period-btn" data-range="weekly">Weekly</button>
              <button class="period-btn" data-range="monthly">Monthly</button>
            </div>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card kpi-green">
            <div class="kpi-label" id="kpi-rev-lbl">Today's Revenue</div>
            <div class="kpi-value" id="kpi-rev">$0.00</div>
            <div class="kpi-sub" id="kpi-plan-sub">Basic: 0 · Pro: 0</div>
          </div>
          <div class="kpi-card kpi-blue">
            <div class="kpi-label" id="kpi-tx-lbl">Transactions</div>
            <div class="kpi-value" id="kpi-tx">0</div>
            <div class="kpi-sub" id="kpi-tx-sub">Successful paid events</div>
          </div>
          <div class="kpi-card kpi-purple">
            <div class="kpi-label" id="kpi-login-lbl">User Logins</div>
            <div class="kpi-value" id="kpi-login">0</div>
            <div class="kpi-sub">Sessions in period</div>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-card-hdr">
            <div class="chart-card-title"><i class="fa-solid fa-chart-line" style="color:#2563eb"></i> <span id="chartTitle">Revenue — Last 7 Days</span></div>
          </div>
          <div class="chart-container"><canvas id="revenueChart"></canvas></div>
        </div>

        <div class="sec-hdr">
          <h2><i class="fa-solid fa-table-list" style="color:#60a5fa"></i> <span id="tx-table-title">Recent Transactions</span></h2>
        </div>
        <div class="table-wrap" id="txTableWrap">
          <table>
            <thead id="txHead"><tr><th>User</th><th>Email / FB ID</th><th>Plan</th><th>Amount</th><th>Type</th><th>Date</th></tr></thead>
            <tbody id="txBody"><tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text2)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- ── USERS ── -->
      <div class="section" id="sec-users">
        <div class="sec-hdr">
          <h2><i class="fa-solid fa-users" style="color:#60a5fa"></i> All Users</h2>
          <div class="sec-hdr-right">
            <div class="search-box">
              <input type="text" id="userSearch" placeholder="Search name or ID…">
              <i class="fa-solid fa-magnifying-glass"></i>
            </div>
            <button class="btn btn-primary" onclick="loadUsers(1)"><i class="fa-solid fa-magnifying-glass"></i> Search</button>
            <button class="btn btn-ghost" id="exportBtn" onclick="exportCSV()"><i class="fa-solid fa-file-arrow-down"></i> Export CSV</button>
          </div>
        </div>

        <!-- Bulk Bar -->
        <div class="bulk-bar" id="bulkBar">
          <i class="fa-solid fa-check-square" style="color:#60a5fa"></i>
          <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
          <div class="bulk-actions">
            <button class="btn btn-success btn-sm" onclick="bulkAction('basic')"><i class="fa-solid fa-arrow-up"></i> Set Basic</button>
            <button class="btn btn-purple btn-sm" onclick="bulkAction('pro')"><i class="fa-solid fa-crown"></i> Set Pro</button>
            <button class="btn btn-warning btn-sm" onclick="bulkAction('free')"><i class="fa-solid fa-arrow-down"></i> Set Free</button>
            <button class="btn btn-success btn-sm" onclick="bulkAction('reset')"><i class="fa-solid fa-rotate-left"></i> Reset Quota</button>
            <button class="btn btn-danger btn-sm" onclick="bulkAction('delete')"><i class="fa-solid fa-trash"></i> Delete</button>
            <button class="btn btn-ghost btn-sm" onclick="clearSelection()"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="cb-cell"><input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)"></th>
                <th>Name</th><th>Facebook ID</th><th>Plan</th><th>Usage</th><th>Remaining</th>
                <th>First Login</th><th>Last Login</th><th>Expires</th><th>Actions</th>
              </tr>
            </thead>
            <tbody id="usersBody">
              <tr><td colspan="9" style="text-align:center;padding:48px;color:var(--text2)"><i class="fa-solid fa-spinner fa-spin"></i> Loading users…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pagination" id="userPagination"></div>
      </div>

      <!-- ── ACTIVITY LOG ── -->
      <div class="section" id="sec-activity">
        <div class="sec-hdr">
          <h2><i class="fa-solid fa-clock-rotate-left" style="color:#60a5fa"></i> Activity Log</h2>
          <div class="sec-hdr-right">
            <button class="btn btn-ghost btn-sm" onclick="loadActivity(1,currentActFilter)"><i class="fa-solid fa-rotate-right"></i> Refresh</button>
          </div>
        </div>
        <div class="filter-tabs" id="actFilterTabs">
          <button class="filter-tab active" data-filter="all"><i class="fa-solid fa-list"></i> All</button>
          <button class="filter-tab" data-filter="login"><i class="fa-solid fa-arrow-right-to-bracket"></i> Logins</button>
          <button class="filter-tab" data-filter="payment"><i class="fa-solid fa-credit-card"></i> Payments</button>
          <button class="filter-tab" data-filter="subscription"><i class="fa-solid fa-crown"></i> Subscriptions</button>
          <button class="filter-tab" data-filter="renewal"><i class="fa-solid fa-rotate"></i> Renewals</button>
          <button class="filter-tab" data-filter="send"><i class="fa-solid fa-paper-plane"></i> Sends</button>
        </div>
        <div class="table-wrap">
          <div class="activity-list" id="activityList">
            <div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading activity…</p></div>
          </div>
        </div>
        <div class="pagination" id="actPagination"></div>
      </div>

      <!-- ── SETTINGS ── -->
      <div class="section" id="sec-settings">
        <div class="sec-hdr"><h2><i class="fa-solid fa-gear" style="color:#60a5fa"></i> Settings</h2></div>
        <div class="settings-grid">

          <div class="settings-card">
            <h3><i class="fa-solid fa-envelope" style="color:#60a5fa"></i> Free Message Limit</h3>
            <p>Number of free messages a new user gets on first login. Applies to all new registrations.</p>
            <div class="form-row"><label>Free Messages Limit</label><input type="number" id="settFreeLimit" min="1" value="<?= htmlspecialchars($freeLimit) ?>"></div>
            <button class="btn btn-primary" onclick="saveFreeLimitSetting()"><i class="fa-solid fa-floppy-disk"></i> Save Limit</button>
          </div>

          <div class="settings-card">
            <h3><i class="fa-solid fa-bullhorn" style="color:#4ade80"></i> User Topbar Announcement</h3>
            <p>Show update/offer message in user dashboard top bar. You can publish text, image, or video with optional link.</p>
            <div class="form-row">
              <label>Announcement Status</label>
              <select id="settAnnouncementEnabled">
                <option value="1" <?= $announcementEnabled ? 'selected' : '' ?>>Enabled (Visible to users)</option>
                <option value="0" <?= !$announcementEnabled ? 'selected' : '' ?>>Disabled</option>
              </select>
            </div>
            <div class="form-row">
              <label>Announcement Type</label>
              <select id="settAnnouncementType" onchange="toggleAnnouncementMediaInput()">
                <option value="text" <?= $announcementType==='text' ? 'selected' : '' ?>>Text Ticker</option>
                <option value="image" <?= $announcementType==='image' ? 'selected' : '' ?>>Image + Text</option>
                <option value="video" <?= $announcementType==='video' ? 'selected' : '' ?>>Video + Text</option>
              </select>
            </div>
            <div class="form-row">
              <label>Message Text</label>
              <input type="text" id="settAnnouncementText" maxlength="280" placeholder="e.g. New update is live. 20% OFF this week only." value="<?= htmlspecialchars($announcementText, ENT_QUOTES, 'UTF-8') ?>">
            </div>
            <div class="form-row" id="announcementMediaRow">
              <label>Media URL (Image/Video)</label>
              <input type="url" id="settAnnouncementMediaUrl" placeholder="https://example.com/banner.jpg or .mp4" value="<?= htmlspecialchars($announcementMediaUrl, ENT_QUOTES, 'UTF-8') ?>">
            </div>
            <div class="form-row">
              <label>Optional Click URL</label>
              <input type="url" id="settAnnouncementLinkUrl" placeholder="https://your-offer-page.com" value="<?= htmlspecialchars($announcementLinkUrl, ENT_QUOTES, 'UTF-8') ?>">
            </div>
            <button class="btn btn-success" onclick="saveAnnouncementSetting()"><i class="fa-solid fa-bullhorn"></i> Save Announcement</button>
          </div>

          <div class="settings-card">
            <h3><i class="fa-solid fa-key" style="color:#fbbf24"></i> Change Admin Password</h3>
            <p>Change the password used to access this admin panel. Minimum 8 characters required.</p>
            <div class="form-row"><label>New Password</label><input type="password" id="settPw1" placeholder="Enter new password"></div>
            <div class="form-row"><label>Confirm Password</label><input type="password" id="settPw2" placeholder="Repeat new password"></div>
            <button class="btn btn-warning" onclick="savePasswordSetting()"><i class="fa-solid fa-lock"></i> Change Password</button>
          </div>

          <div class="settings-card">
            <h3><i class="fa-solid fa-server" style="color:#4ade80"></i> System Status</h3>
            <p>Current server configuration and environment info.</p>
            <div class="sys-row"><span>PHP Version</span><strong><?php echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION; ?></strong></div>
            <div class="sys-row"><span>Environment</span><strong style="color:<?php echo (defined('APP_ENV')&&APP_ENV==='production')?'var(--green)':'var(--amber)'; ?>"><?php echo defined('APP_ENV')?strtoupper(APP_ENV):'DEVELOPMENT'; ?></strong></div>
            <div class="sys-row"><span>HTTPS</span><strong style="color:<?php echo (!empty($_SERVER['HTTPS'])&&$_SERVER['HTTPS']!=='off')?'var(--green)':'var(--red)'; ?>"><?php echo (!empty($_SERVER['HTTPS'])&&$_SERVER['HTTPS']!=='off')?'Enabled':'Disabled'; ?></strong></div>
            <div class="sys-row"><span>Database</span><strong style="color:var(--green)">Connected</strong></div>
            <div class="sys-row"><span>Server Time</span><strong><?php echo date('Y-m-d H:i:s'); ?></strong></div>
          </div>

          <div class="settings-card">
            <h3><i class="fa-solid fa-chart-bar" style="color:#a78bfa"></i> Quick Actions</h3>
            <p>Bulk management tools for the platform.</p>
            <div style="display:flex;flex-direction:column;gap:10px">
              <button class="btn btn-ghost btn-lg" onclick="exportCSV()"><i class="fa-solid fa-file-arrow-down"></i> Export All Users (CSV)</button>
              <button class="btn btn-ghost btn-lg" onclick="navTo('users');loadUsers(1)"><i class="fa-solid fa-users"></i> Manage All Users</button>
              <button class="btn btn-ghost btn-lg" onclick="navTo('activity');loadActivity(1,'all')"><i class="fa-solid fa-clock-rotate-left"></i> View Activity Log</button>
            </div>
          </div>

        </div>
      </div>

    </div><!-- /content -->
  </div><!-- /main -->
</div><!-- /layout -->

<!-- EDIT USER MODAL -->
<div class="modal-overlay" id="editModal">
  <div class="modal-box">
    <div class="modal-title">Edit User</div>
    <div class="modal-sub" id="editModalSub">Loading…</div>
    <input type="hidden" id="editFbId">
    <div class="form-row"><label>Plan</label>
      <select id="editPlan"><option value="free">Free</option><option value="basic">Basic ($25/mo)</option><option value="pro">Pro ($50/mo)</option></select>
    </div>
    <div class="form-row"><label>Message Limit</label><input type="number" id="editLimit" min="0" placeholder="e.g. 200000"></div>
    <div class="form-row"><label>Messages Used</label><input type="number" id="editUsed" min="0" placeholder="e.g. 0"></div>
    <div class="form-row"><label>Subscription Expires (optional)</label><input type="date" id="editExpiry"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="deleteUser()"><i class="fa-solid fa-trash"></i> Delete</button>
      <button class="btn btn-success" onclick="grantUnlimitedModal()"><i class="fa-solid fa-infinity"></i> Unlimited</button>
      <button class="btn btn-primary" onclick="saveUser()"><i class="fa-solid fa-floppy-disk"></i> Save</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const CSRF = '<?php echo $csrfToken; ?>';
let revenueChart = null;
let statsCache = null;
let currentActFilter = 'all';
let currentUserPage = 1;
let currentActPage = 1;
let selectedUsers = new Set();
let autoRefreshTimer = null;
let selectedRecordKey = null;

/* ─── API ─── */
async function api(action, method='GET', body=null, qs='') {
  try {
    const url = 'admin.php?action=' + action + (qs ? '&'+qs : '');
    const opts = {method, headers:{'Content-Type':'application/json','X-CSRF-Token':CSRF}};
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (r.status === 401) { location.reload(); return {}; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP '+r.status);
    return d;
  } catch(e) {
    if (e.message !== 'Unauthorized') showToast(e.message, 'error');
    return {};
  }
}

/* ─── Toast ─── */
let toastT;
function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  const icons = {success:'✓',error:'✗',info:'ℹ'};
  t.innerHTML = `${icons[type]||'✓'} ${msg}`;
  t.className = `toast open ${type}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => t.className='toast', 3200);
}

/* ─── Navigation ─── */
const secTitles = {dashboard:'Dashboard',analytics:'Revenue Analytics',users:'Users',activity:'Activity Log',settings:'Settings'};
function navTo(sec) {
  document.querySelectorAll('.sb-item').forEach(i => i.classList.toggle('active', i.dataset.sec===sec));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('sec-'+sec).classList.add('active');
  document.getElementById('topbarTitle').textContent = secTitles[sec]||sec;
  if (sec==='dashboard') loadDashboard();
  if (sec==='analytics') loadAnalytics();
  if (sec==='users')     loadUsers(1);
  if (sec==='activity')  loadActivity(1, currentActFilter);
}
document.querySelectorAll('.sb-item').forEach(i => i.addEventListener('click', () => navTo(i.dataset.sec)));

/* ─── Refresh indicator ─── */
function setRefreshTime() {
  const el = document.getElementById('refreshTime');
  const dot = document.getElementById('refreshDot');
  el.textContent = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  dot.className = 'refresh-dot';
  setTimeout(() => { dot.className='refresh-dot stale'; el.textContent='Stale'; }, 60000);
}
function manualRefresh() {
  const sec = document.querySelector('.sb-item.active')?.dataset.sec || 'dashboard';
  statsCache = null;
  navTo(sec);
}
function exportCSV() {
  window.open('admin.php?action=export_users','_blank');
}

/* ─── DASHBOARD ─── */
async function loadDashboard() {
  const m = v => `$${(Number(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const set = (id, v) => { const e=document.getElementById(id); if(!e) return; e.textContent=v; e.classList.remove('skeleton'); e.style.height=''; e.style.width=''; };

  const stats = await getStats();
  if (!stats || stats.total_users===undefined) { showToast('Stats load failed','error'); return; }

  set('s-total', (stats.total_users||0).toLocaleString());
  set('s-free',  (stats.free_users||0).toLocaleString());
  set('s-paid',  (stats.paid_users||0).toLocaleString());
  set('s-sent',  (stats.total_sent||0).toLocaleString());
  set('s-logins',(stats.today_logins||0).toLocaleString());
  set('s-rev',   m(stats.month_revenue||0));
  setRefreshTime();

  const ud = await api('users','GET',null,'p=1');
  const tbody = document.getElementById('dashBody');
  if (!tbody) return;
  const users = (ud.users||[]).slice(0,8);
  if (!users.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text2)">No users yet.</td></tr>'; return; }
  tbody.innerHTML = users.map(u => `<tr>
    <td class="td-name" title="${esc(u.fb_name)}">${esc(u.fb_name)||'<em style="color:var(--text2)">Unknown</em>'}</td>
    <td><span class="badge b-${u.plan||'free'}">${u.plan||'free'}</span></td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${(u.messages_used||0).toLocaleString()}</td>
    <td><div class="quota-bar-wrap"><div class="quota-bar"><div class="quota-fill${getPct(u)>=90?' danger':getPct(u)>=70?' warn':''}" style="width:${getPct(u)}%"></div></div><div class="quota-txt">${(u.remaining||0).toLocaleString()} left</div></div></td>
    <td style="color:var(--text2);font-size:11px">${fmtDate(u.last_login)}</td>
    <td class="td-actions"><button class="btn btn-ghost btn-sm" onclick='openEdit(${JSON.stringify(u)})'><i class="fa-solid fa-pen"></i></button></td>
  </tr>`).join('');
}

function getPct(u) { return u.messages_limit>0 ? Math.round((u.messages_used/u.messages_limit)*100) : 0; }

/* ─── STATS CACHE ─── */
async function getStats() {
  if (statsCache) return statsCache;
  statsCache = await api('stats');
  return statsCache;
}

/* ─── ANALYTICS ─── */
let analyticsRange = '7d';

async function loadAnalytics() {
  const stats = await getStats();
  if (!stats) return;
  renderAnalytics(analyticsRange, stats);
  setRefreshTime();
}

function sumArr(arr, key) { return arr.reduce((s,r) => s+(Number(r[key])||0), 0); }

function renderAnalytics(range, stats) {
  if (!stats) return;
  const prevRange = analyticsRange;
  analyticsRange = range;
  if (prevRange !== range) selectedRecordKey = null;
  const m = v => `$${(Number(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  document.querySelectorAll('#periodSwitch .period-btn').forEach(b => b.classList.toggle('active', b.dataset.range===range));

  const daily   = stats.daily_revenue||[];
  const weekly  = stats.weekly_revenue||[];
  const monthly = stats.monthly_revenue||[];

  // KPI values per range
  let rev=0, tx=0, log=0, lRev='', lTx='', lLog='', plans={basic:0,pro:0}, chartTitle='';
  const st = stats.server_today||''; const sm = stats.server_month||'';

  if (range==='7d') {
    const last7 = daily.filter(d => d.day >= new Date(Date.now()-6*864e5).toISOString().slice(0,10));
    rev=sumArr(last7,'revenue'); tx=sumArr(last7,'transactions'); log=stats.week7_logins||0;
    plans=stats.plan_breakdown_week7||{}; lRev='7-Day Revenue'; lTx='7-Day Transactions'; lLog='7-Day Logins';
    chartTitle='Daily Revenue — Last 7 Days';
    buildChart(last7.map(d=>({
      label: fmtShortDate(d.day),
      revenue: Number(d.revenue)||0,
      transactions: Number(d.transactions)||0
    })));
  } else if (range==='30d') {
    rev=sumArr(daily,'revenue'); tx=sumArr(daily,'transactions'); log=stats.month_logins||0;
    plans=stats.plan_breakdown_month||{}; lRev='30-Day Revenue'; lTx='30-Day Transactions'; lLog='30-Day Logins';
    chartTitle='Daily Revenue — Last 30 Days';
    buildChart(daily.map(d=>({
      label: fmtShortDate(d.day),
      revenue: Number(d.revenue)||0,
      transactions: Number(d.transactions)||0
    })));
  } else if (range==='weekly') {
    rev=sumArr(weekly,'revenue'); tx=sumArr(weekly,'transactions'); log=0;
    plans={basic:0,pro:0}; lRev='12-Week Revenue'; lTx='12-Week Transactions'; lLog='—';
    chartTitle='Weekly Revenue — Last 12 Weeks';
    buildChart(weekly.map(d=>({
      label: fmtWeekLabel(d.week_start),
      revenue: Number(d.revenue)||0,
      transactions: Number(d.transactions)||0
    })));
  } else if (range==='monthly') {
    rev=sumArr(monthly,'revenue'); tx=sumArr(monthly,'transactions'); log=stats.total_logins||0;
    plans=stats.plan_breakdown_total||{}; lRev='12-Month Revenue'; lTx='12-Month Transactions'; lLog='Total Logins';
    chartTitle='Monthly Revenue — Last 12 Months';
    buildChart(monthly.map(d=>({
      label: d.month,
      revenue: Number(d.revenue)||0,
      transactions: Number(d.transactions)||0
    })));
  }

  const setText = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  setText('chartTitle', chartTitle);
  setText('kpi-rev-lbl', lRev); setText('kpi-tx-lbl', lTx); setText('kpi-login-lbl', lLog);
  setText('kpi-rev',  m(rev)); setText('kpi-tx', tx.toLocaleString()); setText('kpi-login', log?log.toLocaleString():'—');
  setText('kpi-plan-sub', `Basic: ${plans.basic||0} · Pro: ${plans.pro||0}`);
  renderRecordsView(range, stats, m, daily, weekly);
}

function setTxHead(cols) {
  const h = document.getElementById('txHead');
  if (!h) return;
  h.innerHTML = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
}

function renderRecordsView(range, stats, moneyFmt, daily, weekly) {
  const setText = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  const txWrap = document.getElementById('txTableWrap');
  if (txWrap) txWrap.classList.add('tx-light');
  if (selectedRecordKey) {
    renderRecordDetails(selectedRecordKey, stats, moneyFmt);
    return;
  }
  let rows = [];
  let title = '';
  if (range === 'monthly') {
    const month = stats.server_month || new Date().toISOString().slice(0,7);
    const byDay = {};
    (stats.paid_events||[]).forEach(ev => {
      const day = String(ev.created_at||'').slice(0,10);
      if (!day || !day.startsWith(month)) return;
      if (!byDay[day]) byDay[day] = { key:day, label:fmtDateDay(day), transactions:0, amount:0, type:'day' };
      byDay[day].transactions += 1;
      byDay[day].amount += Number(ev.amount)||0;
    });
    rows = Object.values(byDay).sort((a,b)=>a.key < b.key ? 1 : -1);
    title = `Monthly Records — ${month}`;
  } else if (range === 'weekly') {
    rows = (weekly||[]).map(w => ({
      key: w.week_start,
      label: fmtWeekRange(w.week_start),
      transactions: Number(w.transactions)||0,
      amount: Number(w.revenue)||0,
      type: 'week'
    })).sort((a,b)=>a.key < b.key ? 1 : -1);
    title = 'Weekly Records — Last 12 Weeks';
  } else {
    const cutoff = range==='7d'
      ? new Date(Date.now()-6*864e5).toISOString().slice(0,10)
      : new Date(Date.now()-29*864e5).toISOString().slice(0,10);
    rows = (daily||[])
      .filter(d => String(d.day||'') >= cutoff)
      .map(d => ({
        key: d.day,
        label: fmtDateDay(d.day),
        transactions: Number(d.transactions)||0,
        amount: Number(d.revenue)||0,
        type: 'day'
      }))
      .sort((a,b)=>a.key < b.key ? 1 : -1);
    title = range === '7d' ? 'Daily Records — Last 7 Days' : 'Daily Records — Last 30 Days';
  }
  setText('tx-table-title', title);
  setTxHead(['DATE','TRANSACTIONS','TOTAL AMOUNT','STATUS','ACTION']);
  const tbody = document.getElementById('txBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:#64748b">No records found in this period.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td style="color:#0f172a;font-weight:600">${r.label}</td>
    <td><span class="tx-count-pill">${r.transactions}</span></td>
    <td class="tx-amount">${moneyFmt(r.amount)}</td>
    <td><span class="tx-status-pill">Completed</span></td>
    <td><a href="#" class="tx-action-link" onclick="viewRecordDetails('${r.type}','${r.key}');return false;">View Details →</a></td>
  </tr>`).join('');
}

function viewRecordDetails(type, key) {
  selectedRecordKey = `${type}:${key}`;
  const stats = statsCache || {};
  const m = v => `$${(Number(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  renderRecordDetails(selectedRecordKey, stats, m);
}

function backToRecords() {
  selectedRecordKey = null;
  if (statsCache) renderAnalytics(analyticsRange, statsCache);
}

function renderRecordDetails(recordKey, stats, moneyFmt) {
  const setText = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  const [type, key] = String(recordKey||'').split(':');
  const start = type === 'week' ? key : key;
  const end = type === 'week' ? addDays(key, 6) : key;
  const title = type === 'week'
    ? `Transactions on ${fmtWeekRange(key)}`
    : `Transactions on ${fmtDateDay(key)}`;
  setText('tx-table-title', title);
  setTxHead(['USER','EMAIL / FB ID','PLAN','AMOUNT','TYPE','DATE']);
  const rows = (stats.paid_events||[])
    .filter(ev => {
      const d = String(ev.created_at||'').slice(0,10);
      return d >= start && d <= end;
    })
    .sort((a,b) => String(a.created_at||'') < String(b.created_at||'') ? 1 : -1);
  const tbody = document.getElementById('txBody');
  const backRow = `<tr><td colspan="6" style="padding:12px 16px;background:#eef2ff">
    <button class="btn btn-ghost btn-sm" onclick="backToRecords()">← Back To Records</button>
  </td></tr>`;
  if (!rows.length) {
    tbody.innerHTML = `${backRow}<tr><td colspan="6" style="text-align:center;padding:40px;color:#64748b">No transactions found for this date.</td></tr>`;
    return;
  }
  tbody.innerHTML = backRow + rows.map(ev => `<tr>
    <td class="td-name" style="color:#0f172a" title="${esc(ev.fb_user_id)}">${esc(ev.fb_name||ev.fb_user_id)}</td>
    <td class="td-mono">${ev.email ? `<a href="mailto:${esc(ev.email)}" style="color:#2563eb">${esc(ev.email)}</a>` : `<span style="color:#64748b">${esc(ev.fb_user_id)}</span>`}</td>
    <td><span class="badge b-${ev.plan||'basic'}">${ev.plan||'—'}</span></td>
    <td class="tx-amount">${moneyFmt(ev.amount||0)}</td>
    <td style="text-transform:capitalize;color:#475569">${esc(ev.action||'payment')}</td>
    <td style="color:#64748b;font-size:11px">${fmtDate(ev.created_at)}</td>
  </tr>`).join('');
}

function fmtShortDate(s) {
  if (!s) return '';
  try { const d=new Date(s+'T00:00:00'); return d.toLocaleDateString('en',{month:'short',day:'numeric'}); } catch(e){return s;}
}
function fmtWeekLabel(s) {
  if (!s) return '';
  try { const d=new Date(s+'T00:00:00'); return 'W '+d.toLocaleDateString('en',{month:'short',day:'numeric'}); } catch(e){return s;}
}
function fmtDateDay(s) {
  if (!s) return '—';
  try { return new Date(s+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); } catch(e){ return s; }
}
function fmtWeekRange(s) {
  if (!s) return '—';
  const end = addDays(s, 6);
  return `${fmtDateDay(s)} - ${fmtDateDay(end)}`;
}
function addDays(s, n) {
  try {
    const d = new Date(s+'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0,10);
  } catch(e) { return s; }
}

function buildChart(points) {
  if (revenueChart) { revenueChart.destroy(); revenueChart=null; }
  const ctx = document.getElementById('revenueChart');
  if (!ctx) return;
  const canvasCtx = ctx.getContext('2d');
  const labels = points.map(p=>p.label);
  const revenueData = points.map(p=>Number(p.revenue)||0);
  const txData = points.map(p=>Number(p.transactions)||0);
  const gradient = canvasCtx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, 'rgba(37,99,235,.22)');
  gradient.addColorStop(1, 'rgba(37,99,235,.04)');
  revenueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets:[{
        label: 'Revenue ($)',
        data: revenueData,
        fill: true,
        backgroundColor: gradient,
        borderColor: '#2563eb',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 5,
        pointBackgroundColor: '#2563eb',
        pointBorderColor: '#f8fafc',
        pointBorderWidth: 2,
        tension: .42,
        yAxisID: 'yRevenue',
      },{
        label: 'Transactions',
        data: txData,
        fill: false,
        borderColor: '#22c55e',
        borderWidth: 2,
        pointRadius: 3.5,
        pointHoverRadius: 5,
        pointBackgroundColor: '#22c55e',
        pointBorderColor: '#f8fafc',
        pointBorderWidth: 2,
        tension: .42,
        yAxisID: 'yTx',
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction:{mode:'index',intersect:false},
      plugins: {
        legend:{
          display:true,
          position:'top',
          align:'center',
          labels:{color:'#6b7280',usePointStyle:true,pointStyle:'circle',boxWidth:9,boxHeight:9,padding:20}
        },
        tooltip:{
          backgroundColor:'#ffffff',
          titleColor:'#111827',
          bodyColor:'#111827',
          borderColor:'#e5e7eb',
          borderWidth:1,
          callbacks:{
            label: c => c.dataset.label === 'Revenue ($)'
              ? `$${Number(c.parsed.y||0).toFixed(2)}`
              : `${Number(c.parsed.y||0).toLocaleString()} transactions`
          }
        }
      },
      scales: {
        x: {
          grid:{color:'rgba(148,163,184,.24)'},
          ticks:{color:'#94a3b8',font:{size:10},maxRotation:45},
          border:{color:'rgba(148,163,184,.3)'}
        },
        yRevenue: {
          position:'left',
          grid:{color:'rgba(148,163,184,.24)'},
          ticks:{color:'#2563eb',font:{size:10},callback:v=>`$${Number(v).toLocaleString()}`},
          border:{color:'rgba(148,163,184,.3)'},
          beginAtZero:true
        },
        yTx: {
          position:'right',
          grid:{drawOnChartArea:false},
          ticks:{color:'#16a34a',font:{size:10}},
          border:{color:'rgba(148,163,184,.3)'},
          beginAtZero:true
        }
      }
    }
  });
}

document.getElementById('periodSwitch')?.addEventListener('click', async e => {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  const stats = await getStats();
  if (stats) renderAnalytics(btn.dataset.range, stats);
});

function expiryBadge(exp) {
  if (!exp || exp === '0000-00-00 00:00:00') return '<span class="exp-none">—</span>';
  const expDate = new Date(exp.replace(' ','T'));
  const now = new Date();
  const diff = (expDate - now) / 864e5;
  if (diff < 0) return `<span class="exp-badge exp-expired"><i class="fa-solid fa-circle-xmark"></i> Expired</span>`;
  if (diff <= 7) return `<span class="exp-badge exp-soon"><i class="fa-solid fa-clock"></i> ${Math.ceil(diff)}d left</span>`;
  return `<span class="exp-badge exp-ok">${expDate.toLocaleDateString('en',{day:'2-digit',month:'short',year:'numeric'})}</span>`;
}

/* ─── USERS ─── */
async function loadUsers(page=1) {
  currentUserPage = page;
  clearSelection();
  const q = document.getElementById('userSearch').value.trim();
  const tbody = document.getElementById('usersBody');
  tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:48px;color:var(--text2)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr>`;
  const d = await api('users','GET',null,`p=${page}&q=${encodeURIComponent(q)}`);
  const users = d.users||[];
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:48px;color:var(--text2)">No users found.</td></tr>`;
    document.getElementById('userPagination').innerHTML = '';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const pct = getPct(u);
    const barCls = pct>=90?' danger':pct>=70?' warn':'';
    return `<tr>
      <td class="cb-cell"><input type="checkbox" class="user-cb" value="${esc(u.fb_user_id)}" onchange="onCbChange()"></td>
      <td class="td-name" title="${esc(u.fb_name)}">${esc(u.fb_name)||'<em style="color:var(--text2)">Unknown</em>'}</td>
      <td class="td-mono" title="${esc(u.fb_user_id)}">${esc(u.fb_user_id)}</td>
      <td><span class="badge b-${u.plan||'free'}">${u.plan||'free'}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${(u.messages_used||0).toLocaleString()} / ${(u.messages_limit||0).toLocaleString()}</td>
      <td><div class="quota-bar-wrap"><div class="quota-bar"><div class="quota-fill${barCls}" style="width:${pct}%"></div></div><div class="quota-txt">${(u.remaining||0).toLocaleString()} left</div></div></td>
      <td style="color:var(--text2);font-size:11px">${fmtDate(u.first_login)}</td>
      <td style="color:var(--text2);font-size:11px">${fmtDate(u.last_login)}</td>
      <td>${expiryBadge(u.subscription_expires)}</td>
      <td class="td-actions">
        <button class="btn btn-ghost btn-sm" onclick='openEdit(${JSON.stringify(u)})'><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn btn-warning btn-sm" onclick="resetQuota('${esc(u.fb_user_id)}','${esc(u.fb_name)}')"><i class="fa-solid fa-rotate-left"></i></button>
        <button class="btn btn-purple btn-sm" onclick="grantUnlimited('${esc(u.fb_user_id)}','${esc(u.fb_name)}')"><i class="fa-solid fa-infinity"></i></button>
      </td>
    </tr>`;
  }).join('');

  const total = d.total||0;
  const totalPages = Math.ceil(total/(d.per_page||25));
  const pg = document.getElementById('userPagination');
  if (totalPages<=1) { pg.innerHTML=''; return; }
  let html = `<span class="pg-info">${total.toLocaleString()} users · Page ${page}/${totalPages}</span>`;
  html += `<button class="pg-btn" ${page<=1?'disabled':''} onclick="loadUsers(${page-1})">‹ Prev</button>`;
  for (let i=Math.max(1,page-2);i<=Math.min(totalPages,page+2);i++) html += `<button class="pg-btn ${i===page?'active':''}" onclick="loadUsers(${i})">${i}</button>`;
  html += `<button class="pg-btn" ${page>=totalPages?'disabled':''} onclick="loadUsers(${page+1})">Next ›</button>`;
  pg.innerHTML = html;
}

document.getElementById('userSearch')?.addEventListener('keydown', e => { if(e.key==='Enter') loadUsers(1); });

/* ─── BULK ─── */
function onCbChange() {
  selectedUsers = new Set([...document.querySelectorAll('.user-cb:checked')].map(c=>c.value));
  document.getElementById('bulkCount').textContent = selectedUsers.size;
  document.getElementById('bulkBar').classList.toggle('visible', selectedUsers.size>0);
  document.getElementById('selectAll').indeterminate = selectedUsers.size > 0 && selectedUsers.size < document.querySelectorAll('.user-cb').length;
}
function toggleSelectAll(cb) {
  document.querySelectorAll('.user-cb').forEach(c => c.checked=cb.checked);
  onCbChange();
}
function clearSelection() {
  selectedUsers.clear();
  document.querySelectorAll('.user-cb').forEach(c => c.checked=false);
  const sa = document.getElementById('selectAll'); if(sa) { sa.checked=false; sa.indeterminate=false; }
  document.getElementById('bulkBar').classList.remove('visible');
  document.getElementById('bulkCount').textContent = '0';
}

async function bulkAction(type) {
  if (!selectedUsers.size) return;
  const ids = [...selectedUsers];
  if (type==='delete') {
    if (!confirm(`Delete ${ids.length} user(s)? This cannot be undone.`)) return;
    let ok=0;
    for (const id of ids) { const d=await api('delete_user','POST',{fb_user_id:id}); if(d.success) ok++; }
    showToast(`Deleted ${ok} user(s)`);
    clearSelection(); loadUsers(currentUserPage); return;
  }
  if (type==='reset') {
    if (!confirm(`Reset quota for ${ids.length} user(s)?`)) return;
    const d = await api('bulk_update','POST',{ids,reset_quota:true});
    if(d.success) { showToast(`Reset ${d.count} user(s)`); clearSelection(); loadUsers(currentUserPage); } return;
  }
  const planMap = {basic:'basic',pro:'pro',free:'free'};
  if (planMap[type]) {
    const d = await api('bulk_update','POST',{ids,plan:planMap[type]});
    if(d.success) { showToast(`Updated ${d.count} user(s) to ${planMap[type]}`); clearSelection(); statsCache=null; loadUsers(currentUserPage); }
  }
}

/* ─── EDIT MODAL ─── */
function openEdit(u) {
  document.getElementById('editFbId').value = u.fb_user_id;
  document.getElementById('editModalSub').textContent = `${u.fb_name||'Unknown'} · ${u.fb_user_id}`;
  document.getElementById('editPlan').value  = u.plan||'free';
  document.getElementById('editLimit').value = u.messages_limit||0;
  document.getElementById('editUsed').value  = u.messages_used||0;
  document.getElementById('editExpiry').value = u.subscription_expires ? u.subscription_expires.split(' ')[0] : '';
  document.getElementById('editModal').classList.add('open');
}
function closeModal() { document.getElementById('editModal').classList.remove('open'); }
document.getElementById('editModal').addEventListener('click', e => { if(e.target===document.getElementById('editModal')) closeModal(); });

async function saveUser() {
  const fbId  = document.getElementById('editFbId').value;
  const plan  = document.getElementById('editPlan').value;
  const limit = parseInt(document.getElementById('editLimit').value,10);
  const used  = parseInt(document.getElementById('editUsed').value,10);
  const expiry= document.getElementById('editExpiry').value;
  const d = await api('update_user','POST',{fb_user_id:fbId,plan,messages_limit:limit,messages_used:used,subscription_expires:expiry||null});
  if (d.success) { showToast('User updated'); closeModal(); statsCache=null; loadUsers(currentUserPage); }
  else showToast(d.error||'Update failed','error');
}
async function deleteUser() {
  const fbId = document.getElementById('editFbId').value;
  const name = document.getElementById('editModalSub').textContent;
  if (!confirm(`Delete user "${name}"?\nAll data will be removed.`)) return;
  const d = await api('delete_user','POST',{fb_user_id:fbId});
  if (d.success) { showToast('User deleted'); closeModal(); statsCache=null; loadUsers(currentUserPage); }
  else showToast(d.error||'Delete failed','error');
}
async function grantUnlimitedModal() {
  const fbId = document.getElementById('editFbId').value;
  const name = document.getElementById('editModalSub').textContent;
  if (!confirm(`Grant UNLIMITED access to "${name}"?`)) return;
  const d = await api('grant_unlimited','POST',{fb_user_id:fbId});
  if (d.success) { showToast('Unlimited granted'); closeModal(); statsCache=null; loadUsers(currentUserPage); }
  else showToast(d.error||'Failed','error');
}
async function resetQuota(fbId, name) {
  if (!confirm(`Reset quota for "${name}"?`)) return;
  const d = await api('reset_quota','POST',{fb_user_id:fbId});
  if (d.success) { showToast('Quota reset'); loadUsers(currentUserPage); }
  else showToast(d.error||'Failed','error');
}
async function grantUnlimited(fbId, name) {
  if (!confirm(`Grant UNLIMITED access to "${name}"?`)) return;
  const d = await api('grant_unlimited','POST',{fb_user_id:fbId});
  if (d.success) { showToast(`Unlimited granted to ${name}`); statsCache=null; loadUsers(currentUserPage); }
  else showToast(d.error||'Failed','error');
}

/* ─── ACTIVITY ─── */
const AI = {
  login:{cls:'ai-login',icon:'fa-arrow-right-to-bracket'},
  payment:{cls:'ai-payment',icon:'fa-credit-card'},
  subscription:{cls:'ai-subscription',icon:'fa-crown'},
  send:{cls:'ai-send',icon:'fa-paper-plane'},
  renewal:{cls:'ai-renewal',icon:'fa-rotate'},
};

async function loadActivity(page=1, filter='all') {
  currentActPage = page; currentActFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter===filter));
  const list = document.getElementById('activityList');
  list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin" style="opacity:1;font-size:20px"></i><p>Loading…</p></div>';
  const qs = `p=${page}${filter&&filter!=='all'?'&filter='+encodeURIComponent(filter):''}`;
  const d = await api('activity','GET',null,qs);
  if (!d.rows) { list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No activity found.</p></div>'; return; }
  list.innerHTML = d.rows.length ? d.rows.map(r => {
    const ic = AI[r.action]||{cls:'ai-default',icon:'fa-circle-dot'};
    return `<div class="activity-row">
      <div class="act-icon ${ic.cls}"><i class="fa-solid ${ic.icon}"></i></div>
      <div style="flex:1;min-width:0">
        <div class="act-name">${esc(r.fb_name||r.fb_user_id)}</div>
        <div class="act-desc">${esc(r.detail||r.action)}</div>
      </div>
      <div class="act-time">${fmtDate(r.created_at)}</div>
    </div>`;
  }).join('') : '<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No activity in this category.</p></div>';
  const pages = Math.ceil((d.total||0)/(d.per_page||30));
  const pg = document.getElementById('actPagination');
  pg.innerHTML = pages>1 ? `<button class="pg-btn" onclick="loadActivity(${page-1},currentActFilter)" ${page<=1?'disabled':''}>‹ Prev</button><span class="pg-info">Page ${page}/${pages}</span><button class="pg-btn" onclick="loadActivity(${page+1},currentActFilter)" ${page>=pages?'disabled':''}>Next ›</button>` : '';
}

document.querySelectorAll('.filter-tab').forEach(t => t.addEventListener('click', () => loadActivity(1, t.dataset.filter)));

/* ─── SETTINGS ─── */
async function saveFreeLimitSetting() {
  const limit = parseInt(document.getElementById('settFreeLimit').value,10);
  if (!limit||limit<1) { showToast('Enter valid number (≥1)','error'); return; }
  const d = await api('update_settings','POST',{free_limit:limit});
  if (d.success) showToast(`Free limit set to ${limit.toLocaleString()}`);
  else showToast(d.error||'Failed','error');
}
function toggleAnnouncementMediaInput() {
  const typeEl = document.getElementById('settAnnouncementType');
  const row = document.getElementById('announcementMediaRow');
  if (!typeEl || !row) return;
  row.style.display = (typeEl.value === 'text') ? 'none' : '';
}
async function saveAnnouncementSetting() {
  const enabled = document.getElementById('settAnnouncementEnabled')?.value === '1';
  const type = document.getElementById('settAnnouncementType')?.value || 'text';
  const text = (document.getElementById('settAnnouncementText')?.value || '').trim();
  const mediaUrl = (document.getElementById('settAnnouncementMediaUrl')?.value || '').trim();
  const linkUrl = (document.getElementById('settAnnouncementLinkUrl')?.value || '').trim();

  if (!['text', 'image', 'video'].includes(type)) {
    showToast('Invalid announcement type', 'error');
    return;
  }
  if (enabled && type === 'text' && !text) {
    showToast('Text is required for text ticker announcement', 'error');
    return;
  }
  if (enabled && (type === 'image' || type === 'video') && !mediaUrl) {
    showToast('Media URL is required for image/video announcement', 'error');
    return;
  }

  const d = await api('update_settings','POST',{
    announcement_enabled: enabled ? 1 : 0,
    announcement_type: type,
    announcement_text: text,
    announcement_media_url: mediaUrl,
    announcement_link_url: linkUrl
  });

  if (d.success) showToast('Announcement saved and published');
  else showToast(d.error||'Failed','error');
}
async function savePasswordSetting() {
  const pw1 = document.getElementById('settPw1').value.trim();
  const pw2 = document.getElementById('settPw2').value.trim();
  if (!pw1) { showToast('Enter a new password','error'); return; }
  if (pw1!==pw2) { showToast('Passwords do not match','error'); return; }
  if (pw1.length<8) { showToast('Minimum 8 characters required','error'); return; }
  const d = await api('update_settings','POST',{admin_password:pw1});
  if (d.success) { showToast('Password changed — logging out…','info'); setTimeout(()=>location.href='admin.php?action=logout',2000); }
  else showToast(d.error||'Failed','error');
}

/* ─── HELPERS ─── */
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(dt) {
  if (!dt) return '—';
  try { return new Date((dt+'').replace(' ','T')+'Z').toLocaleString('en-PK',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
  catch(e) { return dt; }
}

/* ─── INIT ─── */
analyticsRange = '7d';
toggleAnnouncementMediaInput();
loadDashboard();
</script>

<?php endif; ?>
</body>
</html>
