const { logError } = require('../lib/logger');
const { fail } = require('../lib/apiResponse');
const { AppError } = require('../lib/errors');

function notFoundHandler(req, res) {
    if (req.path.startsWith('/api/v1')) {
        return fail(res, { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` }, 404);
    }
    res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;
    const isApp = err instanceof AppError || err.name === 'AppError';

    if (status >= 500 || !isApp) {
        logError('http_error', err instanceof Error ? err : new Error(String(err)), {
            path: req.path,
            method: req.method
        });
    }

    if (req.path.startsWith('/api/v1')) {
        return fail(res, {
            code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR'),
            message: isApp || status < 500 ? err.message : 'Internal server error',
            details: err.details || undefined
        }, status);
    }

    res.status(status).json({
        error: isApp || status < 500 ? err.message : 'Internal server error',
        code: err.code || undefined
    });
}

module.exports = { notFoundHandler, errorHandler };
