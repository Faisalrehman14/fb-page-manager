<?php
declare(strict_types=1);

/**
 * Thin wrapper around the Facebook Graph API.
 * All HTTP calls live here — nothing else touches cURL for FB requests.
 */
class FacebookClient
{
    private string $apiVer;

    public function __construct(private readonly string $token)
    {
        $this->apiVer = defined('FB_API_VER') ? FB_API_VER : 'v19.0';
    }

    // ── Public API ───────────────────────────────────────────────────────────

    public function getUserProfile(string $psid): array
    {
        return $this->get($psid, ['fields' => 'name,profile_pic']);
    }

    public function getConversations(string $pageId, int $since, string $cursor = ''): array
    {
        $params = [
            'fields' => 'id,updated_time,participants,snippet',
            'limit'  => 50,
            'since'  => $since,
        ];
        if ($cursor) $params['after'] = $cursor;
        return $this->get("{$pageId}/conversations", $params);
    }

    public function sendText(string $psid, string $text): array
    {
        return $this->post('me/messages', [
            'recipient' => ['id' => $psid],
            'message'   => ['text' => $text],
        ]);
    }

    public function sendImage(string $psid, string $imageUrl): array
    {
        return $this->post('me/messages', [
            'recipient' => ['id' => $psid],
            'message'   => [
                'attachment' => [
                    'type'    => 'image',
                    'payload' => ['url' => $imageUrl, 'is_reusable' => true],
                ],
            ],
        ]);
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    public function get(string $path, array $params = []): array
    {
        $params['access_token'] = $this->token;
        $url = "https://graph.facebook.com/{$this->apiVer}/" . ltrim($path, '/') . '?' . http_build_query($params);
        return $this->curl($url);
    }

    private function post(string $path, array $payload): array
    {
        $payload['access_token'] = $this->token;
        $url = "https://graph.facebook.com/{$this->apiVer}/" . ltrim($path, '/');
        return $this->curl($url, $payload);
    }

    private function curl(string $url, ?array $postData = null): array
    {
        $ch = curl_init($url);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 12,
            CURLOPT_SSL_VERIFYPEER => true,
        ];
        if ($postData !== null) {
            $opts[CURLOPT_POST]       = true;
            $opts[CURLOPT_POSTFIELDS] = json_encode($postData);
            $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
        }
        curl_setopt_array($ch, $opts);
        $body = curl_exec($ch);
        $err  = curl_error($ch);
        curl_close($ch);

        if ($err) return ['error' => ['message' => 'Network error: ' . $err]];
        return json_decode($body ?: '{}', true) ?: [];
    }
}
