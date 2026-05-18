# FBCast Pro — API Documentation

## Overview

FBCast Pro provides a complete REST API for Facebook messaging and payment processing. All endpoints require HTTPS and proper authentication.

**Base URL:** `https://yourdomain.com`

**API Version:** `1.0`

---

## Authentication

### Session-Based (Web)
User endpoints use PHP session cookies after OAuth login:
```
Cookie: PHPSESSID=abc123...
```

### CSRF Protection
All POST requests require CSRF token:
```
POST /create_checkout.php
X-CSRF-Token: token_value
Content-Type: application/json
```

Get CSRF token:
```bash
curl https://yourdomain.com/get_csrf.php
# Response: {"csrf_token":"abc123..."}
```

---

## Endpoints

### 1. Authentication & User

#### `GET /index.php` (Landing Page & App)
Returns the main app interface

**Response:**
- 200: HTML app interface
- 503: Service unavailable

---

#### `POST /exchange_token.php` (Facebook OAuth Exchange)
Exchange Facebook code for user session

**Request:**
```json
{
  "access_token": "facebook_user_token",
  "fbUserId": "123456789"
}
```

**Response Success (200):**
```json
{
  "success": true,
  "user": {
    "id": 123,
    "fb_user_id": "123456789",
    "fb_name": "John Doe",
    "plan": "free",
    "messages_used": 150,
    "messages_limit": 2000
  }
}
```

**Response Error (400/429/500):**
```json
{
  "error": "Invalid token",
  "code": "INVALID_TOKEN"
}
```

**Rate Limit:** 10 requests/minute per IP

---

### 2. Messaging

#### `POST /fb_proxy.php` (Send Message)
Send a message via Facebook through ISP bypass

**Request:**
```json
{
  "recipient_id": "123456789",
  "message": "Hello, this is a test message",
  "csrf_token": "token_value"
}
```

**Response Success (200):**
```json
{
  "success": true,
  "message_id": "m_abc123",
  "timestamp": "2024-04-24T10:30:00Z",
  "quota_remaining": 1850
}
```

**Response Error (400/403/429):**
```json
{
  "error": "Quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "retry_after": 86400
}
```

**Rate Limit:** 500 requests/minute per IP

**Quota Rules:**
- Free: 2,000 messages/month
- Basic: 200,000 messages/month
- Pro: 500,000 messages/month

---

### 3. Payment & Subscriptions

#### `POST /create_checkout.php` (Create Payment)
Initialize Stripe payment session

**Request:**
```json
{
  "plan": "basic",
  "csrf_token": "token_value"
}
```

**Response Success (200):**
```json
{
  "clientSecret": "pi_1A2B3C_secret_abc123",
  "publishableKey": "pk_live_...",
  "plan": "basic",
  "amount": 2000,
  "currency": "usd"
}
```

**Response Error (400/402/429):**
```json
{
  "error": "Payment method required",
  "code": "PAYMENT_ERROR"
}
```

**Rate Limit:** 3 requests/minute per user

---

#### `POST /activate_subscription.php` (Confirm Subscription)
Confirm successful subscription activation

**Request:**
```json
{
  "payment_intent_id": "pi_1A2B3C",
  "stripe_customer_id": "cus_abc123"
}
```

**Response (200):**
```json
{
  "success": true,
  "subscription_id": "sub_abc123",
  "plan": "basic",
  "next_billing": "2024-05-24T10:30:00Z"
}
```

---

### 4. Webhook Endpoints

#### `POST /stripe_webhook.php` (Stripe Webhook)
Receives events from Stripe

**Authentication:**
Stripe signature verification via STRIPE_WEBHOOK_SECRET

**Handled Events:**
- `checkout.session.completed` - Payment successful
- `customer.subscription.updated` - Subscription modified
- `customer.subscription.deleted` - Subscription cancelled
- `charge.refunded` - Refund processed

**Response:** Always returns 200 (events are queued for retry on failure)

---

### 5. Admin Endpoints

#### `POST /admin.php?action=login` (Admin Login)
Authenticate as admin

**Request:**
```json
{
  "password": "AdminPassword123"
}
```

**Response Success (200):**
```json
{
  "success": true,
  "session": "admin_session_id"
}
```

**Rate Limit:** 5 attempts/15 minutes (IP-based brute-force protection)

---

#### `GET /admin.php?action=stats` (Get Statistics)
Retrieve platform statistics

**Requires:** Admin session

**Response:**
```json
{
  "total_users": 1250,
  "paid_users": 450,
  "messages_sent_today": 125000,
  "revenue_today": 4500,
  "active_subscriptions": 445
}
```

---

### 6. Utilities

#### `GET /health_check.php` (Health Status)
System health and monitoring

**Response (200):**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2024-04-24T10:30:00Z",
  "components": {
    "database": {
      "status": "ok",
      "connected": true
    },
    "filesystem": {
      "status": "ok",
      "writable_logs": true
    },
    "configuration": {
      "status": "ok",
      "https_enabled": true
    },
    "performance": {
      "status": "ok",
      "response_time_ms": 45
    }
  }
}
```

**Response (503):**
```json
{
  "status": "degraded",
  "components": {
    "database": {"status": "error", "message": "Connection failed"}
  }
}
```

---

#### `GET /get_csrf.php` (Get CSRF Token)
Retrieve CSRF token for state-changing requests

**Response:**
```json
{
  "csrf_token": "abc123def456...",
  "token_ttl": 3600
}
```

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `OK` | 200 | Request succeeded |
| `INVALID_REQUEST` | 400 | Malformed request |
| `INVALID_TOKEN` | 401 | Auth token invalid/expired |
| `INSUFFICIENT_PERMISSIONS` | 403 | User lacks permission |
| `CSRF_TOKEN_INVALID` | 403 | CSRF validation failed |
| `NOT_FOUND` | 404 | Resource not found |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method not supported |
| `QUOTA_EXCEEDED` | 429 | Rate limit or quota exceeded |
| `PAYMENT_ERROR` | 402 | Payment processing failed |
| `SERVER_ERROR` | 500 | Internal server error |
| `SERVICE_UNAVAILABLE` | 503 | Service temporarily down |

---

## Rate Limiting

All endpoints have rate limits to prevent abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/exchange_token.php` | 10 req | 1 minute |
| `/get_csrf.php` | 100 req | 1 minute |
| `/fb_proxy.php` | 500 req | 1 minute |
| `/create_checkout.php` | 3 req | 1 minute |
| `/admin.php?action=login` | 5 attempts | 15 minutes |

**Response on limit exceeded:**
```json
{
  "error": "Too many requests",
  "retry_after": 60,
  "limit_type": "api_general"
}
```

Header: `Retry-After: 60`

---

## Webhook Events

### Event: `checkout.session.completed`
Payment successful, user upgraded

```json
{
  "object": "event",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_123",
      "customer": "cus_abc123",
      "subscription": "sub_abc123",
      "metadata": {
        "user_id": "123",
        "plan": "basic"
      }
    }
  }
}
```

### Event: `customer.subscription.updated`
Subscription plan or status changed

```json
{
  "object": "event",
  "type": "customer.subscription.updated",
  "data": {
    "object": {
      "id": "sub_abc123",
      "customer": "cus_abc123",
      "plan": "pro",
      "status": "active",
      "current_period_end": 1682678400
    }
  }
}
```

---

## Best Practices

### 1. Always Use HTTPS
```bash
# ✅ Correct
curl https://yourdomain.com/create_checkout.php

# ❌ Never
curl http://yourdomain.com/create_checkout.php
```

### 2. Include CSRF Token
```javascript
// Get CSRF token first
const response = await fetch('/get_csrf.php');
const { csrf_token } = await response.json();

// Include in POST request
fetch('/create_checkout.php', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrf_token
  },
  body: JSON.stringify({ plan: 'basic' })
});
```

### 3. Handle Rate Limit Backoff
```javascript
async function retryWithBackoff(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep((parseInt(retryAfter) || (2 ** i)) * 1000);
      continue;
    }
    
    return response;
  }
}
```

### 4. Parse Webhook Signatures
```php
// Verify Stripe webhook authenticity
$sig_header = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
$body = file_get_contents('php://input');

try {
    $event = \Stripe\Webhook::constructEvent($body, $sig_header, STRIPE_WEBHOOK_SECRET);
} catch (\Stripe\Exception\SignatureVerificationException $e) {
    http_response_code(403);
    die('Invalid signature');
}
```

---

## API Versioning

Current API version: **1.0**

Breaking changes will increment the major version. Monitor updates:

```bash
# Check API version
curl https://yourdomain.com/health_check.php | jq '.version'
```

---

## Support

- 📧 API Support: support@yourdomain.com
- 📚 Full Documentation: https://docs.yourdomain.com
- 🐛 Report Issues: bugs@yourdomain.com
- 💬 Community: https://community.yourdomain.com
