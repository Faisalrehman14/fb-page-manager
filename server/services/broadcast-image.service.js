const path = require('path');
const { FacebookClient } = require('../messenger/facebook-client');

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
};

function guessMime(filePath, fallback = 'image/jpeg') {
    const ext = path.extname(filePath || '').toLowerCase();
    return MIME_BY_EXT[ext] || fallback;
}

function localUploadPath(imageUrl, siteUrl, uploadsDir) {
    if (!imageUrl || !uploadsDir) return null;
    const base = String(siteUrl || '').replace(/\/$/, '');
    const raw = String(imageUrl).trim();
    let rel = null;
    if (base && raw.startsWith(base + '/uploads/')) {
        rel = raw.slice(base.length + 1);
    } else if (raw.startsWith('/uploads/')) {
        rel = raw.replace(/^\//, '');
    } else {
        try {
            const u = new URL(raw);
            if (u.pathname.startsWith('/uploads/')) rel = u.pathname.replace(/^\//, '');
        } catch (_) { /* not a URL */ }
    }
    if (!rel || !rel.startsWith('uploads/')) return null;
    const filename = path.basename(rel);
    if (!filename || filename.includes('..')) return null;
    return path.join(uploadsDir, filename);
}

async function loadImageBytes(imageUrl, { fs, fetch, uploadsDir, siteUrl }) {
    const url = String(imageUrl || '').trim();
    if (!url) throw new Error('Image URL is empty');

    const localPath = localUploadPath(url, siteUrl, uploadsDir);
    if (localPath && fs.existsSync(localPath)) {
        return {
            buffer: fs.readFileSync(localPath),
            mime: guessMime(localPath),
            filename: path.basename(localPath)
        };
    }

    if (!/^https?:\/\//i.test(url)) {
        throw new Error('Image must be uploaded to the app or use a public https:// URL');
    }

    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Could not download image (${r.status})`);
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim() || 'image/jpeg';
    if (!mime.startsWith('image/')) throw new Error('URL is not an image');
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length) throw new Error('Image file is empty');
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Image too large (max 8 MB)');
    return { buffer, mime, filename: 'broadcast.jpg' };
}

/**
 * Upload once to Meta; reuse attachment_id for every recipient (same as reliable broadcast sends).
 */
async function prepareBroadcastImagePayload({
    pageId,
    pageToken,
    imageUrl,
    fetchFn,
    fs,
    uploadsDir,
    siteUrl
}) {
    const { buffer, mime, filename } = await loadImageBytes(imageUrl, { fs, fetch: fetchFn, uploadsDir, siteUrl });
    const fb = new FacebookClient(fetchFn);
    const attachment_id = await fb.uploadReusableImageAttachment(pageToken, pageId, buffer, mime, filename);
    return { attachment_id };
}

module.exports = {
    guessMime,
    localUploadPath,
    loadImageBytes,
    prepareBroadcastImagePayload
};
