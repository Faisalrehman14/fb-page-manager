/**
 * Standard API response envelope for v1+ routes.
 * Legacy routes keep their existing JSON shape until migrated.
 */

function ok(res, data = null, meta = null, status = 200) {
    const body = { success: true, data, error: null };
    if (meta) body.meta = meta;
    return res.status(status).json(body);
}

function created(res, data = null, meta = null) {
    return ok(res, data, meta, 201);
}

function accepted(res, data = null, meta = null) {
    return ok(res, data, meta, 202);
}

function fail(res, error, status = 400) {
    const payload = typeof error === 'string'
        ? { code: 'BAD_REQUEST', message: error }
        : {
            code: error.code || 'ERROR',
            message: error.message || 'Request failed',
            ...(error.details ? { details: error.details } : {})
        };
    return res.status(status).json({ success: false, data: null, error: payload });
}

function paginate(items, { cursor = null, hasMore = false, total = null } = {}) {
    const meta = { hasMore };
    if (cursor != null) meta.cursor = cursor;
    if (total != null) meta.total = total;
    return { data: items, meta };
}

module.exports = { ok, created, accepted, fail, paginate };
