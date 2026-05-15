<?php

declare(strict_types=1);

/**
 * Graphify generator
 * Builds a lightweight architecture map so contributors can inspect structure quickly.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Unable to resolve project root.\n");
    exit(1);
}

$outputFile = $root . '/graphify.json';
$aiSummaryFile = $root . '/graphify-ai.md';
$skipDirs = ['.git', 'logs', 'pics', 'node_modules', 'vendor'];
$allowedExtensions = ['php', 'js', 'css', 'md', 'html'];

$files = [];
$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
);

foreach ($iterator as $fileInfo) {
    if (!$fileInfo->isFile()) {
        continue;
    }

    $absolutePath = $fileInfo->getPathname();
    $relativePath = ltrim(str_replace($root, '', $absolutePath), DIRECTORY_SEPARATOR);

    if ($relativePath === 'graphify.json') {
        continue;
    }

    $parts = explode(DIRECTORY_SEPARATOR, $relativePath);
    if (array_intersect($skipDirs, $parts)) {
        continue;
    }

    $ext = strtolower((string) pathinfo($relativePath, PATHINFO_EXTENSION));
    if (!in_array($ext, $allowedExtensions, true)) {
        continue;
    }

    $files[] = [
        'path' => $relativePath,
        'ext' => $ext,
        'size' => $fileInfo->getSize(),
    ];
}

usort($files, static fn (array $a, array $b): int => strcmp($a['path'], $b['path']));

$nodes = [];
$edges = [];
$externalHosts = [];
$summary = [
    'php' => 0,
    'js' => 0,
    'css' => 0,
    'docs' => 0,
    'html' => 0,
];

$pathSet = array_fill_keys(array_column($files, 'path'), true);

foreach ($files as $file) {
    $path = $file['path'];
    $ext = $file['ext'];
    $contents = @file_get_contents($root . '/' . $path);

    if ($contents === false) {
        continue;
    }

    $type = match ($ext) {
        'php' => 'backend',
        'js' => 'frontend',
        'css' => 'styles',
        'md' => 'docs',
        default => 'markup',
    };

    if ($ext === 'php') {
        $summary['php']++;
    } elseif ($ext === 'js') {
        $summary['js']++;
    } elseif ($ext === 'css') {
        $summary['css']++;
    } elseif ($ext === 'md') {
        $summary['docs']++;
    } elseif ($ext === 'html') {
        $summary['html']++;
    }

    $nodes[] = [
        'id' => $path,
        'type' => $type,
        'size' => $file['size'],
    ];

    if ($ext === 'php') {
        if (preg_match_all("#\\b(?:require|include)(?:_once)?\\s*(?:\\(\\s*)?['\"]([^'\"]+)['\"]#i", $contents, $matches)) {
            foreach ($matches[1] as $includeTarget) {
                $normalized = str_replace('\\\\', '/', $includeTarget);
                $normalized = ltrim($normalized, './');

                // Best-effort resolution for __DIR__ usage.
                if (str_contains($includeTarget, '__DIR__')) {
                    continue;
                }

                $candidate = $normalized;
                if (isset($pathSet[$candidate])) {
                    $edges[] = [
                        'from' => $path,
                        'to' => $candidate,
                        'kind' => 'include',
                    ];
                }
            }
        }
    }

    if ($ext === 'js' || $ext === 'php' || $ext === 'html') {
        if (preg_match_all("#https?://([^/\"'\\s)]+)#i", $contents, $matches)) {
            foreach ($matches[1] as $host) {
                $externalHosts[strtolower($host)] = true;
            }
        }

        if (preg_match_all("#(?:fetch|axios\\.(?:get|post|put|delete)|XMLHttpRequest).*?['\"](/?[A-Za-z0-9_\\-/]+\\.php(?:\\?[^'\"]*)?)['\"]#si", $contents, $routeMatches)) {
            foreach ($routeMatches[1] as $route) {
                $routePath = ltrim(parse_url($route, PHP_URL_PATH) ?? '', '/');
                if ($routePath !== '' && isset($pathSet[$routePath])) {
                    $edges[] = [
                        'from' => $path,
                        'to' => $routePath,
                        'kind' => 'calls',
                    ];
                }
            }
        }
    }
}

$entrypoints = array_values(array_filter(
    array_column($files, 'path'),
    static fn (string $path): bool => preg_match('/^[^\/]+\\.php$/', $path) === 1
));

$result = [
    'name' => 'FBCast Pro Graphify Map',
    'generated_at' => gmdate('c'),
    'project_root' => basename($root),
    'summary' => [
        'total_files' => count($files),
        'entrypoints' => count($entrypoints),
        'types' => $summary,
        'external_hosts' => array_values(array_keys($externalHosts)),
    ],
    'entrypoints' => $entrypoints,
    'nodes' => $nodes,
    'edges' => array_values(array_unique($edges, SORT_REGULAR)),
    'notes' => [
        'Graph is static analysis only and may miss dynamic runtime paths.',
        'Regenerate with: php scripts/generate_graphify.php',
    ],
];

$json = json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
if ($json === false) {
    fwrite(STDERR, "Failed to encode Graphify JSON.\n");
    exit(1);
}

if (@file_put_contents($outputFile, $json . PHP_EOL) === false) {
    fwrite(STDERR, "Failed to write graphify.json.\n");
    exit(1);
}

$topEntrypoints = array_slice($entrypoints, 0, 15);
$topEdges = array_slice($result['edges'], 0, 80);
$typeSummary = $result['summary']['types'];

$markdown = "# Graphify AI Context\n\n";
$markdown .= "Generated at (UTC): " . $result['generated_at'] . "\n\n";
$markdown .= "Use this file before scanning the full repository.\n\n";
$markdown .= "## Quick Summary\n";
$markdown .= "- Total tracked files: " . $result['summary']['total_files'] . "\n";
$markdown .= "- PHP entrypoints: " . $result['summary']['entrypoints'] . "\n";
$markdown .= "- Types: php={$typeSummary['php']}, js={$typeSummary['js']}, css={$typeSummary['css']}, docs={$typeSummary['docs']}, html={$typeSummary['html']}\n\n";

$markdown .= "## Primary Entrypoints\n";
foreach ($topEntrypoints as $entrypoint) {
    $markdown .= "- " . $entrypoint . "\n";
}
$markdown .= "\n";

$markdown .= "## Detected Relations (from -> to)\n";
foreach ($topEdges as $edge) {
    $kind = $edge['kind'] ?? 'link';
    $markdown .= "- [" . $kind . "] " . $edge['from'] . " -> " . $edge['to'] . "\n";
}
$markdown .= "\n";

$markdown .= "## External Hosts\n";
if (empty($result['summary']['external_hosts'])) {
    $markdown .= "- none\n";
} else {
    foreach ($result['summary']['external_hosts'] as $host) {
        $markdown .= "- " . $host . "\n";
    }
}
$markdown .= "\n";

$markdown .= "## Usage For AI Agents\n";
$markdown .= "- Start with AGENTS.md and this file.\n";
$markdown .= "- Open only files related to requested feature/bug from entrypoints/relations above.\n";
$markdown .= "- Regenerate after structural changes: `php scripts/generate_graphify.php`.\n";

if (@file_put_contents($aiSummaryFile, $markdown) === false) {
    fwrite(STDERR, "Failed to write graphify-ai.md.\n");
    exit(1);
}

echo "Graphify map generated: {$outputFile}\n";
echo "AI summary generated: {$aiSummaryFile}\n";
