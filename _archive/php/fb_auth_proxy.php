<?php
require_once __DIR__ . '/config/load-env.php';

$allowedOrigins = [
    'https://castmepro.com',
    'https://www.castmepro.com',
    'https://pageinteractorprosite.site',
    'https://www.pageinteractorprosite.site',
    'https://facebook-inbox-production-2a22.up.railway.app',
];

$parentOrigin = trim($_GET['origin'] ?? '');
if (!in_array($parentOrigin, $allowedOrigins, true)) {
    $parentOrigin = 'https://pageinteractorprosite.site';
}
?>
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Connect Facebook</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #18191a; color: #eee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
.wrap { text-align: center; padding: 32px; }
.logo { font-size: 40px; margin-bottom: 16px; }
h2 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
p { color: #aaa; font-size: 13px; margin-bottom: 24px; }
#btnLogin {
  background: #1877f2; color: #fff; border: none; border-radius: 8px;
  padding: 13px 28px; font-size: 15px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; gap: 10px; transition: background .2s;
}
#btnLogin:hover { background: #1565d8; }
#btnLogin:disabled { background: #333; color: #888; cursor: not-allowed; }
.spinner { display: none; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">&#xf09a;</div>
  <h2>Connect with Facebook</h2>
  <p>Click below to authorize FBCast Pro<br>with your Facebook account.</p>
  <button id="btnLogin" onclick="doLogin()">
    <span id="btnSpinner" class="spinner"></span>
    <span id="btnText">Continue with Facebook</span>
  </button>
</div>

<script>
var PARENT_ORIGIN = <?php echo json_encode($parentOrigin); ?>;
var sdkReady = false;

function sendToParent(data) {
  if (window.opener) {
    window.opener.postMessage(data, PARENT_ORIGIN);
  }
  setTimeout(function() { window.close(); }, 400);
}

function doLogin() {
  var btn = document.getElementById('btnLogin');
  btn.disabled = true;
  document.getElementById('btnSpinner').style.display = 'inline-block';
  document.getElementById('btnText').textContent = 'Connecting...';

  if (!sdkReady) {
    setTimeout(doLogin, 300); // wait for SDK
    return;
  }

  FB.login(function(response) {
    if (response && response.authResponse) {
      sendToParent({
        type:      'fb_auth_success',
        token:     response.authResponse.accessToken,
        expiresIn: response.authResponse.expiresIn || 5400
      });
    } else {
      sendToParent({
        type:  'fb_auth_error',
        error: 'Facebook login was cancelled or not authorized.'
      });
    }
  }, { scope: 'pages_show_list,pages_messaging' });
}

window.fbAsyncInit = function() {
  FB.init({
    appId:   <?php echo json_encode(FB_APP_ID); ?>,
    cookie:  true,
    xfbml:   false,
    version: 'v21.0'
  });
  sdkReady = true;
};

(function(d, s, id) {
  var js, fjs = d.getElementsByTagName(s)[0];
  if (d.getElementById(id)) return;
  js = d.createElement(s); js.id = id;
  js.src = 'https://connect.facebook.net/en_US/sdk.js';
  fjs.parentNode.insertBefore(js, fjs);
}(document, 'script', 'facebook-jssdk'));
</script>
</body>
</html>
