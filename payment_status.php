<?php
define('FBCAST_PAGE_CONTEXT', true);
$js_stripe_pk = '';
$js_csrf_token = '';
if (file_exists(__DIR__ . '/config/load-env.php')) {
    try {
        require_once __DIR__ . '/config/load-env.php';
        $js_stripe_pk  = htmlspecialchars(defined('STRIPE_PUBLISHABLE_KEY') ? STRIPE_PUBLISHABLE_KEY : '', ENT_QUOTES, 'UTF-8');
        $js_csrf_token = htmlspecialchars(getCsrfToken(), ENT_QUOTES, 'UTF-8');
    } catch (Throwable $e) {}
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Status — FBCast Pro</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; justify-content: center; align-items: center; min-height: 100vh;
           background: #070b14; color: #e4e6eb; font-family: Inter, sans-serif; }
    #message { background: #0d1220; padding: 48px 40px; border-radius: 20px;
               border: 1px solid rgba(255,255,255,.08); text-align: center; max-width: 440px; width: 90%; }
    .icon { font-size: 40px; margin-bottom: 18px; }
    .icon-success { color: #22c55e; }
    .icon-fail    { color: #ef4444; }
    .icon-spin    { color: #1877f2; }
    h1 { font-size: 22px; margin-bottom: 10px; }
    p  { color: #6b7280; font-size: 14px; line-height: 1.6; }
    a  { color: #1877f2; text-decoration: none; }
  </style>
</head>
<body>
  <div id="message">
    <div class="icon icon-spin"><i class="fa-solid fa-spinner fa-spin"></i></div>
    <h1>Processing your payment...</h1>
    <p>Please wait while we confirm your payment.</p>
  </div>

  <script src="https://js.stripe.com/v3/"></script>
  <script>
    const STRIPE_PK   = '<?php echo $js_stripe_pk; ?>';
    const CSRF_TOKEN  = '<?php echo $js_csrf_token; ?>';
    const stripe = Stripe(STRIPE_PK);
    const box = document.getElementById('message');

    const params = new URLSearchParams(window.location.search);
    const piSecret = params.get('payment_intent_client_secret');
    const siSecret = params.get('setup_intent_client_secret');
    const clientSecret = piSecret || siSecret;

    if (!clientSecret) {
      box.innerHTML = '<div class="icon icon-fail"><i class="fa-solid fa-times-circle"></i></div>'
        + '<h1>Invalid page</h1><p><a href="index.php">Go back to app</a></p>';
    } else {
      const isSetup = !!siSecret;
      const verifyPromise = isSetup 
        ? stripe.retrieveSetupIntent(clientSecret)
        : stripe.retrievePaymentIntent(clientSecret);

      verifyPromise.then(async (result) => {
        const intent = isSetup ? result.setupIntent : result.paymentIntent;
        if (intent?.status === 'succeeded') {
            // Trigger server-side activation
            try {
                const response = await fetch('activate_subscription.php', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': CSRF_TOKEN
                    },
                    body: JSON.stringify({
                        intent_id: intent.id,
                        is_setup: isSetup
                    })
                });
                const data = await response.json();
                if (data.success) {
                    box.innerHTML = '<div class="icon icon-success"><i class="fa-solid fa-check-circle"></i></div>'
                        + '<h1>Payment Successful!</h1>'
                        + '<p>Your ' + (data.plan || 'Pro') + ' plan is now active.<br>Redirecting you back to the app...</p>';
                    setTimeout(() => { window.location.href = 'index.php?payment=success'; }, 2500);
                } else {
                    throw new Error(data.error || 'Activation failed');
                }
            } catch (err) {
                box.innerHTML = '<div class="icon icon-fail"><i class="fa-solid fa-exclamation-circle"></i></div>'
                    + '<h1>Activation Error</h1>'
                    + '<p>' + err.message + '. Please contact support.<br><a href="index.php">Return to app</a></p>';
            }
            return;
        }

        switch (intent?.status) {
          case 'processing':
            box.innerHTML = '<h1>Payment Processing</h1>'
              + '<p>We\'ll update you when payment is received.<br><a href="index.php">Return to app</a></p>';
            break;
          case 'requires_payment_method':
            box.innerHTML = '<div class="icon icon-fail"><i class="fa-solid fa-times-circle"></i></div>'
              + '<h1>Payment Failed</h1>'
              + '<p>Please return to the app and try another payment method.<br><a href="index.php">Try again</a></p>';
            break;
          default:
            box.innerHTML = '<div class="icon icon-fail"><i class="fa-solid fa-exclamation-circle"></i></div>'
              + '<h1>Something went wrong</h1>'
              + '<p>Please return to the app and try again.<br><a href="index.php">Go back</a></p>';
        }
      }).catch(() => {
        box.innerHTML = '<div class="icon icon-fail"><i class="fa-solid fa-exclamation-circle"></i></div>'
          + '<h1>Could not verify payment</h1>'
          + '<p><a href="index.php">Return to app</a></p>';
      });
    }
  </script>
</body>
</html>
