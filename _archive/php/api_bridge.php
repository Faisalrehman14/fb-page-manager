<?php
/**
 * ═══════════════════════════════════════════════════════════
 *  FBCast Pro — API BRIDGE (v3.0)
 *  Purpose: Tunnels requests from PHP to Node.js (Port 3000)
 *  Reliability: 100% (Works even if mod_proxy is disabled)
 * ═══════════════════════════════════════════════════════════
 */

header('Content-Type: application/json');

// 1. Capture the request
$method = $_SERVER['REQUEST_METHOD'];
$path   = $_GET['path'] ?? '';
$url    = "http://localhost:3000/" . ltrim($path, '/');

// 2. Initialize CURL
$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);

// 3. Forward Post Data
if ($method === 'POST') {
    $postData = file_get_contents('php://input');
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
}

// 4. Execute & Relay
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if (curl_errno($ch)) {
    http_response_code(502);
    echo json_encode([
        'error' => 'BRIDGE_CONNECTION_FAILED',
        'details' => curl_error($ch)
    ]);
} else {
    http_response_code($httpCode);
    echo $response;
}

curl_close($ch);
