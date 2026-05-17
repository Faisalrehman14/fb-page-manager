# FBCast Pro — Monitoring & Alerting Setup

## Quick Start

Add this health check to your monitoring service:

```
Endpoint: https://yourdomain.com/health_check.php
Check every: 5 minutes
Alert if: HTTP status != 200 for 2 consecutive checks
```

---

## Recommended Monitoring Services

### 1. **UptimeRobot** (Free)
Easiest option, 5-minute intervals

1. Sign up at https://uptimerobot.com
2. Add new monitor:
   - Type: HTTP
   - URL: `https://yourdomain.com/health_check.php`
   - Interval: 5 minutes
   - Timeout: 30 seconds
3. Set alerts: Email + SMS to your phone
4. Enable Slack notifications (optional)

### 2. **Pingdom** ($10-100/month)
Advanced monitoring with detailed reports

1. Sign up at https://www.pingdom.com
2. Add uptime check
3. Enable performance monitoring
4. Set up incident alerts

### 3. **Better Stack** (Free tier)
Modern alternative with great UX

1. Sign up at https://betterstack.com
2. Add HTTP(S) heartbeat monitor
3. Set check frequency: 5 minutes
4. Configure notification channels

### 4. **Datadog** ($15/month)
Enterprise-grade with custom metrics

1. Install Datadog agent on server
2. Monitor logs, performance, errors
3. Custom alerts for business metrics

---

## Server-Side Monitoring

### System Metrics

Monitor these on your server:

```bash
# CPU usage
top -b -n 1 | head -20

# Memory usage
free -h

# Disk space
df -h

# Process count (PHP)
ps aux | grep php | wc -l

# MySQL connections
mysql -u root -p -e "SHOW PROCESSLIST;"

# Open files
lsof -p [php_pid] | wc -l
```

Set alerts if:
- CPU > 80% for > 5 minutes
- Memory > 90%
- Disk > 85%
- PHP processes > 50
- MySQL connections > 100

### Using Monit (Automated)

```bash
# Install monit
sudo apt-get install monit

# Configure /etc/monit/monitrc
sudo nano /etc/monit/monitrc

# Add:
check http fbcast_app
    host yourdomain.com
    port 443
    protocol https
    path "/health_check.php"
    timeout 10 seconds
    if failed then alert
    if restored then alert

# Start monitoring
sudo systemctl start monit
sudo systemctl enable monit
```

---

## Application-Level Monitoring

### 1. Error Rate Monitoring

```bash
# Check error rate from logs
errors_today=$(grep ERROR logs/app.log | wc -l)
requests_today=$(grep -c . logs/app.log)
error_rate=$((errors_today * 100 / requests_today))

# Alert if > 5% errors
if [ $error_rate -gt 5 ]; then
    echo "ALERT: Error rate $error_rate%"
fi
```

### 2. Payment Processing

```bash
# Monitor failed payments
failed_payments=$(grep "Payment.*failed" logs/app.log | tail -24 | wc -l)

# Alert if > 10 in last 24 hours
if [ $failed_payments -gt 10 ]; then
    mail -s "Alert: $failed_payments failed payments" admin@yourdomain.com
fi
```

### 3. Database Performance

```sql
-- Check slow queries
SELECT * FROM mysql.general_log 
WHERE execution_time > 1
ORDER BY event_time DESC LIMIT 10;

-- Check table size
SELECT table_name, ROUND(((data_length + index_length) / 1024 / 1024), 2) 
FROM information_schema.TABLES 
WHERE table_schema = 'fbcast_prod'
ORDER BY (data_length + index_length) DESC;
```

---

## Log Monitoring

### Real-time Monitoring

```bash
# Watch for errors
tail -f logs/app.log | grep ERROR

# Watch for payment issues
tail -f logs/app.log | grep -i payment

# Watch for rate limit violations
tail -f logs/app.log | grep "429"

# Watch authentication failures
tail -f logs/app.log | grep "auth_failed"
```

### Log Analysis Cron Job

```bash
#!/bin/bash
# Create /home/user/scripts/analyze_logs.sh

LOG_FILE="/home/user/public_html/logs/app.log"
REPORT_FILE="/tmp/fbcast_report_$(date +%Y-%m-%d).txt"

# Generate daily report
{
    echo "FBCast Pro — Daily Log Report"
    echo "Date: $(date)"
    echo ""
    
    echo "=== ERROR SUMMARY ==="
    grep ERROR "$LOG_FILE" | wc -l
    echo "recent errors:"
    grep ERROR "$LOG_FILE" | tail -5
    echo ""
    
    echo "=== PAYMENT TRANSACTIONS ==="
    grep "payment_" "$LOG_FILE" | tail -10
    echo ""
    
    echo "=== TOP IPS ==="
    grep -oP 'ip:\K[^,]+' "$LOG_FILE" | sort | uniq -c | sort -rn | head -10
    echo ""
    
    echo "=== RATE LIMIT VIOLATIONS ==="
    grep "429" "$LOG_FILE" | wc -l
    echo ""
    
} > "$REPORT_FILE"

# Email report
mail -s "FBCast Daily Report" admin@yourdomain.com < "$REPORT_FILE"
```

Add to crontab:
```bash
0 6 * * * /home/user/scripts/analyze_logs.sh
```

---

## Custom Alerts

### Email Alerts

```php
<?php
// scripts/send_alert.php
// Usage: php send_alert.php "Critical issue: Payment gateway down"

$message = $argv[1] ?? "No message";
$subject = "FBCast Alert: " . date('H:i');

mail(CONTACT_EMAIL, $subject, $message, [
    'From' => 'alerts@yourdomain.com',
    'X-Priority' => '1'
]);

echo "Alert sent to " . CONTACT_EMAIL;
?>
```

### Slack Alerts

```php
<?php
// Send to Slack webhook
function sendSlackAlert($message, $severity = 'warning') {
    $webhook_url = getenv('SLACK_WEBHOOK_URL');
    if (!$webhook_url) return false;
    
    $color = $severity === 'error' ? '#ff0000' : '#ffaa00';
    
    $payload = json_encode([
        'attachments' => [[
            'color' => $color,
            'title' => 'FBCast Pro Alert',
            'text' => $message,
            'ts' => time()
        ]]
    ]);
    
    $ch = curl_init($webhook_url);
    curl_setopt($ch, CURLOPT_POST, 1);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_exec($ch);
    curl_close($ch);
}
?>
```

Use in your code:
```php
if ($stripe_error) {
    sendSlackAlert("❌ Payment processing failed: $error_message", 'error');
}
```

---

## Dashboard (Optional)

Create `/logs/dashboard.php` for real-time monitoring:

```php
<?php
// Public monitoring dashboard (read-only, no auth)
require_once '../config/load-env.php';
require_once '../db_config.php';

$db = getDB();

// Statistics
$stats = [
    'total_users' => $db->query("SELECT COUNT(*) FROM users")->fetchColumn(),
    'paid_users' => $db->query("SELECT COUNT(*) FROM users WHERE plan != 'free'")->fetchColumn(),
    'messages_sent_today' => $db->query(
        "SELECT SUM(messages_used) FROM users WHERE last_login >= DATE(NOW())"
    )->fetchColumn(),
    'errors_today' => exec("grep -c ERROR ../logs/app.log"),
    'response_time' => 45 // ms
];
?>

<!DOCTYPE html>
<html>
<head>
    <title>FBCast Pro - Monitoring</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #0ff; }
        .stat { display: inline-block; margin: 10px; padding: 20px; border: 1px solid #0ff; }
        .stat-value { font-size: 2em; font-weight: bold; }
        .stat-label { font-size: 0.8em; opacity: 0.7; }
    </style>
</head>
<body>
    <h1>📊 FBCast Pro Monitoring</h1>
    <div class="stats">
        <?php foreach ($stats as $label => $value): ?>
        <div class="stat">
            <div class="stat-value"><?= number_format($value) ?></div>
            <div class="stat-label"><?= ucfirst(str_replace('_', ' ', $label)) ?></div>
        </div>
        <?php endforeach; ?>
    </div>
    <p style="margin-top: 40px; opacity: 0.5;">
        Last updated: <?= date('Y-m-d H:i:s') ?><br>
        Auto-refresh in 60 seconds...
    </p>
    <script>
        setTimeout(() => location.reload(), 60000);
    </script>
</body>
</html>
```

---

## Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 1% | > 5% |
| Response time | > 500ms | > 2s |
| CPU usage | > 70% | > 90% |
| Memory | > 80% | > 95% |
| Disk | > 80% | > 95% |
| Failed payments | > 5/24h | > 20/24h |
| Rate limit hits | > 100/day | > 1000/day |
| DB connection pool | > 50% | > 80% |

---

## On-Call Setup

### Escalation Policy

```
30 mins → Email + Slack
1 hour  → SMS alert
2 hours → Phone call
```

### Team Rotation

Create rotation in your chosen tool:
- Primary on-call (main responder)
- Secondary on-call (backup, escalates after 30 mins)
- Manager (final escalation)

---

## Monthly Reviews

Schedule a monthly monitoring review:

```markdown
## Monthly Monitoring Review Checklist

- [ ] Review uptime report (target: > 99.9%)
- [ ] Analyze error patterns and trends
- [ ] Check database performance metrics
- [ ] Review payment processing success rate
- [ ] Audit failed webhook events
- [ ] Check storage usage growth
- [ ] Review security logs for anomalies
- [ ] Test alert notifications
- [ ] Update alerting thresholds if needed
- [ ] Document any incidents and resolutions
```

---

## Incident Response

### When Alert Triggers

1. **Acknowledge** the alert within 5 minutes
2. **Diagnose** using health check: `curl https://yourdomain.com/health_check.php`
3. **Check logs**: `tail -50 logs/app.log | grep ERROR`
4. **Escalate** if can't resolve within 15 minutes
5. **Communicate** status to users if outage > 30 minutes
6. **Document** what went wrong and how it was fixed

### Common Issues & Fixes

| Issue | Check |
|-------|-------|
| 503 Service Unavailable | Database connectivity, PHP errors |
| High response time | CPU/memory usage, slow queries |
| Payment failures | Stripe API key, webhook endpoint |
| Auth failures | Session cookie, CSRF token, IP blocks |

---

## Support

- 📧 Monitoring help: ops@yourdomain.com
- 🔗 Service status: https://status.yourdomain.com (optional)
- 💬 Incident reports: incidents@yourdomain.com
