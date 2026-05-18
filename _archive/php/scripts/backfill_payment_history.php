<?php
/* ─────────────────────────────────────────────────────────
   backfill_payment_history.php
   Run ONCE via CLI or browser to copy existing payment
   records from activity_log into payment_history.

   Usage (CLI):  php scripts/backfill_payment_history.php
   Usage (web):  visit /scripts/backfill_payment_history.php
   ───────────────────────────────────────────────────────── */

require_once __DIR__ . '/../config/load-env.php';
require_once __DIR__ . '/../db_config.php';

$db = getDB();

// Get all subscription/renewal/payment events from activity_log
// that do NOT already exist in payment_history
$rows = $db->query("
    SELECT al.fb_user_id, al.action, al.detail, al.created_at,
           u.plan, u.stripe_subscription_id
    FROM activity_log al
    LEFT JOIN users u ON u.fb_user_id = al.fb_user_id
    WHERE al.action IN ('subscription', 'renewal', 'payment')
    ORDER BY al.created_at ASC
")->fetchAll(PDO::FETCH_ASSOC);

$inserted = 0;
$skipped  = 0;

foreach ($rows as $row) {
    $fbUserId = $row['fb_user_id'];
    $plan     = $row['plan'] ?? 'basic';
    $subId    = $row['stripe_subscription_id'] ?? '';
    $created  = $row['created_at'];
    $action   = $row['action'];

    // Try to extract amount from detail string, fallback to plan default
    $amountCents = 0;
    if ($plan === 'basic') $amountCents = 2000; // $20
    if ($plan === 'pro')   $amountCents = 5000; // $50

    $billingReason = ($action === 'renewal') ? 'subscription_cycle' : 'subscription_create';

    // Use sub ID as fake invoice ID to allow deduplication
    $fakeInvoiceId = 'backfill_' . $action . '_' . $fbUserId . '_' . strtotime($created);

    // Check if already exists
    $exists = $db->prepare("SELECT COUNT(*) FROM payment_history WHERE stripe_invoice_id = ?");
    $exists->execute([$fakeInvoiceId]);
    if ((int)$exists->fetchColumn() > 0) {
        $skipped++;
        continue;
    }

    $db->prepare("
        INSERT INTO payment_history
        (fb_user_id, stripe_invoice_id, plan, amount_cents, status, billing_reason, created_at)
        VALUES (?, ?, ?, ?, 'succeeded', ?, ?)
    ")->execute([$fbUserId, $fakeInvoiceId, $plan, $amountCents, $billingReason, $created]);

    $inserted++;
}

echo "Done!\n";
echo "Inserted: $inserted\n";
echo "Skipped (already exist): $skipped\n";
echo "Total activity_log records processed: " . count($rows) . "\n";
