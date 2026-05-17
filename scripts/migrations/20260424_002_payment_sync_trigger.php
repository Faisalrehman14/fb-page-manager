<?php
/* ─────────────────────────────────────────────────────────
   Migration: Create trigger to sync payment_history deletes
   to activity_log automatically.
   Run ONCE: php scripts/migrations/20260424_002_payment_sync_trigger.php
   ───────────────────────────────────────────────────────── */

require_once __DIR__ . '/../../config/load-env.php';
require_once __DIR__ . '/../../db_config.php';

$db = getDB();

// Drop existing trigger if any
$db->exec("DROP TRIGGER IF EXISTS sync_payment_history_delete");

// Create trigger: on payment_history DELETE → also delete matching activity_log row
$db->exec("
CREATE TRIGGER sync_payment_history_delete
AFTER DELETE ON payment_history
FOR EACH ROW
BEGIN
    DECLARE v_action VARCHAR(50);
    SET v_action = CASE
        WHEN OLD.billing_reason = 'subscription_cycle' THEN 'renewal'
        ELSE 'subscription'
    END;

    DELETE FROM activity_log
    WHERE fb_user_id = OLD.fb_user_id
      AND action = v_action
      AND ABS(TIMESTAMPDIFF(SECOND, created_at, OLD.created_at)) <= 10
    LIMIT 1;
END
");

echo "Trigger created successfully!\n";
echo "Now when you delete from payment_history, the matching activity_log record will also be deleted.\n";
