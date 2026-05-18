<?php
/**
 * oauth_callback.php
 * Handles the Facebook OAuth Authorization Code callback.
 *
 * Flow:
 *   1. Validates CSRF state parameter
 *   2. Exchanges authorization code → short-lived token (server-side)
 *   3. Exchanges short-lived → long-lived user token (~60 days)
 *   4. Fetches all Facebook Pages with long-lived page tokens
 *   5. Sends result back to opener window via postMessage, then closes
 *
 * IMPORTANT: Register this URL in Facebook Developer Console:
 *   App → Facebook Login → Settings → Valid OAuth Redirect URIs
 *   Add: https://yourdomain.com/oauth_callback.php
 */

require_once __DIR__ . '/config/load-env.php';

// ── Helpers ────────────────────────────────────────────────────────────────

function fb_curl_get(string $url): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'FBCastPro-OAuth/2.0',
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($err || !$body) return null;
    return json_decode($body, true) ?: null;
}

function send_popup_result(array $data): never {
    $parentOrigin = rtrim(SITE_URL, '/');
    $json         = json_encode($data, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
    ?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connecting Facebook — FBCast Pro</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0d14;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    color: #f1f5f9;
  }
  .card {
    background: #161b26;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 16px;
    padding: 48px 40px;
    text-align: center;
    max-width: 340px;
    width: 100%;
  }
  .fb-icon {
    width: 56px;
    height: 56px;
    background: #1877f2;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    font-size: 28px;
    color: #fff;
    font-weight: 900;
  }
  .spinner {
    width: 48px;
    height: 48px;
    border: 3px solid rgba(255,255,255,.1);
    border-top-color: #1877f2;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 20px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h2 { font-size: 16px; font-weight: 700; margin-bottom: 8px; color: #f1f5f9; }
  p  { font-size: 13px; color: rgba(255,255,255,.5); line-height: 1.5; }
  .error-icon { font-size: 40px; margin-bottom: 16px; }
  .error-msg  { color: #ef4444; font-size: 13px; margin-top: 12px; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="spinner" id="spinner"></div>
  <h2 id="title">Connecting your Facebook account…</h2>
  <p id="sub">This window will close automatically.</p>
  <p class="error-msg" id="errMsg" style="display:none"></p>
</div>
<script>
(function () {
  var RESULT   = <?php echo $json; ?>;
  var ORIGIN   = <?php echo json_encode($parentOrigin); ?>;
  var attempts = 0;
  var maxTries = 20;
  var sent     = false;

  function showError(msg) {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('title').textContent = 'Connection failed';
    document.getElementById('sub').style.display = 'none';
    var e = document.getElementById('errMsg');
    e.textContent = msg;
    e.style.display = 'block';
  }

  function trySend() {
    if (sent) return;
    if (!window.opener) {
      if (++attempts < maxTries) {
        setTimeout(trySend, 150);
      } else {
        showError('Could not communicate with the parent window. Please close this tab and try again.');
      }
      return;
    }
    sent = true;
    window.opener.postMessage(RESULT, ORIGIN);
    setTimeout(function () { window.close(); }, 800);
  }

  trySend();
})();
</script>
</body>
</html>
<?php
    exit;
}

// ── 1. Validate CSRF state ─────────────────────────────────────────────────

$state       = $_GET['state'] ?? '';
$storedState = $_SESSION['fb_oauth_state'] ?? '';
$oauthTs     = (int)($_SESSION['fb_oauth_ts'] ?? 0);

// State must match and be less than 10 minutes old
if (
    !$state
    || !$storedState
    || !hash_equals($storedState, $state)
    || (time() - $oauthTs) > 600
) {
    send_popup_result([
        'type'  => 'fb_auth_error',
        'error' => 'Security check failed. Please close this window and try again.',
    ]);
}

unset($_SESSION['fb_oauth_state'], $_SESSION['fb_oauth_ts']);

// ── 2. Check for Facebook-side errors ─────────────────────────────────────

if (isset($_GET['error'])) {
    $errMsg = htmlspecialchars($_GET['error_description'] ?? 'Facebook authorization was denied.', ENT_QUOTES, 'UTF-8');
    send_popup_result(['type' => 'fb_auth_error', 'error' => $errMsg]);
}

// ── 3. Exchange authorization code → short-lived token ────────────────────

$code        = $_GET['code'] ?? '';
$redirectUri = rtrim(SITE_URL, '/') . '/oauth_callback.php';

if (!$code) {
    send_popup_result(['type' => 'fb_auth_error', 'error' => 'No authorization code received from Facebook.']);
}

$tokenData = fb_curl_get(
    'https://graph.facebook.com/' . FB_API_VER . '/oauth/access_token?' . http_build_query([
        'client_id'     => FB_APP_ID,
        'client_secret' => FB_APP_SECRET,
        'redirect_uri'  => $redirectUri,
        'code'          => $code,
    ])
);

if (!$tokenData || empty($tokenData['access_token'])) {
    $msg = $tokenData['error']['message'] ?? 'Code exchange with Facebook failed.';
    send_popup_result(['type' => 'fb_auth_error', 'error' => 'Authentication error: ' . $msg]);
}

$shortToken = $tokenData['access_token'];

// ── 4. Exchange short-lived → long-lived user token (~60 days) ────────────

$longData = fb_curl_get(
    'https://graph.facebook.com/' . FB_API_VER . '/oauth/access_token?' . http_build_query([
        'grant_type'        => 'fb_exchange_token',
        'client_id'         => FB_APP_ID,
        'client_secret'     => FB_APP_SECRET,
        'fb_exchange_token' => $shortToken,
    ])
);

$userToken = (!empty($longData['access_token'])) ? $longData['access_token'] : $shortToken;
$expiresIn = (!empty($longData['expires_in']))   ? (int)$longData['expires_in'] : 5184000; // ~60 days

// ── 5. Fetch Facebook Pages with long-lived page tokens ───────────────────

$pagesData = fb_curl_get(
    'https://graph.facebook.com/' . FB_API_VER . '/me/accounts?' . http_build_query([
        'fields'       => 'id,name,access_token,category,picture.type(large)',
        'access_token' => $userToken,
    ])
);

$pages = is_array($pagesData['data'] ?? null) ? $pagesData['data'] : [];

// ── 6. Return success to parent window ────────────────────────────────────

send_popup_result([
    'type'      => 'fb_auth_success',
    'token'     => $userToken,
    'expiresIn' => $expiresIn,
    'pages'     => $pages,
]);
