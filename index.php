<?php
// Redirect Railway URL to canonical custom domain
$_host = strtolower($_SERVER['HTTP_HOST'] ?? '');
if ($_host === 'facebook-inbox-production-2a22.up.railway.app') {
    $requestUri = $_SERVER['REQUEST_URI'] ?? '/';
    header('Location: https://castmepro.com' . $requestUri, true, 301);
    exit;
}

// ═════════════════════════════════════════════════════════════
// PRODUCTION SECURITY: Set security headers before any output
// ═════════════════════════════════════════════════════════════
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('X-XSS-Protection: 1; mode=block');
header('X-Permitted-Cross-Domain-Policies: none');
header('Cross-Origin-Opener-Policy: same-origin-allow-popups');
header('Cross-Origin-Resource-Policy: same-site');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(self)');
header('Strict-Transport-Security: max-age=31536000; includeSubDomains; preload');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com https://connect.facebook.net https://cdn.socket.io; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; img-src 'self' data: https:; connect-src 'self' https://api.stripe.com https://graph.facebook.com https://www.facebook.com https://connect.facebook.net wss: ws: https://*.railway.app; frame-src https://js.stripe.com https://www.facebook.com https://staticxx.facebook.com; object-src 'none'; base-uri 'self'");

// Disable caching for page (user auth-sensitive)
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private');
header('Pragma: no-cache');
header('Expires: Thu, 01 Jan 1970 00:00:00 GMT');

define('FBCAST_PAGE_CONTEXT', true);

$js_stripe_pk     = '';
$js_fb_app_id     = '';
$js_contact_email = '';
$js_site_url      = '';
$js_fb_redirect   = '';
$csrf_token       = '';
$app_env          = 'development';
$canonical_url    = '';

$config_file = __DIR__ . '/config/load-env.php';
if (file_exists($config_file)) {
    try {
        require_once $config_file;
        $js_stripe_pk     = htmlspecialchars(defined('STRIPE_PUBLISHABLE_KEY') ? STRIPE_PUBLISHABLE_KEY : '', ENT_QUOTES, 'UTF-8');
        $js_fb_app_id     = htmlspecialchars(defined('FB_APP_ID')              ? FB_APP_ID              : '', ENT_QUOTES, 'UTF-8');
        $js_contact_email = htmlspecialchars(defined('CONTACT_EMAIL')          ? CONTACT_EMAIL          : '', ENT_QUOTES, 'UTF-8');
        $js_site_url      = htmlspecialchars(defined('SITE_URL')               ? SITE_URL               : '', ENT_QUOTES, 'UTF-8');
        $js_fb_redirect   = htmlspecialchars(defined('FB_REDIRECT_URI')        ? FB_REDIRECT_URI        : '', ENT_QUOTES, 'UTF-8');
        $csrf_token       = getCsrfToken();
        $app_env          = defined('APP_ENV') ? APP_ENV : 'development';

        $requestScheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $requestHost   = $_SERVER['HTTP_HOST'] ?? '';
        $requestUri    = $_SERVER['REQUEST_URI'] ?? '/';
        $fallbackUrl   = $requestHost ? ($requestScheme . '://' . $requestHost . $requestUri) : '';
        $canonical_url = htmlspecialchars((defined('SITE_URL') && SITE_URL ? SITE_URL : $fallbackUrl), ENT_QUOTES, 'UTF-8');
    } catch (Throwable $e) {
        error_log('FBCast index.php config error: ' . $e->getMessage());
        if (defined('APP_ENV') && APP_ENV === 'production') {
            http_response_code(503);
            die('<h1>Service Temporarily Unavailable</h1><p>Please try again later.</p>');
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FBCast Pro — Facebook Broadcast Platform</title>
<meta name="description" content="Broadcast messages to all your Facebook Page followers instantly. Real-time tracking, ISP bypass, built for businesses worldwide.">
<meta name="robots" content="index, follow">
<meta property="og:title" content="FBCast Pro — Facebook Broadcast Platform">
<meta property="og:description" content="Send personalized messages to thousands of Facebook followers in minutes.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FBCast Pro">
<meta property="og:url" content="<?php echo $canonical_url; ?>">
<meta property="og:image" content="<?php echo rtrim($canonical_url, '/'); ?>/images/cp.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="theme-color" content="#1877f2">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="FBCast Pro — Facebook Broadcast Platform">
<meta name="twitter:description" content="Broadcast messages to all your Facebook Page followers instantly.">
<meta name="twitter:image" content="<?php echo rtrim($canonical_url, '/'); ?>/images/cp.png">
<link rel="canonical" href="<?php echo $canonical_url; ?>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link rel="preload" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-solid-900.woff2" as="font" type="font/woff2" crossorigin="anonymous">
<link rel="preload" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-brands-400.woff2" as="font" type="font/woff2" crossorigin="anonymous">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/images/castpro2.png">
<link rel="apple-touch-icon" href="/images/castpro2.png">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<link rel="stylesheet" href="assets/css/index.css?v=<?php echo filemtime(__DIR__.'/assets/css/index.css'); ?>">
<link rel="stylesheet" href="assets/css/ui-components.css?v=<?php echo filemtime(__DIR__.'/assets/css/ui-components.css'); ?>">
<link rel="stylesheet" href="assets/css/messenger.css?v=<?php echo filemtime(__DIR__.'/assets/css/messenger.css'); ?>">
</head>
<body>
<a class="skip-link" href="#appPage">Skip To Dashboard</a>
<script>
window.APP_CONFIG={
  stripePublishableKey:'<?php echo $js_stripe_pk;?>',
  fbAppId:'<?php echo $js_fb_app_id;?>',
  fbRedirectUri:'<?php echo $js_fb_redirect;?>',
  contactEmail:'<?php echo $js_contact_email;?>',
  siteUrl:'<?php echo $js_site_url;?>',
  csrfToken:'<?php echo $csrf_token;?>',
  appEnv:'<?php echo $app_env;?>'
};
window.FB_CONFIG={appId:window.APP_CONFIG.fbAppId,csrfToken:window.APP_CONFIG.csrfToken};
</script>

<!-- ═══ LANDING PAGE ═══ -->
<div id="landingPage">

  <!-- NAV -->
  <nav class="nav">
    <a class="nav-brand" href="#">
      <div class="nav-brand-mark"><img src="images/castpro2.png" alt="FBCast Pro" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;"></div>
      <span class="nav-brand-name">FBCast <em>Pro</em></span>
    </a>
    <div class="nav-links">
      <a href="#features">Features</a>
      <a href="#how-it-works">How It Works</a>
      <a href="#pricing">Pricing</a>
    </div>
    <button type="button" class="nav-cta" id="navConnectBtn" onclick="triggerConnect()">
      <i class="fab fa-facebook"></i> Get Started Free
    </button>
    <button class="nav-hamburger" id="navHamburger" aria-label="Open menu">
      <i class="fa-solid fa-bars"></i>
    </button>
  </nav>

  <!-- MOBILE MENU OVERLAY -->
  <div class="mobile-menu" id="mobileMenu" role="dialog" aria-modal="true">
    <button class="mobile-menu-close" id="mobileMenuClose" aria-label="Close menu">
      <i class="fa-solid fa-xmark"></i>
    </button>
    <a class="mobile-menu-link" href="#features" onclick="closeMobileMenu()">Features</a>
    <a class="mobile-menu-link" href="#how-it-works" onclick="closeMobileMenu()">How It Works</a>
    <a class="mobile-menu-link" href="#pricing" onclick="closeMobileMenu()">Pricing</a>
    <button class="mobile-menu-cta" onclick="closeMobileMenu();triggerConnect()">
      <i class="fab fa-facebook"></i> Get Started Free
    </button>
  </div>
  <!-- HERO -->
  <section class="hero">
    <div class="hero-noise"></div>
    <div class="hero-grid"></div>
    <div class="hero-glow"></div>
    <div class="hero-glow-2"></div>
    <!-- Aurora orbs for cinematic depth -->
    <div class="hero-aurora">
      <div class="aurora-orb aurora-orb-1"></div>
      <div class="aurora-orb aurora-orb-2"></div>
      <div class="aurora-orb aurora-orb-3"></div>
    </div>

    <!-- Live activity ticker -->
    <div class="activity-ticker">
      <span class="ticker-pulse"></span>
      <span class="ticker-text" id="activityTickerText">12 businesses sent broadcasts in the last hour</span>
    </div>

    <div class="hero-badge">
      <i class="fab fa-facebook-messenger" style="font-size:12px;color:#4F9FFF;"></i>
      2,000 Free Messages — No Credit Card
    </div>

    <h1 class="hero-h1">
      Reach Every Follower<br>on <span class="grad">Facebook</span> Instantly
    </h1>
    <p class="hero-sub">
      Broadcast personalized messages to all users who've messaged your Facebook Pages.
      Fast, reliable, built for businesses worldwide.
    </p>

    <div class="hero-actions">
      <button class="btn-hero" id="heroConnectBtn" onclick="triggerConnect()">
        <i class="fab fa-facebook"></i>
        Connect with Facebook — It's Free
      </button>
      <div class="hero-social-proof">
        <div class="avatars">
          <img class="avatar hero-avatar avatar-1" data-hero-avatar="0" src="pics/p1.jpg" alt="Customer profile" loading="lazy" decoding="async">
          <img class="avatar hero-avatar avatar-2" data-hero-avatar="1" src="pics/p2.webp" alt="Customer profile" loading="lazy" decoding="async">
          <img class="avatar hero-avatar avatar-3" data-hero-avatar="2" src="pics/p3.jpeg" alt="Customer profile" loading="lazy" decoding="async">
          <img class="avatar hero-avatar avatar-4" data-hero-avatar="3" src="pics/p4.webp" alt="Customer profile" loading="lazy" decoding="async">
        </div>
        Trusted by 500+ businesses worldwide
      </div>
    </div>

    <div class="hero-metrics">
      <div class="metric">
        <div class="metric-val"><span class="counter-num" data-target="2000" data-suffix="">2,000</span></div>
        <div class="metric-lbl">Free Messages</div>
      </div>
      <div class="metric">
        <div class="metric-val">&lt;60s</div>
        <div class="metric-lbl">Setup Time</div>
      </div>
      <div class="metric">
        <div class="metric-val">98%</div>
        <div class="metric-lbl">Delivery Rate</div>
      </div>
      <div class="metric">
        <div class="metric-val" style="font-size:16px;padding-top:2px;"><i class="fas fa-lock" style="color:var(--blue);"></i> SSL</div>
        <div class="metric-lbl">Stripe Secured</div>
      </div>
    </div>

    <!-- Hero product preview -->
    <div class="hero-preview">
      <img src="images/nono.png" alt="FBCast Pro Dashboard" class="hero-preview-img">
    </div>
  </section>

  <!-- BRAND MARQUEE -->
  <div class="marquee-strip">
    <div class="marquee-track">
      <div class="marquee-item"><i class="fas fa-store"></i> Khan Electronics · Lahore</div>
      <div class="marquee-item"><i class="fas fa-tshirt"></i> Sara Boutique · Karachi</div>
      <div class="marquee-item"><i class="fas fa-laptop"></i> TechZone · Dubai</div>
      <div class="marquee-item"><i class="fas fa-building"></i> Digital Agency · Riyadh</div>
      <div class="marquee-item"><i class="fas fa-car"></i> Auto Deals · Karachi</div>
      <div class="marquee-item"><i class="fas fa-utensils"></i> FoodChain · Islamabad</div>
      <div class="marquee-item"><i class="fas fa-graduation-cap"></i> EduPro Academy · UAE</div>
      <div class="marquee-item"><i class="fas fa-heart-pulse"></i> HealthCare Plus · Lahore</div>
      <div class="marquee-item"><i class="fas fa-gem"></i> Jewel House · Karachi</div>
      <div class="marquee-item"><i class="fas fa-mobile-screen"></i> PhoneZone · Islamabad</div>
      <!-- duplicate for seamless loop -->
      <div class="marquee-item"><i class="fas fa-store"></i> Khan Electronics · Lahore</div>
      <div class="marquee-item"><i class="fas fa-tshirt"></i> Sara Boutique · Karachi</div>
      <div class="marquee-item"><i class="fas fa-laptop"></i> TechZone · Dubai</div>
      <div class="marquee-item"><i class="fas fa-building"></i> Digital Agency · Riyadh</div>
      <div class="marquee-item"><i class="fas fa-car"></i> Auto Deals · Karachi</div>
      <div class="marquee-item"><i class="fas fa-utensils"></i> FoodChain · Islamabad</div>
      <div class="marquee-item"><i class="fas fa-graduation-cap"></i> EduPro Academy · UAE</div>
      <div class="marquee-item"><i class="fas fa-heart-pulse"></i> HealthCare Plus · Lahore</div>
      <div class="marquee-item"><i class="fas fa-gem"></i> Jewel House · Karachi</div>
      <div class="marquee-item"><i class="fas fa-mobile-screen"></i> PhoneZone · Islamabad</div>
    </div>
  </div>

  <!-- STATS SOCIAL PROOF -->
  <div class="stats-proof-section">
    <div class="stats-proof-inner">
      <div class="stats-proof-grid">
        <div class="stats-proof-item">
          <div class="proof-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/></svg>
          </div>
          <span class="proof-num counter-num" data-target="500" data-suffix="+">500+</span>
          <div class="proof-label">Businesses Worldwide</div>
          <div class="proof-sub">across 30+ countries</div>
        </div>
        <div class="stats-proof-item">
          <div class="proof-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </div>
          <span class="proof-num counter-num" data-target="50" data-suffix="M+">50M+</span>
          <div class="proof-label">Messages Delivered</div>
          <div class="proof-sub">and counting</div>
        </div>
        <div class="stats-proof-item">
          <div class="proof-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          </div>
          <span class="proof-num counter-num" data-target="98" data-suffix="%">98%</span>
          <div class="proof-label">Average Delivery Rate</div>
          <div class="proof-sub">even behind ISP blocks</div>
        </div>
        <div class="stats-proof-item">
          <div class="proof-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
          </div>
          <span class="proof-num counter-num" data-target="60" data-suffix="s">&lt;60s</span>
          <div class="proof-label">Average Setup Time</div>
          <div class="proof-sub">from login to first broadcast</div>
        </div>
      </div>
    </div>
  </div>

  <!-- BIG FEATURE SECTION -->
  <section class="bigfeat-section">
    <div class="bigfeat-inner">
      <div class="bigfeat-text">
        <span class="section-label"><i class="fab fa-facebook-messenger" style="font-size:11px"></i> The FBCast Advantage</span>
        <h2 class="bigfeat-h2">98% open rate.<br><em>Zero spam folders.</em></h2>
        <p class="bigfeat-sub">Your customers check Facebook Messenger every day. FBCast Pro delivers your message directly there — not buried in email, not killed by algorithms.</p>
        <div class="bigfeat-list">
          <div class="bigfeat-item">
            <div class="bigfeat-check"><i class="fas fa-check"></i></div>
            <div>
              <strong>Direct inbox delivery</strong>
              <p>Messages go straight to Messenger — customers see them the moment they open Facebook.</p>
            </div>
          </div>
          <div class="bigfeat-item">
            <div class="bigfeat-check"><i class="fas fa-check"></i></div>
            <div>
              <strong>ISP block bypass built-in</strong>
              <p>Our server-side proxy routes through AWS — delivers reliably even when local ISPs restrict the Facebook API.</p>
            </div>
          </div>
          <div class="bigfeat-item">
            <div class="bigfeat-check"><i class="fas fa-check"></i></div>
            <div>
              <strong>Real-time delivery tracking</strong>
              <p>Watch every message send live — sent, failed, and pending counts update as they happen.</p>
            </div>
          </div>
        </div>
        <button class="btn-bigfeat" onclick="triggerConnect()">
          <i class="fab fa-facebook"></i> Start Broadcasting — It's Free
        </button>
      </div>
      <div class="bigfeat-visual">
        <div class="bfsc bfsc--blue">
          <div class="bfsc-icon"><i class="fas fa-envelope-open-text"></i></div>
          <div class="bfsc-val">98%</div>
          <div class="bfsc-label">Open Rate</div>
          <div class="bfsc-cmp">vs ~20% for email</div>
        </div>
        <div class="bfsc bfsc--green">
          <div class="bfsc-icon"><i class="fas fa-paper-plane"></i></div>
          <div class="bfsc-val">50M+</div>
          <div class="bfsc-label">Messages Delivered</div>
          <div class="bfsc-cmp">and counting</div>
        </div>
        <div class="bfsc bfsc-wide">
          <div class="bfsc-top-row">
            <span class="bfsc-label">Live Broadcast</span>
            <span class="bfsc-live-pill"><span class="bfsc-live-dot"></span>LIVE</span>
          </div>
          <div class="bfsc-progress-wrap">
            <div class="bfsc-progress-bar" style="width:94%"></div>
          </div>
          <div class="bfsc-progress-nums">
            <span class="bfsc-sent">3,847 sent</span>
            <span class="bfsc-pct">94% delivery</span>
          </div>
        </div>
        <div class="bfsc bfsc--purple">
          <div class="bfsc-icon"><i class="fas fa-users"></i></div>
          <div class="bfsc-val">500+</div>
          <div class="bfsc-label">Businesses</div>
          <div class="bfsc-cmp">across 30+ countries</div>
        </div>
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <div class="features-wrap" id="features">
    <div class="section">
      <span class="section-label">Features</span>
      <h2 class="section-h2">Everything you need to broadcast at scale</h2>
      <p class="section-sub">A complete toolkit to reach your entire Facebook audience in minutes.</p>
      <div class="features-grid">
        <div class="feat">
          <div class="feat-icon" style="background:rgba(8,102,255,.12);border-color:rgba(8,102,255,.25);color:#4F9FFF"><i class="fas fa-bolt"></i></div>
          <h3>Bulk Messaging at Scale</h3>
          <p>Reach hundreds of thousands of page followers in minutes — intelligent rate control stays within Facebook API limits automatically.</p>
        </div>
        <div class="feat">
          <div class="feat-icon" style="background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.2);color:var(--green-light)"><i class="fas fa-shield-halved"></i></div>
          <h3>ISP Block Bypass</h3>
          <p>Server-side AWS proxy routes all API calls so delivery works even when local ISPs restrict the Facebook Graph API — 98% delivery guaranteed.</p>
        </div>
        <div class="feat">
          <div class="feat-icon" style="background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.2);color:#FCD34D"><i class="fas fa-chart-line"></i></div>
          <h3>Live Delivery Tracking</h3>
          <p>Watch every message send in real-time — per-recipient status, error counts, delivery rate, and ETA all visible as the broadcast runs.</p>
        </div>
        <div class="feat">
          <div class="feat-icon" style="background:rgba(179,127,235,.12);border-color:rgba(179,127,235,.25);color:var(--cyan-light)"><i class="fas fa-tags"></i></div>
          <h3>Label Audience Targeting</h3>
          <p>Segment your audience using Facebook labels — target VIPs, leads, or custom groups. Send the right message to the right people.</p>
        </div>
        <div class="feat">
          <div class="feat-icon" style="background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.2);color:#F87171"><i class="fas fa-clock-rotate-left"></i></div>
          <h3>60-Day Token Refresh</h3>
          <p>Long-lived page tokens mean zero reconnection headaches. Stay connected for 60 days without having to re-login to Facebook.</p>
        </div>
        <div class="feat">
          <div class="feat-icon" style="background:rgba(8,102,255,.12);border-color:rgba(8,102,255,.25);color:#4F9FFF"><i class="fas fa-layer-group"></i></div>
          <h3>Auto All Pages Mode</h3>
          <p>One click broadcasts sequentially across every Facebook Page you manage — no manual switching, no missed audiences, fully automated.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- HOW IT WORKS -->
  <section id="how-it-works">
    <div class="section">
      <span class="section-label">How It Works</span>
      <h2 class="section-h2">Up and running in 3 steps</h2>
      <p class="section-sub" style="margin-bottom:0">Get started in under a minute.</p>
      <div class="steps-grid">
        <div class="step">
          <div class="step-num">1</div>
          <h3>Connect Facebook</h3>
          <p>Log in with your Facebook account. We request only the minimum permissions needed to access your pages.</p>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <h3>Select a Page</h3>
          <p>Choose the Facebook Page you want to broadcast from. Audience loads automatically when you start.</p>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <h3>Write &amp; Send</h3>
          <p>Type your message and hit Start. Watch messages deliver in real-time with live analytics.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PRICING -->
  <div class="pricing-wrap" id="pricing">
    <div class="section">
      <span class="section-label"><i class="fas fa-tag" style="font-size:10px"></i> Pricing</span>
      <h2 class="section-h2">Simple, transparent pricing</h2>
      <p class="section-sub">Start free. Upgrade when you need more reach.</p>

      <div class="promo-banner">
        <span class="promo-fire">🔥</span>
        <span class="promo-banner-text"><strong>Sign-Up Special:</strong> 50% OFF all plans — This month only!</span>
        <span class="promo-countdown">Limited time offer</span>
      </div>

      <div class="pricing-grid pricing-grid--6">

        <!-- Starter -->
        <div class="price-card">
          <div class="price-name">Starter</div>
          <div class="price-discount-badge">50% OFF</div>
          <div class="price-original"><s>$10</s>/mo</div>
          <div class="price-amount">$5<sub>/mo</sub></div>
          <div class="price-billing">Perfect for trying out the platform</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 30,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> All Facebook Pages</li>
            <li><i class="fas fa-check"></i> Dedicated support</li>
          </ul>
          <button class="price-btn price-btn--basic" onclick="triggerConnect('starter')">Get Started</button>
        </div>

        <!-- Bronze -->
        <div class="price-card">
          <div class="price-name">Bronze</div>
          <div class="price-discount-badge">50% OFF</div>
          <div class="price-original"><s>$30</s>/mo</div>
          <div class="price-amount">$15<sub>/mo</sub></div>
          <div class="price-billing">Perfect for small businesses</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 300,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> Label targeting</li>
            <li><i class="fas fa-check"></i> Dedicated support</li>
          </ul>
          <button class="price-btn price-btn--basic" onclick="triggerConnect('basic')">Get Started</button>
        </div>

        <!-- Silver -->
        <div class="price-card">
          <div class="price-name">Silver</div>
          <div class="price-discount-badge">50% OFF</div>
          <div class="price-original"><s>$60</s>/mo</div>
          <div class="price-amount">$30<sub>/mo</sub></div>
          <div class="price-billing">For growing businesses</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 650,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> Auto All Pages mode</li>
            <li><i class="fas fa-check"></i> Dedicated support</li>
          </ul>
          <button class="price-btn price-btn--pro" onclick="triggerConnect('pro')">Get Started</button>
        </div>

        <!-- Gold — POPULAR -->
        <div class="price-card price-card--featured price-card--gold">
          <div class="price-popular">POPULAR</div>
          <div class="price-name">Gold</div>
          <div class="price-discount-badge price-discount-badge--gold">50% OFF</div>
          <div class="price-original price-original--gold"><s>$120</s>/mo</div>
          <div class="price-amount">$60<sub>/mo</sub></div>
          <div class="price-billing">For high-volume needs</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 1,750,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> Priority support</li>
            <li><i class="fas fa-check"></i> All Silver features</li>
          </ul>
          <button class="price-btn price-btn--gold" onclick="triggerConnect('gold')">Get Started</button>
        </div>

        <!-- Sapphire -->
        <div class="price-card">
          <div class="price-name">Sapphire</div>
          <div class="price-discount-badge">50% OFF</div>
          <div class="price-original"><s>$200</s>/mo</div>
          <div class="price-amount">$100<sub>/mo</sub></div>
          <div class="price-billing">For large scale operations</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 4,000,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> Priority support</li>
            <li><i class="fas fa-check"></i> All Gold features</li>
          </ul>
          <button class="price-btn price-btn--pro" onclick="triggerConnect('sapphire')">Get Started</button>
        </div>

        <!-- Platinum -->
        <div class="price-card">
          <div class="price-name">Platinum</div>
          <div class="price-discount-badge">50% OFF</div>
          <div class="price-original"><s>$300</s>/mo</div>
          <div class="price-amount">$150<sub>/mo</sub></div>
          <div class="price-billing">For enterprises with massive scale</div>
          <div class="price-sep"></div>
          <ul class="price-feats">
            <li><i class="fas fa-check"></i> 7,000,000 messages/month</li>
            <li><i class="fas fa-check"></i> 30-day validity</li>
            <li><i class="fas fa-check"></i> Priority support</li>
            <li><i class="fas fa-check"></i> All Sapphire features</li>
          </ul>
          <button class="price-btn price-btn--pro" onclick="triggerConnect('pro_unlimited')">Get Started</button>
        </div>

      </div>
    </div>
  </div>

  <!-- TESTIMONIALS -->
  <section id="testimonials">
    <div class="testimonials-wrap">
      <div class="section-center">
        <span class="section-label">Testimonials</span>
        <h2 class="section-h2">Trusted by businesses worldwide</h2>
        <p class="section-sub section-center" style="margin:0 auto">See what our users are saying about FBCast Pro.</p>
      </div>
      <div class="testimonial-meta">
        <div class="tm-score-group">
          <div class="tm-stars"><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i></div>
          <div class="tm-score">4.9</div>
          <div class="tm-score-lbl">out of 5</div>
        </div>
        <div class="tm-divider"></div>
        <div class="tm-stat"><strong>500+</strong><span>businesses worldwide</span></div>
        <div class="tm-divider"></div>
        <div class="tm-stat"><strong>98%</strong><span>satisfaction rate</span></div>
        <div class="tm-divider"></div>
        <div class="tm-stat"><strong>30+</strong><span>countries served</span></div>
      </div>
      <div class="testimonials-grid">
        <div class="testimonial">
          <div class="testimonial-stars">
            <i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i>
          </div>
          <p class="testimonial-text">"FBCast Pro transformed our business completely. We now message 50,000 followers in under 2 hours. The ROI is extraordinary — sales up 40% the first month."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar avatar-1">AK</div>
            <div>
              <div class="testimonial-name">Ahmad Khan</div>
              <div class="testimonial-role">Owner · Khan Electronics, Lahore</div>
              <div class="testimonial-verified"><i class="fas fa-circle-check"></i> Verified Pro User</div>
            </div>
          </div>
        </div>
        <div class="testimonial">
          <div class="testimonial-stars">
            <i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i>
          </div>
          <p class="testimonial-text">"The ISP bypass is a game changer. Before, half our messages were blocked. Now we're hitting 98% delivery consistently. Customer engagement tripled in one month."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar avatar-2">SR</div>
            <div>
              <div class="testimonial-name">Sara Rehman</div>
              <div class="testimonial-role">Marketing Manager · Karachi</div>
              <div class="testimonial-verified"><i class="fas fa-circle-check"></i> Verified Basic User</div>
            </div>
          </div>
        </div>
        <div class="testimonial">
          <div class="testimonial-stars">
            <i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i>
          </div>
          <p class="testimonial-text">"We manage 12 Facebook pages. Auto All Pages broadcasts to all of them in one click. What used to take a full day now runs automatically while we sleep."</p>
          <div class="testimonial-author">
            <div class="testimonial-avatar avatar-3">UB</div>
            <div>
              <div class="testimonial-name">Umar Butt</div>
              <div class="testimonial-role">Agency Owner · Islamabad</div>
              <div class="testimonial-verified"><i class="fas fa-circle-check"></i> Verified Pro User</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <div class="faq-outer" id="faq">
    <div class="faq-inner">
      <div class="section-center">
        <span class="section-label">FAQ</span>
        <h2 class="section-h2">Frequently asked questions</h2>
      </div>
      <div class="faq-grid">
        <div class="faq-item">
          <div class="faq-q">
            Is it really free to start?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">Yes — you get 2,000 messages for free with no credit card required. Just log in with Facebook and start broadcasting immediately.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">
            Does it work with regional Facebook access restrictions?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">Yes. All API calls are routed through our server-side proxy, bypassing ISP-level blocks on the Facebook Graph API. This ensures near-100% delivery regardless of your connection.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">
            How many Facebook Pages can I use?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">All plans support unlimited Facebook Pages. Your message quota is shared across all pages. The Pro plan's Auto All Pages mode can broadcast to all your pages sequentially with one click.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">
            Is my Facebook account safe?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">We use official Facebook OAuth — we never ask for or store your password. We only request the minimum permissions needed to access your page conversations. Your access token is stored encrypted and never shared.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">
            Can I cancel my subscription anytime?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">Absolutely. Cancel any time from your billing portal — no questions asked. Your account reverts to free status at the end of your billing period.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">
            What payment methods are accepted?
            <div class="faq-q-icon"><i class="fa-solid fa-plus"></i></div>
          </div>
          <div class="faq-a">We accept all major credit and debit cards via Stripe — Visa, Mastercard, and American Express. All payments are secured with 256-bit SSL encryption.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- CTA SECTION -->
  <section class="cta-section">
    <div class="cta-box">
      <div class="cta-urgency"><i class="fas fa-fire"></i> 50+ businesses signed up this week</div>
      <div class="cta-eyebrow"><i class="fab fa-facebook-messenger"></i> Get Started Today</div>
      <h2 class="cta-h2">Start reaching your<br><span>Facebook audience</span> now</h2>
      <p class="cta-sub">Join 500+ businesses broadcasting directly to their Facebook followers with 98% delivery rate — starting completely free.</p>
      <div class="cta-actions">
        <button class="btn-cta-primary" onclick="triggerConnect()">
          <i class="fab fa-facebook" style="font-size:17px"></i>
          Connect Facebook — It's Free
        </button>
      </div>
      <div class="cta-note">
        <span class="cta-note-item"><i class="fas fa-check"></i> No credit card required</span>
        <span style="color:var(--border2)">·</span>
        <span class="cta-note-item"><i class="fas fa-check"></i> 2,000 free messages</span>
        <span style="color:var(--border2)">·</span>
        <span class="cta-note-item"><i class="fas fa-check"></i> Cancel anytime</span>
      </div>
    </div>
  </section>

  <!-- TRUST STRIP -->
  <div class="trust-strip">
    <div class="trust-item"><i class="fa-solid fa-lock"></i> 256-bit SSL Encrypted</div>
    <div class="trust-item"><i class="fa-brands fa-stripe"></i> Powered by Stripe</div>
    <div class="trust-item"><i class="fa-brands fa-facebook"></i> Official Facebook OAuth</div>
    <div class="trust-item"><i class="fa-solid fa-shield-halved"></i> No Password Stored</div>
    <div class="trust-item"><i class="fa-solid fa-server"></i> 99.9% Uptime SLA</div>
    <div class="trust-item"><i class="fa-solid fa-ban"></i> Cancel Anytime</div>
  </div>

  <!-- ENHANCED FOOTER -->
  <footer class="footer-enhanced">
    <div class="footer-grid">
      <!-- Brand column -->
      <div class="footer-brand-col">
        <a class="footer-brand" href="#">
          <div class="nav-brand-mark" style="width:34px;height:34px;font-size:14px;"><img src="images/castpro2.png" alt="FBCast Pro" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;"></div>
          <span style="font-weight:800;font-size:15px;letter-spacing:-.3px;color:#fff">FBCast <em style="font-style:normal;color:var(--blue-light)">Pro</em></span>
        </a>
        <p class="footer-brand-tagline">The fastest way to broadcast messages to all your Facebook Page followers. Built for businesses worldwide.</p>
        <div style="display:flex;gap:10px;margin-top:4px">
          <div class="footer-social-icon"><i class="fab fa-facebook-f"></i></div>
          <div class="footer-social-icon"><i class="fab fa-twitter"></i></div>
        </div>
      </div>
      <!-- Product column -->
      <div>
        <div class="footer-col-title">Product</div>
        <div class="footer-col-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How It Works</a>
          <a href="#pricing">Pricing</a>
          <a href="#" onclick="triggerConnect();return false">Get Started Free</a>
        </div>
      </div>
      <!-- Company column -->
      <div>
        <div class="footer-col-title">Company</div>
        <div class="footer-col-links">
          <a href="#testimonials">Testimonials</a>
          <a href="#faq">FAQ</a>
          <a href="mailto:<?php echo $js_contact_email; ?>" id="footerContactLink">Contact Us</a>
        </div>
      </div>
      <!-- Legal column -->
      <div>
        <div class="footer-col-title">Legal</div>
        <div class="footer-col-links">
          <a href="#" id="footerPrivacyBtn">Privacy Policy</a>
          <a href="#" id="footerTermsBtn">Terms of Service</a>
          <a href="#">Cookie Policy</a>
        </div>
      </div>
    </div>
    <!-- Footer bottom bar -->
    <div class="footer-bottom">
      <div class="footer-bottom-copy">© <?php echo date('Y'); ?> FBCast Pro · Built for businesses worldwide</div>
      <div class="footer-bottom-status">
        <span class="footer-status-dot"></span>
        All systems operational
      </div>
      <div class="footer-bottom-links">
        <a href="#" id="footerPrivacyBtn2">Privacy</a>
        <a href="#" id="footerTermsBtn2">Terms</a>
        <a href="graphify.php">Graphify</a>
      </div>
    </div>
  </footer>

  <!-- ── Drive Video Player ── -->
  <div id="demoVideoWidget" class="dvw">
    <button class="dvw-close-btn" id="dvwClose" title="Close">
      <i class="fa-solid fa-xmark"></i>
    </button>
    <div class="dvw-iframe-wrap">
      <div class="dvw-play-btn"><i class="fa-solid fa-play" style="margin-left:3px"></i></div>
      <iframe
        id="dvwIframe"
        class="dvw-iframe"
        data-src="https://drive.google.com/file/d/1c3EwdXunmR1u7HMTU0n2FYCoDOJiGAfi/preview"
        allow="autoplay"
        allowfullscreen
        frameborder="0"
      ></iframe>
    </div>
  </div>

</div>


<!-- ═══ APP DASHBOARD ═══ -->
<div id="appPage" style="display:none">

  <!-- TOPBAR -->
  <div class="topbar">
    <div class="topbar-brand">
      <div class="topbar-mark"><img src="images/castpro2.png" alt="FBCast Pro" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;"></div>
      <div class="topbar-title">
        <h1>FBCast Pro</h1>
        <p>Facebook Broadcast Platform</p>
      </div>
    </div>

    <div id="statusBar" role="status" aria-live="polite"></div>

    <div id="announcementBar" class="topbar-announcement" role="status" aria-live="polite" hidden>
      <span class="announcement-pill"><i class="fa-solid fa-bullhorn"></i> Update</span>
      <div class="announcement-body">
        <div class="announcement-media-wrap" id="announcementMediaWrap"></div>
        <div class="announcement-text-wrap">
          <div class="announcement-text-track" id="announcementTextTrack"></div>
        </div>
      </div>
      <a id="announcementCta" class="announcement-cta" href="#" target="_blank" rel="noopener noreferrer" hidden>View</a>
    </div>

    <div class="topbar-main">
      <!-- QUOTA WIDGET -->
      <div class="quota-widget" style="position:relative" title="Messages remaining this month">
        <div class="quota-plan-group quota-plan-group--plan">
          <span class="quota-micro-label">Plan</span>
          <span id="planBadge">Free</span>
        </div>
        <div class="quota-divider"></div>
        <div class="quota-plan-group quota-plan-group--value">
          <span class="quota-micro-label">Remaining</span>
          <div class="quota-remaining">
            <span class="quota-num" id="quotaVal">2,000</span>
            <span class="quota-sep">/</span>
            <span class="quota-total-num" id="quotaTotal">2,000</span>
          </div>
        </div>
        <button onclick="if(typeof openUpgradeModal==='function')openUpgradeModal(this);else document.getElementById('upgradeModal').style.display='flex'" class="btn-upgrade">
          <i class="fa-solid fa-crown" style="font-size:10px;"></i> Upgrade
        </button>
        <div id="quotaEmptyOverlay" class="quota-empty-overlay">
          <i class="fa-solid fa-circle-exclamation"></i>
          <span>Quota Exhausted</span>
          <button onclick="if(typeof openUpgradeModal==='function')openUpgradeModal(this);else document.getElementById('upgradeModal').style.display='flex'">Upgrade Now</button>
        </div>
      </div>

      <div class="topbar-status">
        <!-- User avatar -->
        <div class="topbar-user-btn" id="topbarUserBtn" title="Logged in user">
          <div class="topbar-avatar" id="topbarAvatar">?</div>
          <span class="topbar-user-name" id="topbarUserName">Not connected</span>
        </div>

        <div id="loginStatus">
          <span class="ls-dot"></span>
          <span id="loginStatusText">Not connected</span>
        </div>

        <!-- THEME TOGGLE -->
        <label class="theme-toggle" title="Toggle theme">
          <input type="checkbox" id="themeToggle" checked>
          <span class="tt-track">
            <i class="fa-solid fa-moon tt-icon tt-icon--dark"></i>
            <i class="fa-solid fa-sun tt-icon tt-icon--light"></i>
            <span class="tt-thumb"></span>
          </span>
        </label>
      </div>
    </div>

    <button id="btnLogin" style="display:none"></button>
  </div>

  <!-- STATUS BAR -->
  <div id="networkBanner" class="network-banner" role="status" aria-live="polite" hidden></div>

  <!-- BODY -->
  <div class="app-body">

    <!-- COL 0: HOME/NAV SIDEBAR -->
    <div class="nav-sidebar">
      <div class="nav-sidebar-hdr">
        <img src="images/castpro2.png" alt="FBCast" style="width:28px;height:28px;border-radius:8px;">
        <span>Menu</span>
      </div>
      <div class="nav-sidebar-items">
        <a class="nav-side-item active" href="#" onclick="switchDashboardView('home');return false;" id="navItemHome">
          <i class="fa-solid fa-house"></i>
          <span>Home</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('broadcast');return false;" id="navItemBroadcast">
          <i class="fa-solid fa-bullhorn"></i>
          <span>Broadcast</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('analytics');return false;" id="navItemAnalytics">
          <i class="fa-solid fa-chart-line"></i>
          <span>Analytics</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('messenger');return false;" id="navItemMessenger">
          <i class="fa-brands fa-facebook-messenger"></i>
          <span>Messenger</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('templates');return false;" id="navItemTemplates">
          <i class="fa-solid fa-bookmark"></i>
          <span>Templates</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('settings');return false;" id="navItemSettings">
          <i class="fa-solid fa-gear"></i>
          <span>Settings</span>
        </a>
        <a class="nav-side-item" href="#" onclick="switchDashboardView('help');return false;" id="navItemHelp">
          <i class="fa-solid fa-circle-question"></i>
          <span>Help</span>
        </a>
      </div>
      <div class="nav-sidebar-footer">
        <div class="nav-user-info">
          <div class="nav-user-avatar" id="navUserAvatar">?</div>
          <div class="nav-user-details">
            <div class="nav-user-name" id="navUserName">User</div>
            <div class="nav-user-plan" id="navUserPlan">Free Plan</div>
          </div>
        </div>
      </div>
    </div>

    <!-- COL 1: SIDEBAR / PAGES -->
    <div class="sidebar">
      <div class="sidebar-hdr">
        <div class="sidebar-hdr-label">
          <div class="sidebar-hdr-label-left">
            <i class="fa-solid fa-flag"></i>
            <span>Pages</span>
          </div>
          <span class="sidebar-page-count" id="sidebarPageCount" style="display:none">0</span>
        </div>
      </div>
      <div class="sidebar-pages">
        <div id="pageCards">
          <div class="pages-empty">
            <i class="fa-brands fa-facebook"></i>
            <p>Your pages will load automatically after login</p>
          </div>
        </div>
        <select id="pageSelect" style="display:none"></select>
        <img id="pageLogo" style="display:none" src="" alt="Facebook Page Logo">
      </div>
      <!-- Quick Tips Panel -->
      <div class="sidebar-tips">
        <div class="sidebar-tips-hdr"><i class="fa-solid fa-lightbulb"></i> Quick Tips</div>
        <div class="sidebar-tips-list">
          <div class="stip-item"><i class="fa-solid fa-check-circle stip-green"></i><span>Use <strong>Normal</strong> delay for best results</span></div>
          <div class="stip-item"><i class="fa-solid fa-check-circle stip-green"></i><span>Keep messages under 200 characters</span></div>
          <div class="stip-item"><i class="fa-solid fa-check-circle stip-green"></i><span>Add images to boost engagement</span></div>
          <div class="stip-item"><i class="fa-solid fa-check-circle stip-green"></i><span>Test with a small group first</span></div>
        </div>
      </div>

      <div class="sidebar-footer">
        <button onclick="triggerLogout()" class="btn-logout">
          <i class="fa-solid fa-right-from-bracket" style="font-size:10px;"></i> Logout
        </button>
      </div>
    </div>

    <!-- HOME VIEW (default) -->
    <div id="view-home" class="home-view">

      <!-- Home Hero Banner -->
      <div class="home-hero-banner">
        <div class="hhb-glow"></div>
        <div class="hhb-content">
          <div class="hhb-badge">
            <i class="fa-brands fa-facebook-messenger"></i>
            FBCast Pro Dashboard
          </div>
          <h2 class="hhb-title">Welcome back, <span id="homeUserName">User</span>!</h2>
          <p class="hhb-sub">Ready to reach your audience? Start broadcasting to all your Facebook Page followers instantly.</p>
          <div class="hhb-actions">
            <button class="hhb-btn-primary" onclick="switchDashboardView('broadcast')">
              <i class="fa-solid fa-bullhorn"></i> Start Broadcasting
            </button>
            <button class="hhb-btn-secondary" onclick="switchDashboardView('analytics')">
              <i class="fa-solid fa-chart-line"></i> View Analytics
            </button>
          </div>
        </div>
        <div class="hhb-stats-row">
          <div class="hhb-stat">
            <div class="hhb-stat-val" id="homeTotalBroadcasts">0</div>
            <div class="hhb-stat-lbl">Total Broadcasts</div>
          </div>
          <div class="hhb-stat">
            <div class="hhb-stat-val" id="homeTotalMessages">0</div>
            <div class="hhb-stat-lbl">Total Sent</div>
          </div>
          <div class="hhb-stat">
            <div class="hhb-stat-val sent-val" id="homeSentCount">0</div>
            <div class="hhb-stat-lbl">Delivered</div>
          </div>
          <div class="hhb-stat">
            <div class="hhb-stat-val failed-val" id="homeFailedCount">0</div>
            <div class="hhb-stat-lbl">Failed</div>
          </div>
          <div class="hhb-stat">
            <div class="hhb-stat-val pending-val" id="homePendingCount">0</div>
            <div class="hhb-stat-lbl">Pending</div>
          </div>
        </div>
      </div>

      <!-- Plan Info Banner -->
      <div class="home-plan-banner">
        <div class="home-plan-left">
          <div class="hpb-plan-badge">
            <i class="fa-solid fa-crown"></i>
            <span id="homePlanName">Free Plan</span>
          </div>
          <div class="hpb-plan-info">
            <div class="hpb-msg-used">
              <span class="hpb-used-num" id="homeMsgUsed">0</span>
              <span class="hpb-sep">/</span>
              <span class="hpb-total-num" id="homeMsgTotal">2,000</span>
              <span class="hpb-lbl">messages used</span>
            </div>
          </div>
        </div>
        <div class="home-plan-right">
          <div class="hpb-progress-bar">
            <div class="hpb-progress-fill" id="homePlanProgress"></div>
          </div>
          <span class="hpb-progress-pct" id="homePlanPct">0%</span>
          <button class="hpb-upgrade-btn" onclick="if(typeof openUpgradeModal==='function')openUpgradeModal(this);else document.getElementById('upgradeModal').style.display='flex'">
            <i class="fa-solid fa-rocket"></i> Upgrade
          </button>
        </div>
      </div>

      <!-- Quick Actions Cards -->
      <div class="home-quick-actions">
        <div class="home-quick-grid">
          <div class="home-qa-card" onclick="switchDashboardView('broadcast')">
            <div class="qa-card-icon qa-icon-blue"><i class="fa-solid fa-paper-plane"></i></div>
            <div class="qa-card-body">
              <div class="qa-card-title">New Broadcast</div>
              <div class="qa-card-desc">Send a message to all your page followers</div>
            </div>
            <i class="fa-solid fa-arrow-right qa-card-arrow"></i>
          </div>
          <div class="home-qa-card" onclick="switchDashboardView('templates')">
            <div class="qa-card-icon qa-icon-purple"><i class="fa-solid fa-bookmark"></i></div>
            <div class="qa-card-body">
              <div class="qa-card-title">Templates</div>
              <div class="qa-card-desc">Use pre-built message templates</div>
            </div>
            <i class="fa-solid fa-arrow-right qa-card-arrow"></i>
          </div>
          <div class="home-qa-card" onclick="switchDashboardView('analytics')">
            <div class="qa-card-icon qa-icon-green"><i class="fa-solid fa-chart-line"></i></div>
            <div class="qa-card-body">
              <div class="qa-card-title">Analytics</div>
              <div class="qa-card-desc">Track your broadcast performance</div>
            </div>
            <i class="fa-solid fa-arrow-right qa-card-arrow"></i>
          </div>
          <div class="home-qa-card" onclick="switchDashboardView('settings')">
            <div class="qa-card-icon qa-icon-amber"><i class="fa-solid fa-gear"></i></div>
            <div class="qa-card-body">
              <div class="qa-card-title">Settings</div>
              <div class="qa-card-desc">Configure your preferences</div>
            </div>
            <i class="fa-solid fa-arrow-right qa-card-arrow"></i>
          </div>
        </div>
      </div>

      <!-- Pages Overview -->
      <div class="home-pages-overview" id="homePagesOverview">
        <div class="hpo-hdr">
          <span><i class="fa-brands fa-facebook"></i> Your Facebook Pages</span>
          <span class="hcp-count" id="homePagesCountBadge2">0 Pages</span>
        </div>
        <div class="hpo-grid" id="homePagesGrid">
          <!-- Pages will be loaded here dynamically -->
        </div>
      </div>

      <!-- Connected Pages + Recent Activity -->
      <div class="home-bottom-grid">
        <!-- Connected Pages -->
        <div class="home-card-panel">
          <div class="hcp-hdr">
            <span><i class="fa-brands fa-facebook"></i> Your Facebook Pages</span>
            <span class="hcp-count" id="homePagesCountBadge">0</span>
          </div>
          <div class="hcp-pages-list" id="homePagesList">
            <div class="hcp-empty">
              <i class="fa-brands fa-facebook"></i>
              <p>No pages connected yet.<br>Connect with Facebook to get started.</p>
              <button class="hcp-connect-btn" onclick="triggerConnect()">
                <i class="fa-brands fa-facebook"></i> Connect Facebook
              </button>
            </div>
          </div>
        </div>

        <!-- Recent Activity -->
        <div class="home-card-panel">
          <div class="hcp-hdr">
            <span><i class="fa-solid fa-clock-rotate-left"></i> Recent Broadcasts</span>
          </div>
          <div class="hcp-activity-list" id="homeActivityList">
            <div class="hcp-empty">
              <i class="fa-solid fa-bullhorn"></i>
              <p>No broadcasts yet.<br>Start your first broadcast to see history here.</p>
              <button class="hcp-connect-btn" onclick="switchDashboardView('broadcast')">
                <i class="fa-solid fa-paper-plane"></i> Start Now
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Latest Broadcast Results -->
      <div class="home-results-section" id="homeResultsSection" style="display:none">
        <div class="hrs-hdr">
          <span><i class="fa-solid fa-chart-bar"></i> Latest Broadcast Results</span>
          <span class="hrs-badge" id="hrsBadge">0 sent</span>
        </div>
        <div class="hrs-results-grid" id="hrsResultsGrid">
          <!-- Dynamic results will be injected here -->
        </div>
      </div>

    </div><!-- /view-home -->

    <!-- MESSENGER VIEW — 2-column (pages handled by outer sidebar) -->
    <div id="view-messenger" style="display:none;height:100%;overflow:hidden">
      <div class="msng-root">

        <!-- COL 1: Conversations -->
        <div class="msng-convs" id="msngConvsCol">
          <div class="msng-convs-hdr">
            <div class="msng-convs-title-wrap">
              <h1 class="msng-convs-title">Messages</h1>
              <div class="msng-convs-actions">
                <button class="msng-chat-hdr-btn" onclick="msngSyncNow()" title="Sync from Facebook">
                  <i class="fa-solid fa-rotate"></i>
                </button>
              </div>
            </div>
          </div>
          <div class="msng-search-wrap" style="margin: 0 16px 16px 16px;">
            <i class="fa-solid fa-magnifying-glass" style="color: var(--msng-text-muted); font-size: 13px"></i>
            <input type="text" class="msng-search-input" placeholder="Search conversations..." oninput="msngSearch(this)">
          </div>
          <div class="msng-conv-list" id="msngConvList">
            <div class="msng-empty">
              <i class="fa-brands fa-facebook-messenger"></i>
              <p>Loading conversations…</p>
            </div>
          </div>
        </div>

        <!-- COL 3: Chat -->
        <div class="msng-chat">

          <!-- Empty state -->
          <div class="msng-chat-empty" id="msngChatEmpty">
            <div class="msng-chat-empty-icon">
              <i class="fa-brands fa-facebook-messenger"></i>
            </div>
            <h4>Select a conversation</h4>
            <p>Choose a conversation from the left to start chatting with your customers.</p>
          </div>

          <!-- Chat window (shown when conversation is open) -->
          <div class="msng-chat-window" id="msngChatWindow" style="display:none">

            <!-- Header -->
            <div class="msng-chat-hdr">
              <div class="msng-chat-hdr-info-wrap">
                <div class="msng-chat-hdr-avatar" id="msngChatHdrAvatar">
                  <div class="msng-hdr-initial">U</div>
                </div>
                <div class="msng-chat-hdr-info">
                  <div class="msng-chat-hdr-name" id="msngChatHdrName">User</div>
                  <div class="msng-chat-hdr-sub" id="msngChatHdrSub">
                    <i class="fa-solid fa-circle dot-green" style="font-size:7px;color:#22c55e"></i>
                    Facebook Messenger
                  </div>
                </div>
              </div>

              <div class="msng-chat-hdr-btns">
                <button class="msng-chat-hdr-btn" onclick="msngMarkRead()" title="Mark as read">
                  <i class="fa-solid fa-check-double"></i>
                </button>
                <button class="msng-chat-hdr-btn" onclick="msngScrollToBottom()" title="Scroll to bottom">
                  <i class="fa-solid fa-angles-down"></i>
                </button>
              </div>
            </div>

            <!-- Messages -->
            <div class="msng-msgs" id="msngMsgs"></div>

            <!-- Scroll to bottom button -->
            <button class="msng-scroll-btn" id="msngScrollBtn" onclick="msngScrollToBottom()">
              <i class="fa-solid fa-chevron-down"></i>
            </button>

            <!-- Typing indicator -->
            <div class="msng-typing" id="msngTyping">
              <div class="msng-typing-dots">
                <span></span><span></span><span></span>
              </div>
            </div>

            <!-- Input Bar -->
            <div class="msng-input-bar">
              <div class="msng-input-wrap">
                <textarea class="msng-textarea" id="msngMsgTextarea" rows="1"
                  placeholder="Type a message…"
                  onkeydown="msngKeydown(event)"
                  oninput="msngTextareaInput(this)"></textarea>
              </div>
              <button class="msng-send-btn" id="msngSendBtn" onclick="msngSend()" title="Send">
                <i class="fa-solid fa-paper-plane"></i>
              </button>
            </div>

          </div><!-- /chat-window -->
        </div><!-- /col-3 -->

      </div><!-- /msng-root -->
    </div><!-- /view-messenger -->

    <!-- Toast notification -->
    <div class="msng-toast" id="msngToast"></div>

    <!-- BROADCAST VIEW -->
    <div id="view-broadcast" class="broadcast-view" style="display:none">

    <!-- COL 2: MESSAGE COMPOSE -->
    <div class="compose">

      <div class="compose-section">
        <div class="compose-hdr">
          <h3><i class="fa-brands fa-facebook-messenger compose-hdr-icon"></i> Message</h3>
          <button class="recipients-toggle-btn" id="recipientsToggleBtn" title="Show Recipients">
            <i class="fa-solid fa-users"></i> Recipients
          </button>
        </div>
        <textarea id="messageText" rows="7" placeholder="Write your broadcast message here…"></textarea>
        <div id="charCount">0 / 2000</div>
        <div class="char-count-bar"><div class="char-count-fill" id="charCountFill"></div></div>

        <!-- IMAGE ATTACHMENT -->
        <div class="img-attach-wrap">
          <button class="img-attach-toggle" id="imgAttachToggle" type="button" aria-expanded="true" aria-controls="imgAttachPanel">
            <i class="fa-solid fa-image"></i>
            <span>Attach Image</span>
            <span class="img-attach-badge" id="imgAttachBadge" style="display:none">1</span>
          </button>
        </div>
        <div class="img-attach-panel" id="imgAttachPanel">
          <div class="img-tab-row" role="tablist">
            <button class="img-tab-btn" id="imgTabUrl" data-tab="url" type="button" role="tab" aria-selected="false">
              <i class="fa-solid fa-link"></i> URL
            </button>
            <button class="img-tab-btn active" id="imgTabUpload" data-tab="upload" type="button" role="tab" aria-selected="true">
              <i class="fa-solid fa-cloud-arrow-up"></i> Upload
            </button>
          </div>
          <div class="img-url-area" id="imgUrlArea" style="display:none">
            <input type="url" id="imgUrlInput" placeholder="https://example.com/image.jpg" class="img-url-input" autocomplete="off">
            <button type="button" id="imgUrlLoad" class="img-url-load-btn" title="Load image from URL">
              <i class="fa-solid fa-check"></i>
            </button>
          </div>
          <div class="img-upload-area" id="imgUploadArea">
            <label class="img-drop-zone" for="imgFileInput" id="imgDropZone">
              <i class="fa-solid fa-cloud-arrow-up"></i>
              <span>Click or drag image here</span>
              <small>JPEG · PNG · WebP · GIF &nbsp;·&nbsp; max 5 MB</small>
            </label>
            <input type="file" id="imgFileInput" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none">
            <div class="img-upload-progress" id="imgUploadProgress" style="display:none">
              <i class="fa-solid fa-circle-notch fa-spin"></i>
              <span id="imgUploadProgressText">Uploading…</span>
            </div>
          </div>
          <div class="img-preview-wrap" id="imgPreviewWrap" style="display:none">
            <div class="img-preview-box">
              <img id="imgPreviewThumb" src="" alt="Image preview">
              <div class="img-preview-info">
                <span id="imgPreviewLabel" class="img-preview-label">Image ready to send</span>
                <button type="button" id="imgClearBtn" class="img-clear-btn" title="Remove image">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="compose-notice compose-notice--tip">
          <i class="fa-solid fa-bolt"></i>
          <div>Keep messages <strong>short & personal</strong> for higher open rates and better reach.</div>
        </div>
      </div>

    </div>

    <!-- COL 3: SETTINGS + BROADCAST -->
    <div class="broadcast-col">

      <!-- Settings -->
      <div class="compose-section">
        <div class="compose-hdr">
          <h3><i class="fa-solid fa-sliders compose-hdr-icon"></i> Settings</h3>
        </div>
        <label class="field-label"><i class="fa-solid fa-clock"></i> Delay Between Messages</label>
        <div class="delay-presets" id="delayPresets" role="group" aria-label="Delay between messages">
          <button type="button" class="delay-preset" data-delay="3000">
            <i class="fa-solid fa-shield-halved"></i>
            <span class="delay-name">Slow</span>
            <span class="delay-value">3000 ms</span>
          </button>
          <button type="button" class="delay-preset active" data-delay="1200">
            <i class="fa-solid fa-gauge"></i>
            <span class="delay-name">Normal</span>
            <span class="delay-value">1200 ms</span>
          </button>
          <button type="button" class="delay-preset" data-delay="500">
            <i class="fa-solid fa-bolt"></i>
            <span class="delay-name">Fast</span>
            <span class="delay-value">500 ms</span>
          </button>
        </div>
        <input id="delayMs" type="hidden" value="1200">
        <div class="field-hint"><i class="fa-solid fa-circle-info" style="color:var(--primary-light);margin-right:4px"></i>Slow: safer · Normal: recommended · Fast: aggressive</div>
      </div>

      <!-- Broadcast -->
      <div class="compose-section">
        <div class="compose-hdr">
          <h3><i class="fa-solid fa-bullhorn compose-hdr-icon"></i> Broadcast</h3>
          <div class="mode-pills">
            <button class="mode-pill active" id="modeManualBtn">Manual</button>
            <button class="mode-pill" id="modeAutoBtn">Auto All</button>
          </div>
        </div>

        <!-- Manual Mode -->
        <div id="manualControls">
          <!-- Mini session stats -->
          <div class="bcast-mini-stats">
            <div class="bcast-mini-stat bms-total">
              <div class="bcast-mini-stat-val" id="miniStatTotal">0</div>
              <div class="bcast-mini-stat-lbl">Total</div>
            </div>
            <div class="bcast-mini-stat bms-sent">
              <div class="bcast-mini-stat-val" id="miniStatSent">0</div>
              <div class="bcast-mini-stat-lbl">Sent</div>
            </div>
            <div class="bcast-mini-stat bms-failed">
              <div class="bcast-mini-stat-val" id="miniStatFailed">0</div>
              <div class="bcast-mini-stat-lbl">Failed</div>
            </div>
          </div>
          <div id="sendHint">Select a page, write message, then start broadcast</div>
          <div class="action-btns">
            <button id="btnStart"  class="act-btn"><i class="fa-solid fa-play"></i> Start Broadcast</button>
            <button id="btnPause"  class="act-btn"><i class="fa-solid fa-pause"></i> Pause</button>
            <button id="btnResume" class="act-btn"><i class="fa-solid fa-rotate-right"></i> Resume</button>
            <button id="btnStop"   class="act-btn"><i class="fa-solid fa-stop"></i> Stop</button>
          </div>
          <div class="extra-actions">
            <button type="button" class="btn-extra btn-retry" id="btnRetryFailed" disabled title="Retry all failed messages">
              <i class="fa-solid fa-rotate-right"></i> Retry Failed
            </button>
            <button type="button" class="btn-extra" id="btnExportCSV" disabled title="Export results as CSV">
              <i class="fa-solid fa-file-arrow-down"></i> Export CSV
            </button>
          </div>
        </div>

        <!-- Auto Mode -->
        <div id="autoControls" style="display:none">
          <div class="auto-info" id="autoStatusCard">
            <i class="fa-solid fa-circle-info"></i>
            <span>All pages will be broadcast sequentially — fully automated.</span>
          </div>
          <div id="autoPageBadge" style="display:none" class="page-badge">
            <i class="fa-solid fa-flag"></i>
            <span id="autoPageBadgeText">Page 1 / 1</span>
          </div>
          <div class="action-btns">
            <button id="btnAutoStart"  class="act-btn"><i class="fa-solid fa-play"></i> Auto Start All Pages</button>
            <button id="btnAutoPause"  class="act-btn" disabled><i class="fa-solid fa-pause"></i> Pause</button>
            <button id="btnAutoResume" class="act-btn" disabled><i class="fa-solid fa-rotate-right"></i> Resume</button>
            <button id="btnAutoStop"   class="act-btn" disabled><i class="fa-solid fa-stop"></i> Stop</button>
          </div>
        </div>
      </div>

      <!-- Quick Templates -->
      <div class="compose-section">
        <div class="compose-hdr">
          <h3><i class="fa-solid fa-wand-magic-sparkles compose-hdr-icon"></i> Quick Templates</h3>
        </div>
        <div class="quick-tpls">
          <div class="tpl-item" data-tpl="Hi! Your order has been shipped and will arrive in 2-3 days. Thank you for shopping with us! 🚚">
            <div class="tpl-icon tpl-icon--order"><i class="fa-solid fa-box"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Order Update</div>
              <div class="tpl-preview">Your order has been shipped and will arrive…</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="tpl-item" data-tpl="🎉 Flash Sale! Get 30% OFF everything today only. Limited time offer — shop now before it ends!">
            <div class="tpl-icon tpl-icon--sale"><i class="fa-solid fa-tags"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Flash Sale</div>
              <div class="tpl-preview">🎉 Get 30% OFF everything today only…</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="tpl-item" data-tpl="Reminder: Your appointment is confirmed for tomorrow. Please reply YES to confirm or NO to reschedule. 📅">
            <div class="tpl-icon tpl-icon--reminder"><i class="fa-solid fa-calendar-check"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Appointment Reminder</div>
              <div class="tpl-preview">Your appointment is confirmed for tomorrow…</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="tpl-item" data-tpl="Hi! Thank you for being a valued customer. We appreciate your support and look forward to serving you again! 🙏">
            <div class="tpl-icon tpl-icon--greet"><i class="fa-solid fa-heart"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Thank You</div>
              <div class="tpl-preview">Thank you for being a valued customer…</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
        </div>
      </div>

      <!-- Best Practices -->
      <div class="compose-section">
        <div class="compose-hdr">
          <h3><i class="fa-solid fa-lightbulb compose-hdr-icon"></i> Best Practices</h3>
        </div>
        <div class="tips-list">
          <div class="tip-item"><i class="fa-solid fa-circle-check"></i><span>Keep messages under 200 chars for better readability</span></div>
          <div class="tip-item"><i class="fa-solid fa-circle-check"></i><span>Use <strong>Normal</strong> delay to avoid Facebook rate limits</span></div>
          <div class="tip-item"><i class="fa-solid fa-circle-check"></i><span>Test with a small page before broadcasting to all</span></div>
          <div class="tip-item"><i class="fa-solid fa-circle-check"></i><span>Avoid promotional keywords to reduce policy risk</span></div>
          <div class="tip-item"><i class="fa-solid fa-circle-check"></i><span>Add an image to increase message engagement rates</span></div>
        </div>
      </div>

    </div><!-- /view-broadcast -->

    <!-- COL 4: PERFORMANCE PANEL -->
    <div class="stats-panel">

      <!-- Quick Stats Cards -->
      <div class="panel-section">
        <div class="panel-hdr">
          <span><i class="fa-solid fa-chart-simple"></i> Quick Stats</span>
        </div>
        <div class="quick-stats-grid">
          <div class="quick-stat-card qs-success">
            <i class="fa-solid fa-circle-check"></i>
            <div class="qs-info">
              <div class="qs-val" id="qsSuccessRate">0%</div>
              <div class="qs-lbl">Success Rate</div>
            </div>
          </div>
          <div class="quick-stat-card qs-speed">
            <i class="fa-solid fa-rocket"></i>
            <div class="qs-info">
              <div class="qs-val" id="qsSpeed">0/min</div>
              <div class="qs-lbl">Speed</div>
            </div>
          </div>
          <div class="quick-stat-card qs-pending">
            <i class="fa-solid fa-clock"></i>
            <div class="qs-info">
              <div class="qs-val" id="qsPending">0</div>
              <div class="qs-lbl">Pending</div>
            </div>
          </div>
          <div class="quick-stat-card qs-audience">
            <i class="fa-solid fa-users"></i>
            <div class="qs-info">
              <div class="qs-val" id="qsAudience">0</div>
              <div class="qs-lbl">Audience</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Stat Strip -->
      <div class="stat-strip">
        <div class="stat-box s-total">
          <div class="stat-row"><i class="fa-solid fa-users stat-icon"></i><span class="stat-lbl">Total</span></div>
          <span class="stat-val" id="statTotal">0</span>
        </div>
        <div class="stat-box s-sent">
          <div class="stat-row"><i class="fa-solid fa-circle-check stat-icon"></i><span class="stat-lbl">Sent</span></div>
          <span class="stat-val" id="statSent">0</span>
        </div>
        <div class="stat-box s-failed">
          <div class="stat-row"><i class="fa-solid fa-circle-xmark stat-icon"></i><span class="stat-lbl">Failed</span></div>
          <span class="stat-val" id="statFailed">0</span>
        </div>
      </div>

      <!-- Progress -->
      <div class="progress-bar-area">
        <div class="progress-row">
          <div class="progress-left"><i class="fa-solid fa-bolt"></i><span>Progress</span></div>
          <div class="progress-meta"><span id="etaText" class="eta-text"></span><span id="progressPct" class="progress-pct">0%</span></div>
        </div>
        <div class="progress-track"><div id="progressBar" class="progress-fill"></div></div>
      </div>

      <!-- Campaign Intelligence -->
      <div class="panel-section">
        <div class="panel-hdr">
          <span><i class="fa-solid fa-brain"></i> Campaign Intelligence</span>
        </div>
        <div class="intel-grid">
          <div class="intel-card ic-violet">
            <span class="intel-label"><i class="fa-solid fa-users"></i> Audience</span>
            <strong id="intelAudience" class="intel-val">Auto-load on start</strong>
          </div>
          <div class="intel-card ic-cyan">
            <span class="intel-label"><i class="fa-solid fa-gauge-high"></i> Delivery Pace</span>
            <strong id="intelPace" class="intel-val intel-neutral">Balanced</strong>
          </div>
          <div class="intel-card ic-green">
            <span class="intel-label"><i class="fa-solid fa-shield-halved"></i> Policy Risk</span>
            <strong id="intelRisk" class="intel-val intel-good">Low</strong>
          </div>
          <div class="intel-card ic-amber">
            <span class="intel-label"><i class="fa-solid fa-clock"></i> Est. Duration</span>
            <strong id="intelEta" class="intel-val">After load</strong>
          </div>
        </div>
        <div id="intelAdvice" class="intel-advice">
          <i class="fa-solid fa-lightbulb"></i>
          <span>Select a page and write your message to see live quality checks.</span>
        </div>
      </div>

      <!-- Delivery Operations -->
      <div class="panel-section">
        <div class="panel-hdr">
          <span><i class="fa-solid fa-shield-heart"></i> Delivery Operations</span>
          <span class="live-badge"><i class="fa-solid fa-circle fa-beat"></i> Live</span>
        </div>
        <div class="ops-grid">
          <div class="ops-row">
            <div class="ops-row-left"><span class="ops-dot ops-dot-green"></span><span class="ops-row-label">System</span></div>
            <span class="ops-badge ops-badge-green">Stable</span>
          </div>
          <div class="ops-row">
            <div class="ops-row-left"><span class="ops-dot ops-dot-violet"></span><span class="ops-row-label">Retry Engine</span></div>
            <span class="ops-badge ops-badge-violet">Active</span>
          </div>
          <div class="ops-row">
            <div class="ops-row-left"><span class="ops-dot ops-dot-cyan"></span><span class="ops-row-label">Network Guard</span></div>
            <span class="ops-badge ops-badge-cyan">Monitoring</span>
          </div>
          <div class="ops-row">
            <div class="ops-row-left"><span class="ops-dot ops-dot-amber"></span><span class="ops-row-label">Execution Mode</span></div>
            <span class="ops-badge ops-badge-amber">Queue</span>
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="panel-section">
        <div class="panel-hdr">
          <span><i class="fa-solid fa-bolt"></i> Quick Actions</span>
        </div>
        <div class="quick-actions-grid">
          <button class="qa-btn" id="qaRetryAll" disabled onclick="retryAllFailed()">
            <i class="fa-solid fa-rotate-right"></i> Retry All
          </button>
          <button class="qa-btn" id="qaExport" disabled onclick="exportResultsCSV()">
            <i class="fa-solid fa-file-arrow-down"></i> Export
          </button>
          <button class="qa-btn qa-btn--danger" id="qaClear" onclick="clearResults()">
            <i class="fa-solid fa-trash"></i> Clear
          </button>
        </div>
      </div>

    </div><!-- /stats-panel -->

    <!-- ANALYTICS VIEW -->
    <div id="view-analytics" class="broadcast-view" style="display:none">
      <div class="analytics-panel">
        <div class="analytics-header">
          <h3><i class="fa-solid fa-chart-line"></i> Analytics</h3>
          <div class="analytics-period">
            <button class="period-btn active">7 Days</button>
            <button class="period-btn">30 Days</button>
            <button class="period-btn">90 Days</button>
          </div>
        </div>
        <div class="analytics-kpi-grid">
          <div class="analytics-kpi akpi-blue">
            <div class="akpi-icon"><i class="fa-solid fa-users"></i></div>
            <div class="akpi-val" id="analyticsTotalSent">0</div>
            <div class="akpi-lbl">Total Sent</div>
          </div>
          <div class="analytics-kpi akpi-green">
            <div class="akpi-icon"><i class="fa-solid fa-circle-check"></i></div>
            <div class="akpi-val" id="analyticsDelivered">0</div>
            <div class="akpi-lbl">Delivered</div>
          </div>
          <div class="analytics-kpi akpi-red">
            <div class="akpi-icon"><i class="fa-solid fa-circle-xmark"></i></div>
            <div class="akpi-val" id="analyticsFailed">0</div>
            <div class="akpi-lbl">Failed</div>
          </div>
          <div class="analytics-kpi akpi-purple">
            <div class="akpi-icon"><i class="fa-solid fa-percent"></i></div>
            <div class="akpi-val" id="analyticsRate">0%</div>
            <div class="akpi-lbl">Success Rate</div>
          </div>
        </div>
        <div class="analytics-chart-wrap">
          <div class="analytics-chart-hdr">
            <span><i class="fa-solid fa-chart-area"></i> Delivery Trend</span>
          </div>
          <div class="analytics-chart-box" id="analyticsChartBox">
            <div class="analytics-empty"><i class="fa-solid fa-chart-line"></i><p>No data yet. Start a broadcast to see analytics.</p></div>
          </div>
        </div>
        <div class="analytics-history">
          <div class="analytics-history-hdr"><i class="fa-solid fa-clock-rotate-left"></i> Recent Broadcasts</div>
          <div id="analyticsHistoryList">
            <div class="analytics-empty"><p>No broadcast history yet.</p></div>
          </div>
        </div>
      </div>
    </div>

    <!-- TEMPLATES VIEW -->
    <div id="view-templates" class="broadcast-view" style="display:none">
      <div class="templates-panel">
        <div class="templates-header">
          <h3><i class="fa-solid fa-bookmark"></i> Message Templates</h3>
          <button class="btn-primary-sm" onclick="showCreateTemplate()"><i class="fa-solid fa-plus"></i> Create</button>
        </div>
        <div class="templates-grid" id="templatesGrid">
          <div class="template-card" onclick="useTemplate('Hi! Your order #{{order_id}} has been shipped. Track at: {{tracking_url}}')">
            <div class="tpl-icon tpl-icon--order"><i class="fa-solid fa-box"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Order Update</div>
              <div class="tpl-preview">Hi! Your order #{{order_id}} has been shipped...</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="template-card" onclick="useTemplate('Flash Sale! Get 30% OFF everything today only. Use code SAVE30')">
            <div class="tpl-icon tpl-icon--sale"><i class="fa-solid fa-tags"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Flash Sale</div>
              <div class="tpl-preview">Flash Sale! Get 30% OFF everything today only...</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="template-card" onclick="useTemplate('Reminder: Your appointment is tomorrow at {{time}}. Reply YES to confirm.')">
            <div class="tpl-icon tpl-icon--reminder"><i class="fa-solid fa-calendar-check"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Appointment Reminder</div>
              <div class="tpl-preview">Reminder: Your appointment is tomorrow...</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
          <div class="template-card" onclick="useTemplate('Thank you for shopping with us! Use code WELCOME10 for 10% off your next order.')">
            <div class="tpl-icon tpl-icon--greet"><i class="fa-solid fa-heart"></i></div>
            <div class="tpl-body">
              <div class="tpl-name">Thank You</div>
              <div class="tpl-preview">Thank you for shopping with us! Use code WELCOME10...</div>
            </div>
            <i class="fa-solid fa-chevron-right tpl-arrow"></i>
          </div>
        </div>
      </div>
    </div>

    <!-- SETTINGS VIEW -->
    <div id="view-settings" class="broadcast-view" style="display:none">
      <div class="settings-panel">
        <div class="settings-header">
          <h3><i class="fa-solid fa-gear"></i> Settings</h3>
        </div>
        <div class="settings-section">
          <div class="settings-card">
            <h4><i class="fa-solid fa-bullhorn"></i> Default Delay</h4>
            <p>Set the default delay between messages for new broadcasts.</p>
            <div class="settings-delay-opts">
              <button class="delay-opt" data-delay="3000"><i class="fa-solid fa-shield-halved"></i> Slow</button>
              <button class="delay-opt active" data-delay="1200"><i class="fa-solid fa-gauge"></i> Normal</button>
              <button class="delay-opt" data-delay="500"><i class="fa-solid fa-bolt"></i> Fast</button>
            </div>
          </div>
          <div class="settings-card">
            <h4><i class="fa-solid fa-bell"></i> Notifications</h4>
            <p>Get notified when your broadcast completes or has failures.</p>
            <label class="settings-toggle"><input type="checkbox" id="notifBroadcast" checked><span>Broadcast Complete</span></label>
            <label class="settings-toggle"><input type="checkbox" id="notifFailed" checked><span>Failed Messages Alert</span></label>
          </div>
          <div class="settings-card">
            <h4><i class="fa-solid fa-shield-halved"></i> Privacy & Security</h4>
            <p>Manage your account security settings.</p>
            <button class="settings-btn" onclick="showChangePassword()"><i class="fa-solid fa-key"></i> Change Password</button>
            <button class="settings-btn settings-btn--danger" onclick="triggerLogout()"><i class="fa-solid fa-right-from-bracket"></i> Logout All Devices</button>
          </div>
        </div>
      </div>
    </div>

    <!-- HELP VIEW -->
    <div id="view-help" class="broadcast-view" style="display:none">
      <div class="help-panel">
        <div class="help-header">
          <h3><i class="fa-solid fa-circle-question"></i> Help & Support</h3>
        </div>
        <div class="help-section">
          <div class="help-faq">
            <div class="faq-item">
              <div class="faq-q"><i class="fa-solid fa-question-circle"></i> How do I get my Facebook Page token?</div>
              <div class="faq-a">Click "Connect with Facebook", grant permissions, and your page tokens will be automatically fetched and stored.</div>
            </div>
            <div class="faq-item">
              <div class="faq-q"><i class="fa-solid fa-question-circle"></i> Why are some messages failing?</div>
              <div class="faq-a">Failed messages usually mean the user hasn't messaged your page or their settings block messages. Try retrying or skip these users.</div>
            </div>
            <div class="faq-item">
              <div class="faq-q"><i class="fa-solid fa-question-circle"></i> What delay should I use?</div>
              <div class="faq-a">We recommend "Normal" (1200ms) for most users. Use "Slow" if you experience failures. "Fast" increases speed but risks rate limits.</div>
            </div>
            <div class="faq-item">
              <div class="faq-q"><i class="fa-solid fa-question-circle"></i> How do I upgrade my plan?</div>
              <div class="faq-a">Click the "Upgrade" button in the top bar. Choose a plan that fits your messaging needs. All plans include unlimited token refresh.</div>
            </div>
          </div>
          <div class="help-contact">
            <h4><i class="fa-solid fa-envelope"></i> Contact Support</h4>
            <p>Need more help? Email us at <a href="mailto:support@castmepro.com">support@castmepro.com</a></p>
          </div>
        </div>
      </div>
    </div>

    <!-- Backdrop for recipients drawer on small screens -->
    <div class="recipients-backdrop" id="recipientsBackdrop"></div>

    <!-- COL 4: RECIPIENTS PANEL -->
    <div class="recipients-panel" id="recipientsPanel">
      <div class="recipients-wrap">
        <div class="rec-hdr">
          <div class="rec-hdr-l"><i class="fa-solid fa-users"></i> Recipients</div>
          <div class="rec-hdr-r">
            <button class="recipients-panel-close" id="recipientsPanelClose" title="Close" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px;line-height:1">&#x2715;</button>
            <select id="recipientFilter">
              <option value="all">All</option>
              <option value="status:pending">Pending</option>
              <option value="status:sent">Sent</option>
              <option value="status:failed">Failed</option>
            </select>
            <span id="recipientCount">0</span>
          </div>
        </div>
        <div class="rec-table">
          <div class="rec-thead">
            <div>PSID</div><div>Status</div><div>Error</div>
          </div>
          <div id="recipients">
            <div class="table-empty">
              <div class="table-empty-icon">💬</div>
              <div>No recipients yet.<br>Press Start Broadcast to load and send.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

  </div><!-- /app-body -->
</div><!-- /appPage -->


<!-- ═══ UPGRADE MODAL ═══ -->
<div class="overlay" id="upgradeModal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="upgradeModalTitle" aria-hidden="true">
  <div class="modal modal--upgrade">
    <div class="modal-head">
      <div class="modal-head-icon">🚀</div>
      <h2 id="upgradeModalTitle">Upgrade to Keep Broadcasting</h2>
      <p id="upgradeModalSub">Your free trial has ended. Choose a plan to continue.</p>
      <div class="modal-promo-strip">🔥 <strong>Sign-Up Special:</strong> 50% OFF all plans — This month only!</div>
    </div>
    <div class="modal-security">
      <i class="fas fa-lock"></i>
      <span>256-bit SSL · Secure Payment</span>
      <div style="display:flex;gap:4px;margin-left:6px;">
        <span class="card-tag">VISA</span>
        <span class="card-tag">MC</span>
        <span class="card-tag">AMEX</span>
      </div>
    </div>
    <div class="modal-plans">

      <!-- Starter -->
      <div class="modal-plan modal-plan--starter">
        <div class="modal-plan-label modal-plan-label--starter">Starter</div>
        <div class="modal-off-badge">50% OFF</div>
        <div class="modal-original-price"><s>$10</s>/mo</div>
        <div class="modal-plan-price">$5<sub>/mo</sub></div>
        <div class="modal-plan-period">30,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> All Facebook Pages</li>
          <li><i class="fas fa-check"></i> Real-time tracking</li>
          <li><i class="fas fa-check"></i> Dedicated support</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--starter" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('starter');else alert('Loading...')">
          <i class="fas fa-bolt"></i> Start Starter
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

      <!-- Bronze -->
      <div class="modal-plan modal-plan--bronze">
        <div class="modal-plan-label modal-plan-label--bronze">Bronze</div>
        <div class="modal-off-badge">50% OFF</div>
        <div class="modal-original-price"><s>$30</s>/mo</div>
        <div class="modal-plan-price">$15<sub>/mo</sub></div>
        <div class="modal-plan-period">300,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> All Facebook Pages</li>
          <li><i class="fas fa-check"></i> Label targeting</li>
          <li><i class="fas fa-check"></i> Dedicated support</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--bronze" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('basic');else alert('Loading...')">
          <i class="fas fa-bolt"></i> Start Bronze
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

      <!-- Silver -->
      <div class="modal-plan modal-plan--silver">
        <div class="modal-plan-label modal-plan-label--silver">Silver</div>
        <div class="modal-off-badge">50% OFF</div>
        <div class="modal-original-price"><s>$60</s>/mo</div>
        <div class="modal-plan-price">$30<sub>/mo</sub></div>
        <div class="modal-plan-period">650,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> Auto All Pages mode</li>
          <li><i class="fas fa-check"></i> Label targeting</li>
          <li><i class="fas fa-check"></i> Dedicated support</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--silver" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('pro');else alert('Loading...')">
          <i class="fas fa-rocket"></i> Start Silver
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

      <!-- Gold — POPULAR -->
      <div class="modal-plan modal-plan--gold modal-plan--featured">
        <div class="price-popular"><i class="fas fa-star" style="font-size:8px;margin-right:3px;"></i> MOST POPULAR</div>
        <div class="modal-plan-label modal-plan-label--gold">Gold</div>
        <div class="modal-off-badge modal-off-badge--gold">50% OFF</div>
        <div class="modal-original-price modal-original-price--gold"><s>$120</s>/mo</div>
        <div class="modal-plan-price modal-plan-price--gold">$60<sub>/mo</sub></div>
        <div class="modal-plan-period">1,750,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> All Silver features</li>
          <li><i class="fas fa-check"></i> Priority support</li>
          <li><i class="fas fa-check"></i> 60-day token refresh</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--gold" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('gold');else alert('Loading...')">
          <i class="fas fa-crown"></i> Start Gold
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

      <!-- Sapphire -->
      <div class="modal-plan modal-plan--sapphire">
        <div class="modal-plan-label modal-plan-label--sapphire">Sapphire</div>
        <div class="modal-off-badge">50% OFF</div>
        <div class="modal-original-price"><s>$200</s>/mo</div>
        <div class="modal-plan-price">$100<sub>/mo</sub></div>
        <div class="modal-plan-period">4,000,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> All Gold features</li>
          <li><i class="fas fa-check"></i> Priority support</li>
          <li><i class="fas fa-check"></i> Custom integrations</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--sapphire" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('sapphire');else alert('Loading...')">
          <i class="fas fa-gem"></i> Start Sapphire
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

      <!-- Platinum -->
      <div class="modal-plan modal-plan--platinum">
        <div class="modal-plan-label modal-plan-label--platinum">Platinum</div>
        <div class="modal-off-badge">50% OFF</div>
        <div class="modal-original-price"><s>$300</s>/mo</div>
        <div class="modal-plan-price">$150<sub>/mo</sub></div>
        <div class="modal-plan-period">7,000,000 messages/month</div>
        <ul class="modal-plan-feats">
          <li><i class="fas fa-check"></i> All Sapphire features</li>
          <li><i class="fas fa-check"></i> Dedicated account manager</li>
          <li><i class="fas fa-check"></i> White-label option</li>
          <li><i class="fas fa-check"></i> Cancel anytime</li>
        </ul>
        <button class="modal-cta modal-cta--platinum" onclick="if(typeof showPaymentPopup==='function')showPaymentPopup('pro_unlimited');else alert('Loading...')">
          <i class="fas fa-infinity"></i> Start Platinum
        </button>
        <div class="modal-plan-note">Monthly billing · cancel anytime</div>
      </div>

    </div>
    <div class="modal-dismiss">
      <button type="button" id="modalDismiss">Continue with limited access</button>
    </div>
  </div>
</div>


<!-- ═══ PRIVACY POLICY ═══ -->
<div class="overlay" id="privacyModal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="privacyTitle" aria-hidden="true">
  <div class="modal legal-modal">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h2 id="privacyTitle" class="legal-modal modal-title">Privacy Policy</h2>
      <button id="privacyClose" class="legal-close" aria-label="Close">&#x2715;</button>
    </div>
    <div class="legal-body">
      <p><strong>Data we collect:</strong> When you connect your Facebook account, we receive your Facebook User ID and name to manage your usage quota.</p>
      <p><strong>Facebook tokens:</strong> Page access tokens are exchanged for long-lived tokens (~60 days). Stored securely, used only to send messages on your behalf.</p>
      <p><strong>Payment data:</strong> We don't store card details. Payments are processed through Stripe. We store only your subscription status.</p>
      <p><strong>Usage data:</strong> We log message counts and login events to enforce plan quotas and prevent abuse.</p>
      <p><strong>Your rights:</strong> You can request deletion at any time by contacting us. Disconnecting Facebook immediately invalidates your tokens.</p>
      <p class="legal-date">Last updated: January 2025</p>
    </div>
  </div>
</div>

<!-- ═══ TERMS OF SERVICE ═══ -->
<div class="overlay" id="termsModal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="termsTitle" aria-hidden="true">
  <div class="modal legal-modal">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h2 id="termsTitle" class="legal-modal modal-title">Terms of Service</h2>
      <button id="termsClose" class="legal-close" aria-label="Close">&#x2715;</button>
    </div>
    <div class="legal-body">
      <p><strong>Acceptable use:</strong> FBCast Pro is for businesses to reach users who have previously messaged their Facebook Page. You must comply with Facebook's Messenger Platform policies.</p>
      <p><strong>Prohibited:</strong> Spam, unsolicited commercial messages, illegal content, or anything violating Facebook's Community Standards. Abuse results in immediate account suspension.</p>
      <p><strong>Subscriptions:</strong> Basic and Pro are billed monthly. Unlimited plan is billed yearly.</p>
      <p><strong>Disclaimer:</strong> We are not affiliated with Meta/Facebook. Use of the Graph API is subject to Meta's terms. We are not liable for consequences of policy violations on your account.</p>
      <p class="legal-date">Last updated: January 2025</p>
    </div>
  </div>
</div>


<script src="https://js.stripe.com/v3/" defer></script>
<script src="assets/js/index-page.js?v=<?php echo filemtime(__DIR__.'/assets/js/index-page.js'); ?>" defer></script>
<script src="assets/js/ui-components.js?v=<?php echo filemtime(__DIR__.'/assets/js/ui-components.js'); ?>" defer></script>
<script src="fb_api.js?v=<?php echo filemtime(__DIR__.'/fb_api.js'); ?>" defer></script>
<script src="web_ui.js?v=<?php echo filemtime(__DIR__.'/web_ui.js'); ?>" defer></script>
    <script src="assets/js/messenger.js?v=<?php echo time(); ?>"></script>

<script>
(function(){
  var panel    = document.getElementById('recipientsPanel');
  var toggleBtn= document.getElementById('recipientsToggleBtn');
  var closeBtn = document.getElementById('recipientsPanelClose');
  var backdrop = document.getElementById('recipientsBackdrop');
  if(!panel||!toggleBtn||!backdrop) return;

  function openPanel(){
    panel.classList.add('panel-open');
    backdrop.classList.add('active');
    document.body.style.overflow='hidden';
  }
  function closePanel(){
    panel.classList.remove('panel-open');
    backdrop.classList.remove('active');
    document.body.style.overflow='';
  }
  toggleBtn.addEventListener('click', openPanel);
  if(closeBtn) closeBtn.addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closePanel(); });
})();
</script>

<style>
.dvw{
  position:fixed;bottom:24px;left:24px;
  width:460px;
  border-radius:12px;overflow:visible;
  box-shadow:0 8px 40px rgba(0,0,0,.7);
  z-index:9000;
  animation:dvw-in .4s cubic-bezier(.16,1,.3,1) .8s both;
}
@keyframes dvw-in{
  from{opacity:0;transform:translateY(20px) scale(.95)}
  to  {opacity:1;transform:translateY(0)    scale(1)}
}
.dvw-iframe-wrap{
  position:relative;width:100%;padding-top:calc(56.25% + 40px);
  background:#000;
  border-radius:12px;overflow:hidden;
}
.dvw-play-btn{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:52px;height:52px;border-radius:50%;
  background:rgba(255,0,0,.85);border:none;
  display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:18px;cursor:pointer;
  pointer-events:none;z-index:5;
  transition:opacity .3s;
}
.dvw-loaded .dvw-play-btn{opacity:0;}
.dvw-iframe{
  position:absolute;top:0;left:0;
  width:calc(100% + 52px);height:100%;
  border:none;display:block;
}
.dvw-close-btn{
  position:absolute;top:-10px;right:-10px;z-index:10;
  width:26px;height:26px;border-radius:50%;
  background:#111;border:1px solid rgba(255,255,255,.15);
  color:rgba(255,255,255,.8);font-size:12px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:all .15s;line-height:1;
}
.dvw-close-btn:hover{background:#ef4444;border-color:#ef4444;color:#fff}
@media(max-width:400px){
  .dvw{width:calc(100vw - 32px);left:16px;bottom:16px}
}
</style>

<script>
(function(){
  var widget = document.getElementById('demoVideoWidget');
  var iframe = document.getElementById('dvwIframe');
  var loaded = false;

  // Load YouTube only when widget enters viewport
  function loadVideo(){
    if(loaded) return;
    iframe.src = iframe.dataset.src;
    loaded = true;
    setTimeout(function(){ widget.classList.add('dvw-loaded'); }, 1000);
  }

  if('IntersectionObserver' in window){
    new IntersectionObserver(function(entries, obs){
      if(entries[0].isIntersecting){ loadVideo(); obs.disconnect(); }
    },{threshold:0.1}).observe(widget);
  } else {
    setTimeout(loadVideo, 2000);
  }

  document.getElementById('dvwClose').addEventListener('click',function(){
    iframe.src='';
    loaded=false;
    widget.style.display='none';
  });
})();
</script>
</body>
</html>
