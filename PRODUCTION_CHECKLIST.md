# FBCast Pro — Production Deployment Checklist

## 🔒 Security

### Environment & Configuration
- [ ] **Set `APP_ENV=production`** in `.env` file
- [ ] **Remove all debug info** — Ensure `display_errors = 0` in PHP
- [ ] **Enable error logging** — Configure `error_log` path and permissions
- [ ] **Set strong database password** — Use 32+ character random password
- [ ] **Update SITE_URL** in `.env` to your production domain
- [ ] **Enable HTTPS** — SSL certificate must be valid and auto-renewing
- [ ] **Configure .htaccess** — Uncomment HTTPS redirect when SSL is active

### Secrets & Keys
- [ ] **Facebook App ID & Secret** — From facebook.com/developers
- [ ] **Facebook Redirect URI** — Must match your production domain exactly
- [ ] **Stripe API Keys** — Secret key (sk_live_*) and Publishable key (pk_live_*)
- [ ] **Stripe Webhook Secret** — Configure webhook endpoint in Stripe Dashboard
- [ ] **Stripe Price IDs** — Get from Products → (select product) → Pricing section
- [ ] **Admin Password Hash** — Use `password_hash()` to create ADMIN_PASSWORD_HASH
- [ ] **DB credentials** — Secure, unique user with limited permissions

### Database
- [ ] **Run `setup_db.php`** — Creates tables on first deployment
  ```bash
  curl https://yoursite.com/setup_db.php
  ```
- [ ] **Verify tables exist** — Run: `SHOW TABLES;`
- [ ] **Test DB connection** — No errors in `/logs/app.log`
- [ ] **Enable DB backups** — Daily automated backups to secure location
- [ ] **Set DB user permissions** — Only SELECT, INSERT, UPDATE, DELETE (not ALTER)

### File Permissions
- [ ] **Logs directory** — `chmod 755 logs/` (server must write logs)
- [ ] **Config files** — `chmod 644 config/*.php`
- [ ] **Sensitive files** — `.env` should be `chmod 600` (read-only by server)
- [ ] **Public assets** — `chmod 644` for CSS, JS, images

### Security Headers
- [ ] **HSTS enabled** — Strict-Transport-Security header set (in .htaccess)
- [ ] **CSP configured** — Content-Security-Policy header set
- [ ] **X-Frame-Options** — Set to SAMEORIGIN (in .htaccess)
- [ ] **X-Content-Type-Options** — Set to nosniff (in .htaccess)

---

## 📋 Functionality Testing

### Facebook Login
- [ ] User can log in with their Facebook account
- [ ] OAuth callback properly redirects back
- [ ] User record created in database
- [ ] Quota initialized correctly (free plan: 2,000 messages)

### Page & Conversation Loading
- [ ] "Refresh Pages" button loads user's pages
- [ ] Page list displays with avatars and names
- [ ] "Load Conversations" button fetches message threads
- [ ] Recipient count displays accurately

### Messaging & Broadcast
- [ ] Message send to single conversation works
- [ ] Batch send to multiple recipients works
- [ ] Progress bar updates in real-time
- [ ] Message time delay (min 500ms) enforced
- [ ] ISP bypass proxy (fb_proxy.php) working correctly

### Payment & Subscriptions
- [ ] Stripe Elements form renders correctly
- [ ] Payment successful → Plan activated in database
- [ ] Quota increased after upgrade
- [ ] Webhook properly resets quota on renewal
- [ ] Subscription cancellation triggers downgrade to free

### Error Handling
- [ ] Network errors show user-friendly messages
- [ ] Invalid tokens log to file (no console leak)
- [ ] Rate limiting returns proper 429 status
- [ ] Missing config variables don't expose details

---

## 📊 Monitoring & Logging

### Log Files
- [ ] `/logs/app.log` — Check for errors daily
- [ ] `/logs/php_errors.log` — Monitor for PHP warnings
- [ ] `/logs/last_checkout_error.log` — Payment debugging

### Real-time Monitoring
```bash
# Monitor app.log for errors
tail -f logs/app.log | grep ERROR

# Check for rate limit abuse
grep "Too many requests" logs/app.log | wc -l

# Monitor failed logins
grep "Facebook token verification failed" logs/app.log
```

### Performance Checks
- [ ] Page load time < 2 seconds
- [ ] API response time < 500ms
- [ ] CSS/JS files minified and gzipped
- [ ] Images optimized and cached

---

## 🔄 Maintenance Plan

### Weekly
- [ ] Review logs for errors and warnings
- [ ] Check database backups completed
- [ ] Verify HTTPS certificate valid (not expiring soon)

### Monthly
- [ ] Update PHP dependencies (curl, OpenSSL)
- [ ] Review user activity for abuse patterns
- [ ] Test payment flow end-to-end
- [ ] Verify Stripe webhook is firing

### Every 3 Months
- [ ] Security audit of .htaccess rules
- [ ] Review CSP policy for needed updates
- [ ] Check for outdated libraries
- [ ] Review and rotate credentials if needed

### Quarterly
- [ ] Update to latest PHP version (if available)
- [ ] Test disaster recovery (restore from backup)
- [ ] Load testing with simulated traffic
- [ ] Security pen-testing (optional but recommended)

---

## 🚨 Common Issues & Solutions

### Issue: "Facebook token verification failed"
**Solution:** Check FB_APP_SECRET is correct. Verify token hasn't expired.

### Issue: Stripe payment hangs
**Solution:** Check STRIPE_SECRET_KEY is sk_live_* not sk_test_*. Verify STRIPE_WEBHOOK_SECRET configured.

### Issue: "Too many requests" errors
**Solution:** Client is sending requests too fast. Check rate limiting is working. May need to increase limits if legitimate traffic is high.

### Issue: Logs directory not writable
**Solution:** Check permissions: `chmod 755 logs/` and `chmod 644 logs/*.log`

### Issue: Database connection fails
**Solution:** Verify DB_HOST, DB_NAME, DB_USER, DB_PASS in .env. Test MySQL connection separately.

---

## 📱 Performance Optimization

### Already Enabled
- ✅ Gzip compression (.htaccess)
- ✅ Browser caching for assets (31536000s = 1 year)
- ✅ API responses no-cache (auth-sensitive)
- ✅ CSS/JS minification (inline in index.php)

### Optional Enhancements
- [ ] CDN for static assets (Cloudflare, etc.)
- [ ] MySQL query optimization (add indexes)
- [ ] Redis for session storage (if high traffic)
- [ ] Opcache for PHP (precompiled bytecode)

---

## 📋 Pre-Launch Checklist

- [ ] All .env variables set and tested
- [ ] HTTPS working with valid certificate
- [ ] Database migrated and verified
- [ ] CRON jobs set up (if needed)
- [ ] Email notifications configured (optional)
- [ ] Backup system tested (can restore?)
- [ ] Monitoring & alerting configured
- [ ] Support email configured for inquiries
- [ ] Terms & Privacy Policy pages updated
- [ ] Admin password changed from default

---

## 🎯 Launch Day

1. **Final Checks** (morning before launch)
   ```bash
   curl https://yoursite.com/check_setup.php
   ```

2. **Monitor First 24 Hours**
   - Check errors in logs continuously
   - Test all user flows manually
   - Monitor payment processing
   - Check for unexpected traffic spikes

3. **Post-Launch**
   - Send announcement to users
   - Set up monitoring alerts
   - Schedule daily log reviews for first week

---

## ❓ Getting Help

- **Stripe Issues** — https://stripe.com/docs
- **Facebook Issues** — https://developers.facebook.com
- **Server Issues** — Check with hosting provider (Hostinger)
- **PHP/MySQL Issues** — Check logs first, then search error message

---

**Last Updated:** 2025-04-15
**Version:** FBCast Pro 1.0
