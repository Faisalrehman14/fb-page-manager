<?php
// upload_image.php — Secure image upload for broadcast attachments
define('FBCAST_PAGE_CONTEXT', true);

$config_file = __DIR__ . '/config/load-env.php';
if (file_exists($config_file)) {
    try { require_once $config_file; } catch (Throwable $e) {}
}

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

// CSRF validation
$csrfToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf_token'] ?? '';
if (function_exists('validateCsrfToken') && !validateCsrfToken($csrfToken)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Invalid CSRF token.']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method not allowed.']);
    exit;
}

if (empty($_FILES['image']) || $_FILES['image']['error'] === UPLOAD_ERR_NO_FILE) {
    echo json_encode(['success' => false, 'error' => 'No file uploaded.']);
    exit;
}

$file = $_FILES['image'];
$maxSize = 5 * 1024 * 1024; // 5 MB

if ($file['error'] !== UPLOAD_ERR_OK) {
    $errMap = [
        UPLOAD_ERR_INI_SIZE   => 'File exceeds server limit.',
        UPLOAD_ERR_FORM_SIZE  => 'File too large.',
        UPLOAD_ERR_PARTIAL    => 'File upload incomplete.',
        UPLOAD_ERR_NO_TMP_DIR => 'Server temp dir missing.',
        UPLOAD_ERR_CANT_WRITE => 'Server write error.',
    ];
    echo json_encode(['success' => false, 'error' => $errMap[$file['error']] ?? 'Upload error.']);
    exit;
}

if ($file['size'] > $maxSize) {
    echo json_encode(['success' => false, 'error' => 'File too large. Maximum 5 MB.']);
    exit;
}

// Validate real MIME type using finfo
$finfo = finfo_open(FILEINFO_MIME_TYPE);
$mime  = finfo_file($finfo, $file['tmp_name']);
finfo_close($finfo);

$allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
if (!in_array($mime, $allowed, true)) {
    echo json_encode(['success' => false, 'error' => 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP.']);
    exit;
}

$extMap = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
$ext = $extMap[$mime];

// Create uploads dir if missing
$uploadDir = __DIR__ . '/uploads/';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
    // Prevent directory listing
    file_put_contents($uploadDir . '.htaccess', "Options -Indexes\n");
}

$filename = bin2hex(random_bytes(16)) . '.' . $ext;
$filepath = $uploadDir . $filename;

if (!move_uploaded_file($file['tmp_name'], $filepath)) {
    echo json_encode(['success' => false, 'error' => 'Could not save file on server.']);
    exit;
}

// Build public URL
$scheme  = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host    = $_SERVER['HTTP_HOST'] ?? '';
$siteUrl = (defined('SITE_URL') && SITE_URL) ? rtrim(SITE_URL, '/') : ($host ? "$scheme://$host" : '');
$url     = $siteUrl . '/uploads/' . $filename;

echo json_encode(['success' => true, 'url' => $url, 'filename' => $filename]);
