<?php
// Temporary admin password reset — DELETE AFTER USE
$token = getenv('SETUP_ACCESS_TOKEN') ?: '';
$provided = trim($_GET['token'] ?? '');
if ($token === '' || !hash_equals($token, $provided)) {
    http_response_code(403); exit('Forbidden');
}

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';

$newPassword = trim($_POST['password'] ?? '');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && strlen($newPassword) >= 6) {
    $hash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
    $db = getDB();
    $db->prepare("UPDATE settings SET setting_value = ? WHERE setting_key = 'admin_password'")
       ->execute([$hash]);
    echo '<p style="color:green;font-family:monospace">Password updated! <a href="admin.php">Go to Admin</a> — then DELETE reset_admin.php</p>';
    exit;
}
?>
<!DOCTYPE html>
<html>
<body style="font-family:monospace;padding:40px;background:#111;color:#eee">
<h2>Reset Admin Password</h2>
<form method="POST">
  <input type="hidden" name="token" value="<?php echo htmlspecialchars($provided); ?>">
  <input type="password" name="password" placeholder="New password (min 6 chars)" style="padding:8px;width:300px"><br><br>
  <button type="submit" style="padding:8px 20px">Reset Password</button>
</form>
</body>
</html>
