class AppError extends Error {
    constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, { status: 404, code: 'NOT_FOUND' });
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required') {
        super(message, { status: 401, code: 'UNAUTHORIZED' });
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, { status: 403, code: 'FORBIDDEN' });
    }
}

class ValidationError extends AppError {
    constructor(message = 'Validation failed', details = null) {
        super(message, { status: 422, code: 'VALIDATION_ERROR', details });
    }
}

class ConflictError extends AppError {
    constructor(message = 'Conflict') {
        super(message, { status: 409, code: 'CONFLICT' });
    }
}

module.exports = {
    AppError,
    NotFoundError,
    UnauthorizedError,
    ForbiddenError,
    ValidationError,
    ConflictError
};
