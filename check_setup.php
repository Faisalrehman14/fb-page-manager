<?php
/**
 * check_setup.php — Run this ONCE on Hostinger to diagnose issues.
 * DELETE this file after checking. Never leave it public!
 */
$setupToken = getenv('SETUP_ACCESS_TOKEN') ?: '';
if (php_sapi_name() !== 'cli') {
    $providedToken = trim($_GET['token'] ?? '');
    if ($setupToken === '' || !hash_equals($setupToken, $providedToken)) {
        http_response_code(403);
        exit('Forbidden');
    }
}

define('FBCAST_PAGE_CONTEXT', true);
$checks = [];

// 1. PHP Version
$checks['PHP Version'] = ['value' => PHP_VERSION, 'ok' => version_compare(PHP_VERSION, '8.0', '>=')];

// 2. Config file exists
$checks['config/load-env.php exists'] = ['value' => file_exists(__DIR__.'/config/load-env.php') ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/config/load-env.php')];
$checks['config/csrf.php exists']     = ['value' => file_exists(__DIR__.'/config/csrf.php')     ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/config/csrf.php')];
$checks['config/logger.php exists']   = ['value' => file_exists(__DIR__.'/config/logger.php')   ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/config/logger.php')];
$checks['.env in project root']       = ['value' => file_exists(__DIR__.'/.env') ? 'YES' : 'NO', 'ok' => true];
$checks['create_checkout.php exists'] = ['value' => file_exists(__DIR__.'/create_checkout.php') ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/create_checkout.php')];
$checks['db_config.php exists']       = ['value' => file_exists(__DIR__.'/db_config.php')       ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/db_config.php')];
$checks['get_csrf.php exists']        = ['value' => file_exists(__DIR__.'/get_csrf.php')         ? 'YES' : 'MISSING', 'ok' => file_exists(__DIR__.'/get_csrf.php')];

// 3. Load config
$configLoaded = false;
try {
    if (file_exists(__DIR__.'/config/load-env.php')) {
        require_once __DIR__.'/config/load-env.php';
        $configLoaded = true;
    }
} catch (Throwable $e) {
    $checks['Config Load'] = ['value' => 'FAILED: '.$e->getMessage(), 'ok' => false];
}

if ($configLoaded) {
    $checks['Env file used'] = [
        'value' => defined('FBCAST_ENV_FILE_PATH') ? FBCAST_ENV_FILE_PATH : 'NOT FOUND (using server env vars only)',
        'ok' => true
    ];

    // 4. DB credentials
    $checks['DB_HOST']      = ['value' => defined('DB_HOST') ? DB_HOST : 'NOT SET', 'ok' => defined('DB_HOST') && DB_HOST !== ''];
    $checks['DB_NAME']      = ['value' => defined('DB_NAME') ? DB_NAME : 'NOT SET', 'ok' => defined('DB_NAME') && DB_NAME !== '' && strpos(DB_NAME,'123456789') === false];
    $checks['DB_USER']      = ['value' => defined('DB_USER') ? DB_USER : 'NOT SET', 'ok' => defined('DB_USER') && DB_USER !== ''];
    $checks['DB_PASS']      = ['value' => defined('DB_PASS') && DB_PASS !== '' ? '*** SET ***' : 'EMPTY!', 'ok' => defined('DB_PASS') && DB_PASS !== ''];

    // 5. Stripe
    $sk = defined('STRIPE_SECRET_KEY') ? STRIPE_SECRET_KEY : '';
    $pk = defined('STRIPE_PUBLISHABLE_KEY') ? STRIPE_PUBLISHABLE_KEY : '';
    $bprice = defined('STRIPE_PLANS') ? STRIPE_PLANS['basic']['price_id'] : '';
    $pprice = defined('STRIPE_PLANS') ? STRIPE_PLANS['pro']['price_id']   : '';
    $uprice = defined('STRIPE_PLANS') ? (STRIPE_PLANS['unlimited']['price_id'] ?? '') : '';

    $checks['STRIPE_SECRET_KEY']      = ['value' => $sk ? substr($sk,0,10).'...' : 'NOT SET', 'ok' => $sk && strpos($sk,'YOUR') === false && strpos($sk,'_HERE') === false];
    $checks['STRIPE_PUBLISHABLE_KEY'] = ['value' => $pk ? substr($pk,0,10).'...' : 'NOT SET', 'ok' => $pk && strpos($pk,'YOUR') === false && strpos($pk,'_HERE') === false];
    $checks['STRIPE_BASIC_PRICE_ID']  = ['value' => $bprice ?: 'NOT SET', 'ok' => $bprice && strpos($bprice,'YOUR') === false && strpos($bprice,'PLACEHOLDER') === false && strpos($bprice,'_HERE') === false];
    $checks['STRIPE_PRO_PRICE_ID']    = ['value' => $pprice ?: 'NOT SET', 'ok' => $pprice && strpos($pprice,'YOUR') === false && strpos($pprice,'PLACEHOLDER') === false && strpos($pprice,'_HERE') === false];
    $checks['STRIPE_UNLIMITED_PRICE_ID'] = ['value' => $uprice ?: 'NOT SET', 'ok' => $uprice && strpos($uprice,'YOUR') === false && strpos($uprice,'PLACEHOLDER') === false && strpos($uprice,'_HERE') === false];

    // 6. FB Config
    $checks['FB_APP_ID']     = ['value' => defined('FB_APP_ID')     && FB_APP_ID     ? FB_APP_ID     : 'NOT SET', 'ok' => defined('FB_APP_ID') && FB_APP_ID !== ''];
    $checks['FB_REDIRECT_URI']= ['value' => defined('FB_REDIRECT_URI') ? FB_REDIRECT_URI : 'NOT SET', 'ok' => defined('FB_REDIRECT_URI') && strpos(FB_REDIRECT_URI,'yoursite.com') === false && strpos(FB_REDIRECT_URI,'https:https') === false];
    $checks['SITE_URL']      = ['value' => defined('SITE_URL') ? SITE_URL : 'NOT SET', 'ok' => defined('SITE_URL') && strpos(SITE_URL,'yoursite.com') === false];
    $checks['CONTACT_EMAIL'] = ['value' => defined('CONTACT_EMAIL') ? CONTACT_EMAIL : 'NOT SET', 'ok' => defined('CONTACT_EMAIL') && strpos(CONTACT_EMAIL,'your@') === false];

    // 7. DB Connection test
    try {
        require_once __DIR__.'/db_config.php';
        $db = getDB();
        $db->query('SELECT 1');
        $checks['Database Connection'] = ['value' => 'CONNECTED OK', 'ok' => true];
    } catch (Throwable $e) {
        $checks['Database Connection'] = ['value' => 'FAILED: '.$e->getMessage(), 'ok' => false];
    }

    // 8. cURL check
    $checks['cURL Extension']  = ['value' => extension_loaded('curl') ? 'ENABLED' : 'MISSING', 'ok' => extension_loaded('curl')];
    $checks['PDO Extension']   = ['value' => extension_loaded('pdo')  ? 'ENABLED' : 'MISSING', 'ok' => extension_loaded('pdo')];
    $checks['PDO MySQL']       = ['value' => extension_loaded('pdo_mysql') ? 'ENABLED' : 'MISSING', 'ok' => extension_loaded('pdo_mysql')];

    // 9. Stripe API test (only if keys look real)
    if ($sk && strpos($sk,'YOUR') === false && extension_loaded('curl')) {
        $ch = curl_init('https://api.stripe.com/v1/account');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_USERPWD=>$sk.':', CURLOPT_TIMEOUT=>10, CURLOPT_SSL_VERIFYPEER=>true]);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $data = json_decode($res, true);
        if ($code === 200) {
            $checks['Stripe API Connection'] = ['value' => 'OK — Account: '.($data['id']??'unknown'), 'ok' => true];
        } else {
            $checks['Stripe API Connection'] = ['value' => "FAILED (HTTP $code): ".substr($res,0,100), 'ok' => false];
        }
    }
}

// ── Output ──
$allOk = array_reduce($checks, fn($carry, $c) => $carry && $c['ok'], true);
?>
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>FBCast Pro — Setup Check</title>
<style>
body { font-family: monospace; background: #0d1220; color: #e4e6eb; padding: 30px; }
h1 { color: #1877f2; margin-bottom: 4px; }
.subtitle { color: #6b7280; margin-bottom: 30px; font-size: 13px; }
table { border-collapse: collapse; width: 100%; max-width: 700px; }
td, th { padding: 10px 14px; border: 1px solid rgba(255,255,255,.08); font-size: 13px; }
th { background: rgba(255,255,255,.05); color: #9ca3af; text-align: left; }
.ok   { color: #22c55e; }
.fail { color: #ef4444; font-weight: bold; }
.summary { margin-top: 20px; padding: 16px 20px; border-radius: 10px; font-size: 14px; font-weight: bold; }
.summary.good { background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.3); color: #22c55e; }
.summary.bad  { background: rgba(239,68,68,.1);  border: 1px solid rgba(239,68,68,.3);  color: #ef4444; }
.warn-box { margin-top: 16px; padding: 14px 18px; background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.3); border-radius: 10px; color: #f59e0b; font-size: 13px; }
</style>
</head>
<body>
<h1>FBCast Pro — Setup Diagnostic</h1>
<div class="subtitle">⚠️ DELETE this file after checking! Never leave it public.</div>

<table>
<tr><th>Check</th><th>Value</th><th>Status</th></tr>
<?php foreach ($checks as $name => $c): ?>
<tr>
  <td><?= htmlspecialchars($name) ?></td>
  <td><?= htmlspecialchars($c['value']) ?></td>
  <td class="<?= $c['ok'] ? 'ok' : 'fail' ?>"><?= $c['ok'] ? '✓ OK' : '✗ FIX THIS' ?></td>
</tr>
<?php endforeach; ?>
</table>

<div class="summary <?= $allOk ? 'good' : 'bad' ?>">
  <?= $allOk ? '✓ All checks passed!' : '✗ Some issues found — fix the red items above.' ?>
</div>

<?php if (!($checks['STRIPE_BASIC_PRICE_ID']['ok'] ?? false) || !($checks['STRIPE_PRO_PRICE_ID']['ok'] ?? false) || !($checks['STRIPE_UNLIMITED_PRICE_ID']['ok'] ?? false)): ?>
<div class="warn-box">
  <strong>⚠️ Stripe Price IDs Missing!</strong><br>
  Stripe Dashboard → Products → create Basic ($25/mo), Pro ($50/mo), and Unlimited ($300/year) prices → copy Price IDs → paste in .env.
</div>
<?php endif; ?>

</body>
</html>
