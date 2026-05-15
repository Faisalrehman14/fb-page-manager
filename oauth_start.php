<?php
/**
 * oauth_start.php
 * Initiates the Facebook OAuth Authorization Code flow.
 * Opens from a popup — redirects to Facebook's official OAuth dialog.
 */

require_once __DIR__ . '/config/load-env.php';

// Generate a CSRF state token and store it in session
$state = bin2hex(random_bytes(16));
$_SESSION['fb_oauth_state'] = $state;
$_SESSION['fb_oauth_ts']    = time();

// The redirect_uri must be registered in your Facebook App's OAuth settings:
// Facebook Developer Console → Your App → Facebook Login → Settings → Valid OAuth Redirect URIs
// Add: https://yourdomain.com/oauth_callback.php
$redirectUri = rtrim(SITE_URL, '/') . '/oauth_callback.php';

$oauthUrl = 'https://www.facebook.com/dialog/oauth?' . http_build_query([
    'client_id'     => FB_APP_ID,
    'redirect_uri'  => $redirectUri,
    'scope'         => 'pages_show_list,pages_messaging',
    'response_type' => 'code',
    'state'         => $state,
]);

header('Location: ' . $oauthUrl);
exit;
