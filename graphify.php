<?php

declare(strict_types=1);

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$mapFile = __DIR__ . '/graphify.json';
$map = null;
$error = null;

if (!file_exists($mapFile)) {
    $error = 'graphify.json not found. Run: php scripts/generate_graphify.php';
} else {
    $json = file_get_contents($mapFile);
    $decoded = $json ? json_decode($json, true) : null;

    if (!is_array($decoded)) {
        $error = 'graphify.json exists but is invalid JSON. Regenerate the map.';
    } else {
        $map = $decoded;
    }
}

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Graphify | FBCast Pro</title>
<style>
:root {
    --bg: #f4f7fb;
    --card: #ffffff;
    --ink: #11203b;
    --muted: #52607a;
    --line: #dde5f2;
    --accent: #0f6ef2;
    --accent-soft: #e7f0ff;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    font-family: "Plus Jakarta Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(circle at top right, #dbe9ff 0%, var(--bg) 45%, #edf3ff 100%);
    color: var(--ink);
}
.wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: 28px 18px 40px;
}
.hero {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 14px;
    align-items: center;
    margin-bottom: 18px;
}
.hero h1 {
    margin: 0;
    font-size: clamp(1.5rem, 3vw, 2.1rem);
}
.hero p {
    margin: 4px 0 0;
    color: var(--muted);
}
.card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 16px;
    box-shadow: 0 10px 26px rgba(9, 36, 82, 0.08);
}
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 14px;
}
.stat strong {
    display: block;
    font-size: 1.3rem;
}
.stat span {
    color: var(--muted);
    font-size: 0.9rem;
}
.list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
}
.row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    font-size: 0.92rem;
    background: #fcfdff;
}
.row code {
    color: #1f427a;
    word-break: break-all;
}
.muted { color: var(--muted); }
.badge {
    display: inline-block;
    border-radius: 999px;
    padding: 6px 10px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    font-size: 0.8rem;
}
.section-title {
    margin: 12px 0 8px;
    font-size: 1rem;
}
.error {
    border: 1px solid #f2c9c9;
    background: #fff5f5;
    color: #7b1717;
    border-radius: 10px;
    padding: 12px;
}
pre {
    margin: 0;
    background: #08152a;
    color: #d9e8ff;
    border-radius: 10px;
    padding: 12px;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    overflow: auto;
    max-height: 360px;
}
@media (max-width: 640px) {
    .row {
        flex-direction: column;
    }
}
</style>
</head>
<body>
<div class="wrap">
    <div class="hero">
        <div>
            <h1>Graphify Map</h1>
            <p>Quick architecture snapshot for faster onboarding and debugging.</p>
        </div>
        <span class="badge">FBCast Pro</span>
    </div>

    <?php if ($error): ?>
        <div class="error"><?php echo h($error); ?></div>
    <?php else: ?>
        <?php
            $summary = $map['summary'] ?? [];
            $types = $summary['types'] ?? [];
            $entrypoints = $map['entrypoints'] ?? [];
            $edges = $map['edges'] ?? [];
            $hosts = $summary['external_hosts'] ?? [];
        ?>
        <div class="grid">
            <div class="card stat"><strong><?php echo (int) ($summary['total_files'] ?? 0); ?></strong><span>Tracked Files</span></div>
            <div class="card stat"><strong><?php echo (int) ($summary['entrypoints'] ?? 0); ?></strong><span>PHP Entrypoints</span></div>
            <div class="card stat"><strong><?php echo (int) count($edges); ?></strong><span>Detected Links</span></div>
            <div class="card stat"><strong><?php echo h((string) ($map['generated_at'] ?? '')); ?></strong><span>Generated (UTC)</span></div>
        </div>

        <div class="card" style="margin-bottom: 12px;">
            <h2 class="section-title">File Types</h2>
            <div class="list">
                <?php foreach ($types as $name => $count): ?>
                    <div class="row"><span><?php echo h((string) strtoupper((string) $name)); ?></span><strong><?php echo (int) $count; ?></strong></div>
                <?php endforeach; ?>
            </div>
        </div>

        <div class="card" style="margin-bottom: 12px;">
            <h2 class="section-title">Entrypoints</h2>
            <div class="list">
                <?php foreach ($entrypoints as $path): ?>
                    <div class="row"><code><?php echo h((string) $path); ?></code></div>
                <?php endforeach; ?>
            </div>
        </div>

        <div class="card" style="margin-bottom: 12px;">
            <h2 class="section-title">External Hosts</h2>
            <div class="list">
                <?php if (empty($hosts)): ?>
                    <div class="row muted">No external hosts detected.</div>
                <?php else: ?>
                    <?php foreach ($hosts as $host): ?>
                        <div class="row"><code><?php echo h((string) $host); ?></code></div>
                    <?php endforeach; ?>
                <?php endif; ?>
            </div>
        </div>

        <div class="card">
            <h2 class="section-title">Raw Graph Data (JSON)</h2>
            <pre><?php echo h((string) json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)); ?></pre>
        </div>
    <?php endif; ?>
</div>
</body>
</html>
