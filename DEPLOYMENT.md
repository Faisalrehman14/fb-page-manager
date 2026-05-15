# 🚀 FBCast Pro — Production Deployment Guide

## Pre-Deployment Checklist

### 1. Domain & SSL Certificate

```bash
# Your domain must have a valid SSL certificate
# Recommended: Let's Encrypt (free, auto-renewable)

# Verify SSL is working:
curl -vI https://yourdomain.com

# Check certificate expiry:
openssl s_client -connect yourdomain.com:443 -showcerts | grep "notAfter"
```

**Requirements:**
- ✅ HTTPS enabled with valid SSL certificate
- ✅ Auto-renewal configured (Let's Encrypt with certbot)
- ✅ Certificate valid for at least 6 months

### 2. Server & PHP Setup

```bash
# Minimum server requirements
- PHP 8.0+ (8.1 or 8.2 recommended)
- MySQL 5.7+ or MariaDB 10.3+
- Apache 2.4+ with mod_rewrite (or Nginx with rewrite rules)
- 2GB RAM minimum (4GB recommended for production)
- 20GB storage minimum

# Check PHP version:
php --version

# Check PHP extensions:
php -m | grep -E "pdo|curl|json|mbstring"

# All of these should be present
```

### 3. Environment File Setup

```bash
# Copy template to production values
cp .env.example .env

# Edit with your production secrets
nano .env
```

**Critical .env variables:**

```env
APP_ENV=production
SITE_URL=https://yourdomain.com
CONTACT_EMAIL=support@yourdomain.com

# Database (Create a new user with limited permissions)
DB_HOST=localhost
DB_NAME=fbcast_prod
DB_USER=fbcast_prod
DB_PASS=<generate-32-char-random-password>

# Facebook App (from facebook.com/developers)
FB_APP_ID=<your-app-id>
FB_APP_SECRET=<your-app-secret>
FB_REDIRECT_URI=https://yourdomain.com/oauth_callback.html

# Stripe Live Keys (from dashboard.stripe.com)
STRIPE_PUBLISHABLE_KEY=pk_live_<your-key>
STRIPE_SECRET_KEY=sk_live_<your-key>
STRIPE_WEBHOOK_SECRET=whsec_<your-secret>
STRIPE_BASIC_PRICE_ID=price_<id>
STRIPE_PRO_PRICE_ID=price_<id>
```

**Security rules:**
- ✅ Never commit `.env` to git (add to `.gitignore`)
- ✅ Set file permissions: `chmod 600 .env`
- ✅ Only the web server user should read .env
- ✅ Store .env one directory above public_html (if possible)

### 4. Database Setup

```bash
# Create database and limited-permission user
mysql -u root -p << 'EOF'

CREATE DATABASE fbcast_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'fbcast_prod'@'localhost' IDENTIFIED BY 'your-secure-password';

GRANT SELECT, INSERT, UPDATE, DELETE ON fbcast_prod.* TO 'fbcast_prod'@'localhost';

FLUSH PRIVILEGES;

EOF

# Run initial setup (creates all tables)
curl -s https://yourdomain.com/setup_db.php

# Verify tables created
mysql -u fbcast_prod -p fbcast_prod -e "SHOW TABLES;"

# Change default admin password immediately
# Login to /admin.php with: Admin@FBCast2025
# Then change password in Settings
```

### 5. Directory Permissions

```bash
# Set correct permissions
chmod 755 /path/to/app
chmod 755 /path/to/app/logs
chmod 644 /path/to/app/.env
chmod 755 /path/to/app/config
chmod 644 /path/to/app/config/*.php
chmod 755 /path/to/app/assets

# Verify web server can write logs
ls -la logs/
# Should show: drwxr-xr-x (755)

# Test log write
php -r "error_log('Test'); echo 'OK';"
```

### 6. Apache Configuration

```apache
# In your VirtualHost or .htaccess:

# Enable mod_rewrite
<IfModule mod_rewrite.c>
    RewriteEngine On
    
    # Redirect HTTP to HTTPS
    RewriteCond %{HTTPS} off
    RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
    
    # Deny access to sensitive files
    RewriteRule "^\.env$" - [F]
    RewriteRule "^logs/" - [F]
    RewriteRule "^config/" - [F]
    RewriteRule "^\.git/" - [F]
    RewriteRule "^setup_db\.php$" - [F]
</IfModule>

# Enable gzip compression
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css text/javascript application/javascript
</IfModule>

# Browser caching
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresByType text/css "access plus 1 year"
    ExpiresByType application/javascript "access plus 1 year"
    ExpiresByType image/png "access plus 1 year"
    ExpiresByType image/jpeg "access plus 1 year"
</IfModule>
```

---

## Deployment Steps

### Step 1: Upload Files

```bash
# Option A: Git deployment
git clone https://github.com/yourusername/fbcast.git /home/user/public_html
cd /home/user/public_html
git checkout production

# Option B: FTP/SCP
scp -r ./* user@server:/home/user/public_html/

# Verify files uploaded
ls -la /home/user/public_html
```

### Step 2: Verify PHP Configuration

```bash
# Check for syntax errors
php -l index.php
php -l config/load-env.php
php -l db_config.php

# Check loaded extensions
php -i | grep -E "pdo|curl|json|mbstring"

# Test database connection (create test script)
php -r "
require_once 'config/load-env.php';
require_once 'db_config.php';
try {
    \$db = getDB();
    echo 'Database connection: OK';
} catch (Exception \$e) {
    echo 'Error: ' . \$e->getMessage();
}
"
```

### Step 3: Run Database Setup

```bash
# Via web (one-time only):
curl https://yourdomain.com/setup_db.php

# Or via command line:
php setup_db.php

# Output should show: ✅ Database Setup Complete!
```

### Step 4: Configure Stripe Webhook

```bash
# In Stripe Dashboard:
# 1. Go to Developers → Webhooks
# 2. Add Endpoint: https://yourdomain.com/stripe_webhook.php
# 3. Select events:
#    - checkout.session.completed
#    - customer.subscription.updated
#    - customer.subscription.deleted
# 4. Copy webhook signing secret to .env (STRIPE_WEBHOOK_SECRET)
```

### Step 5: Configure Facebook OAuth

```bash
# In Facebook Developers Dashboard:
# 1. Go to Your App → Settings → Basic
# 2. Note down App ID and App Secret → add to .env
# 3. Go to Settings → Basic → App Domains
#    Add: yourdomain.com
# 4. Go to Products → Facebook Login → Settings
#    Valid OAuth Redirect URIs: https://yourdomain.com/oauth_callback.html
```

### Step 6: Security Hardening

```bash
# Delete setup script after initialization
rm setup_db.php

# Delete admin.php in production (optional, for max security)
# Or move to admin/ subdirectory and protect with .htaccess

# Hide version files
rm -f CHANGELOG.md CONTRIBUTING.md

# Set restrictive file permissions
find . -type f -name "*.php" -exec chmod 644 {} \;
find . -type d -exec chmod 755 {} \;
chmod 600 .env

# Test .htaccess blocking
curl -I https://yourdomain.com/.env
# Should return: 403 Forbidden
```

### Step 7: Verify Installation

```bash
# Health check
curl https://yourdomain.com/health_check.php | jq .

# Should return status: "ok" with 200 OK

# Test landing page
curl https://yourdomain.com

# Should return HTML with no errors
```

---

## Post-Deployment

### 1. Set Up Monitoring

```bash
# Add to your monitoring service (UptimeRobot, Pingdom, etc.)
Monitor: https://yourdomain.com/health_check.php
Interval: 5 minutes
Alert if: Response != 200 for 2 consecutive checks

# Monitor logs
tail -f logs/app.log | grep ERROR
```

### 2. Configure Cron Jobs

```bash
# Edit crontab
crontab -e

# Add webhook retry processing (every 5 minutes)
*/5 * * * * cd /home/user/public_html && php stripe_webhook_retry.php

# Add daily database backup (2 AM)
0 2 * * * cd /home/user/public_html && php scripts/backup_database.php
```

### 3. Set Up Log Rotation

```bash
# Create logrotate config
cat > /etc/logrotate.d/fbcast << 'EOF'
/home/user/public_html/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    postrotate
        systemctl reload php-fpm
    endscript
}
EOF

# Test logrotate
logrotate -f /etc/logrotate.d/fbcast
```

### 4. Set Up Database Backups

```bash
# Create backup script
cat > scripts/backup_database.php << 'EOF'
<?php
require_once 'config/load-env.php';
$backup_file = '/backups/fbcast_' . date('Y-m-d_H-i-s') . '.sql';
system("mysqldump -h " . DB_HOST . " -u " . DB_USER . " -p" . DB_PASS . " " . DB_NAME . " > " . $backup_file);
echo "Backup: $backup_file";
EOF

# Ensure backups directory exists
mkdir -p /backups/fbcast
chmod 700 /backups/fbcast
```

### 5. Configure Alert Emails

Add to your .env:
```env
SEND_ALERTS=true
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=587
SMTP_USER=alerts@yourdomain.com
SMTP_PASS=your-app-password
SMTP_FROM=FBCast Pro <alerts@yourdomain.com>
```

---

## Troubleshooting

### Database Connection Failed

```bash
# Verify credentials in .env
echo $DB_HOST $DB_NAME $DB_USER

# Test connection manually
mysql -h localhost -u fbcast_prod -p fbcast_prod -e "SELECT 1;"

# Check MySQL is running
systemctl status mysql
# or
systemctl status mariadb
```

### Permission Denied on logs/

```bash
# Check ownership
ls -la logs/

# Fix permissions
chown www-data:www-data logs/
chmod 755 logs/
```

### SSL Certificate Issues

```bash
# Check certificate validity
openssl s_client -connect yourdomain.com:443 < /dev/null | grep -E "Verify|notAfter"

# Renew with Let's Encrypt
certbot renew --force-renewal
```

### Payment Processing Not Working

```bash
# Verify Stripe keys in .env
grep STRIPE_ .env

# Test webhook delivery
curl -X POST https://yourdomain.com/stripe_webhook.php \
  -H "Content-Type: application/json" \
  -d '{"type":"test"}'

# Check logs
tail -50 logs/app.log | grep -i stripe
```

---

## Performance Optimization

### Enable Query Caching (MySQL)

```sql
-- Add to my.cnf
[mysqld]
query_cache_type = 1
query_cache_size = 64M

-- Restart MySQL
systemctl restart mysql
```

### PHP Performance

```php
// In config/load-env.php, add:
ini_set('memory_limit', '256M');
ini_set('max_execution_time', '30');
ini_set('upload_max_filesize', '100M');
ini_set('post_max_size', '100M');
```

### Database Optimization

```sql
-- Run monthly
OPTIMIZE TABLE users;
OPTIMIZE TABLE webhook_events;
OPTIMIZE TABLE activity_log;

-- Remove old logs
DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

---

## Monitoring Dashboard

Create `logs/monitoring.php` to view real-time stats:

```bash
curl https://yourdomain.com/logs/monitoring.php
```

Returns:
- Active users
- Messages sent today
- Payment transactions
- Error rate
- Response time

---

## Support & Updates

- 📧 Email: support@yourdomain.com
- 🐛 Report bugs: admin@yourdomain.com
- 📚 Documentation: https://docs.yourdomain.com
- 🔄 Updates: Check GitHub releases monthly

**Always test updates in staging before production deployment!**
