/**
 * AI Broadcast Assistant — server-side proxy for OpenAI-compatible (Groq)
 * or Anthropic-compatible chat APIs. Keeps the API key out of the browser.
 */
'use strict';

const SYSTEM_PROMPT = `You are the AI Broadcast Assistant inside FBCast Pro — a SaaS platform that lets businesses send broadcast messages to their Facebook Page subscribers on Messenger.

Your job is to help the user write high-converting, friendly, brand-safe broadcast messages for their Page audience.

## Core rules
- Keep every broadcast message under 1000 characters (Facebook Messenger limit). Aim for 300-600 characters for best engagement.
- Be warm, conversational, and direct — like a real human writing from a small business.
- Use emojis tastefully (1-3 per message), never spammy.
- Always include exactly ONE clear call-to-action.
- Avoid spam-trigger words (FREE!!!, ACT NOW, GUARANTEED, etc.) and ALL CAPS shouting.
- Never invent stats, prices, or product details — ask the user if you need them.
- Default to English unless the user writes to you in another language (then match it, including Urdu/Roman Urdu / Hinglish).

## Output format
- When the user asks for a broadcast message, output ONLY the message body itself — no preamble like "Here is your message:".
- If they ask for variations, label them clearly: "Option 1:", "Option 2:", "Option 3:" each followed by the message.
- If they ask for an improvement on text they pasted, return the improved version directly.
- Do NOT use Markdown formatting (no **bold**, no headers) — the output will be sent verbatim through Messenger.
- For multi-line messages, use normal line breaks. Emojis are fine.

## What you can do
- Compose messages for: promo announcements, sales/discount, product launches, welcome messages, re-engagement, abandoned cart nudges, event invites, surveys, follow-ups, thank-you notes.
- Rewrite the user's draft to be punchier or more on-brand.
- Translate broadcast copy between languages.
- Suggest A/B variants (always max 3).
- Recommend the best send time and audience segment if asked.

## What you should NOT do
- Don't write anything misleading, fraudulent, or that violates Facebook's Messaging Platform policies.
- Don't offer legal, medical, or financial advice.
- Don't write political or controversial campaign content.
- If asked for something outside your scope, politely redirect to "I'm here to help write Messenger broadcasts — could you tell me more about what you want to send?"

Stay concise. Get the user a ready-to-send message in as few exchanges as possible.`;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;

const _rateBuckets = new Map();
function rateLimit(userId, perMin) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const arr = _rateBuckets.get(userId) || [];
    const recent = arr.filter(t => t > windowStart);
    if (recent.length >= perMin) {
        return false;
    }
    recent.push(now);
    _rateBuckets.set(userId, recent);
    if (_rateBuckets.size > 5000) {
        for (const [k, v] of _rateBuckets) if (!v.some(t => t > windowStart)) _rateBuckets.delete(k);
    }
    return true;
}

function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const m of messages.slice(-MAX_MESSAGES)) {
        if (!m || typeof m !== 'object') continue;
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = String(m.content || '').slice(0, MAX_MESSAGE_CHARS);
        if (!content) continue;
        out.push({ role, content });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

/** openai = Groq, OpenAI, etc. (/chat/completions). anthropic = /v1/messages */
function resolveApiStyle(baseUrl, envStyle) {
    const explicit = String(envStyle || '').trim().toLowerCase();
    if (explicit === 'openai' || explicit === 'anthropic') return explicit;
    const u = baseUrl.toLowerCase();
    if (u.includes('groq.com') || u.includes('openai.com') || u.includes('/openai/')) {
        return 'openai';
    }
    return 'anthropic';
}

function getConfig(env) {
    const baseUrl = (env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
    const apiStyle = resolveApiStyle(baseUrl, env.AI_API_STYLE);
    return {
        baseUrl,
        apiKey: (env.AI_API_KEY || '').trim(),
        model: (env.AI_MODEL || 'llama-3.3-70b-versatile').trim(),
        rateLimit: parseInt(env.AI_RATE_LIMIT_PER_MIN || '20', 10) || 20,
        apiStyle
    };
}

function chatEndpoint(cfg) {
    if (cfg.apiStyle === 'openai') {
        return `${cfg.baseUrl}/chat/completions`;
    }
    return `${cfg.baseUrl}/v1/messages`;
}

function buildUpstreamRequest(cfg, cleanMessages) {
    if (cfg.apiStyle === 'openai') {
        return {
            url: chatEndpoint(cfg),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`,
                'Accept': 'text/event-stream'
            },
            body: {
                model: cfg.model,
                max_tokens: MAX_TOKENS,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...cleanMessages
                ],
                stream: true
            }
        };
    }
    return {
        url: chatEndpoint(cfg),
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
            'accept': 'text/event-stream'
        },
        body: {
            model: cfg.model,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: cleanMessages,
            stream: true
        }
    };
}

function formatUpstreamError(status, bodyText) {
    let parsed = null;
    const raw = String(bodyText || '').trim();
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        const jsonStart = raw.indexOf('{');
        if (jsonStart >= 0) {
            try { parsed = JSON.parse(raw.slice(jsonStart)); } catch (_) {}
        }
    }
    const errObj = parsed?.error || parsed;
    const errType = String(errObj?.type || parsed?.type || '').trim();
    const errMsg = String(errObj?.message || parsed?.message || '').trim();

    if (status === 429 || errType === 'FreeUsageLimitError' || /rate limit|usage limit|too many requests/i.test(errMsg)) {
        const isFree = /free/i.test(errType) || /free/i.test(errMsg);
        if (isFree) {
            return 'Free AI plan limit reached on the provider. Wait a few minutes and try again, or use a paid API key / different model (AI_MODEL in server .env).';
        }
        return 'AI provider rate limit reached. Please wait a few minutes and try again.';
    }
    if (status === 401 || status === 403) {
        return 'AI API key is invalid or not allowed. Check AI_API_KEY in server settings.';
    }
    if (status === 503 || status === 502) {
        return 'AI service is temporarily unavailable. Please try again shortly.';
    }
    if (errMsg) return errMsg.slice(0, 280);
    if (raw && !raw.startsWith('{')) return raw.slice(0, 280);
    return `AI service error (HTTP ${status}). Please try again.`;
}

function parseSseFrame(frame) {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }
    if (!dataLines.length) return null;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') return { event: 'done', data: null };
    try { return { event, data: JSON.parse(dataStr) }; }
    catch (_) { return { event, data: dataStr }; }
}

function handleAnthropicFrame(res, parsed, state) {
    if (parsed.event === 'content_block_delta' && parsed.data?.delta?.text) {
        sendSseEvent(res, 'token', { text: parsed.data.delta.text });
    } else if (parsed.event === 'message_delta' && parsed.data?.delta?.stop_reason) {
        state.stopReason = parsed.data.delta.stop_reason;
    } else if (parsed.event === 'error' && parsed.data) {
        sendSseEvent(res, 'error', { message: parsed.data?.error?.message || 'Stream error' });
    }
}

function handleOpenAiDataLine(res, dataStr, state) {
    if (dataStr === '[DONE]') return;
    let data;
    try { data = JSON.parse(dataStr); } catch (_) { return; }
    const choice = data?.choices?.[0];
    const text = choice?.delta?.content;
    if (text) sendSseEvent(res, 'token', { text });
    if (choice?.finish_reason) state.stopReason = choice.finish_reason;
    if (data?.error?.message) {
        sendSseEvent(res, 'error', { message: data.error.message });
    }
}

function processSseBuffer(buf, cfg, res, state) {
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (cfg.apiStyle === 'openai') {
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                handleOpenAiDataLine(res, line.slice(5).trim(), state);
            }
        } else {
            const parsed = parseSseFrame(frame);
            if (parsed) handleAnthropicFrame(res, parsed, state);
        }
    }
    return buf;
}

async function streamChat({ env, fetch, userId, messages, res }) {
    const cfg = getConfig(env);
    if (!cfg.baseUrl || !cfg.apiKey) {
        sendSseEvent(res, 'error', { message: 'AI assistant is not configured on the server.' });
        return res.end();
    }
    if (!rateLimit(userId || 'anonymous', cfg.rateLimit)) {
        sendSseEvent(res, 'error', {
            code: 'rate_limit_app',
            message: `Too many AI requests from your account (${cfg.rateLimit} per minute). Please wait about a minute and try again.`
        });
        return res.end();
    }

    const cleanMessages = sanitizeMessages(messages);
    if (!cleanMessages.length) {
        sendSseEvent(res, 'error', { message: 'Please send a message.' });
        return res.end();
    }

    const reqSpec = buildUpstreamRequest(cfg, cleanMessages);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let upstream;
    try {
        upstream = await fetch(reqSpec.url, {
            method: 'POST',
            headers: reqSpec.headers,
            body: JSON.stringify(reqSpec.body),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timeout);
        sendSseEvent(res, 'error', { message: 'Could not reach the AI service. ' + (err.message || '') });
        return res.end();
    }

    if (!upstream.ok) {
        clearTimeout(timeout);
        let text = '';
        try { text = await upstream.text(); } catch (_) {}
        const friendly = formatUpstreamError(upstream.status, text);
        const code = upstream.status === 429 ? 'rate_limit_provider' : 'upstream_error';
        sendSseEvent(res, 'error', { code, message: friendly, status: upstream.status });
        return res.end();
    }

    if (!upstream.body || typeof upstream.body.getReader !== 'function') {
        clearTimeout(timeout);
        sendSseEvent(res, 'error', { message: 'AI service did not return a streamable response.' });
        return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const state = { stopReason: 'end_turn' };

    res.on('close', () => {
        try { controller.abort(); } catch (_) {}
        try { reader.cancel(); } catch (_) {}
    });

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = processSseBuffer(buf, cfg, res, state);
        }
        sendSseEvent(res, 'done', { stop_reason: state.stopReason });
    } catch (err) {
        if (err?.name !== 'AbortError') {
            sendSseEvent(res, 'error', { message: 'Stream interrupted: ' + (err.message || err) });
        }
    } finally {
        clearTimeout(timeout);
        try { res.end(); } catch (_) {}
    }
}

function sendSseEvent(res, event, data) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    } catch (_) { /* client disconnected */ }
}

function isEnabled(env) {
    const cfg = getConfig(env);
    return !!(cfg.baseUrl && cfg.apiKey);
}

module.exports = { streamChat, isEnabled, getConfig };
