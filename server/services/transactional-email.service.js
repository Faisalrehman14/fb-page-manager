const db = require('../db');
const emailService = require('./email.service');
const { FREE_TRIAL_DAYS, FREE_TIER, getPlan } = require('../config/plans');

const TRIAL_REMINDER_DAYS_BEFORE = Number(process.env.TRIAL_REMINDER_DAYS_BEFORE || 2);

function fireAndForget(promise, label, logError) {
    Promise.resolve(promise).catch((err) => {
        logError?.(`email_${label}`, err);
    });
}

async function resolveEmailForFbUser(fbUserId) {
    if (!db.isConnected() || !fbUserId) return null;
    const pool = db.getPool?.() || db.pool;
    if (!pool) return null;
    const [rows] = await pool.query(
        `SELECT a.email AS app_email, a.first_name, u.email AS user_email
         FROM users u
         LEFT JOIN app_accounts a ON a.linked_fb_user_id = u.fb_user_id
         WHERE u.fb_user_id = ? LIMIT 1`,
        [fbUserId]
    );
    const row = rows[0];
    if (!row) return null;
    const email = (row.app_email || row.user_email || '').trim().toLowerCase();
    if (!email) return null;
    return { email, firstName: row.first_name || '' };
}

async function trySendWelcome({ appAccountId, email, firstName }, logError) {
    if (!emailService.isEmailConfigured() || !appAccountId || !email) return;
    const claimed = await db.tryClaimWelcomeEmail(appAccountId);
    if (!claimed) return;
    try {
        await emailService.sendWelcomeEmail(email, firstName);
    } catch (err) {
        logError?.('email_welcome', err);
    }
}

function queueWelcomeForAppAccount(account, logError) {
    if (!account?.id || !account.email) return;
    fireAndForget(
        trySendWelcome({
            appAccountId: account.id,
            email: account.email,
            firstName: account.first_name || account.firstName || ''
        }, logError),
        'welcome',
        logError
    );
}

async function trySendFreeTrialStarted(fbUserId, logError) {
    if (!emailService.isEmailConfigured() || !fbUserId) return;
    const claimed = await db.tryClaimFreeTrialEmail(fbUserId);
    if (!claimed) return;

    const recipient = await resolveEmailForFbUser(fbUserId);
    if (!recipient) return;

    const row = await db.getUserQuotaRow(fbUserId);
    const trialEnd = row?.free_trial_expires_at || null;

    try {
        await emailService.sendFreeTrialStartedEmail(recipient.email, {
            firstName: recipient.firstName,
            trialDays: FREE_TRIAL_DAYS,
            messageLimit: FREE_TIER.limit,
            expiresAt: trialEnd
        });
    } catch (err) {
        logError?.('email_free_trial', err);
    }
}

function queueFreeTrialForNewFbUser(fbUserId, logError) {
    if (!fbUserId) return;
    fireAndForget(trySendFreeTrialStarted(fbUserId, logError), 'free_trial', logError);
}

async function trySendSubscriptionActivated(fbUserId, planKey, logError) {
    if (!emailService.isEmailConfigured() || !fbUserId || !planKey) return;
    const plan = getPlan(planKey);
    if (!plan || plan.dbPlan === 'free') return;

    const recipient = await resolveEmailForFbUser(fbUserId);
    if (!recipient) return;

    const row = await db.getUserQuotaRow(fbUserId);
    try {
        await emailService.sendSubscriptionActivatedEmail(recipient.email, {
            firstName: recipient.firstName,
            planName: plan.name,
            messageLimit: plan.limit,
            expiresAt: row?.subscription_expires || null
        });
    } catch (err) {
        logError?.('email_subscription', err);
    }
}

function queueSubscriptionActivated(fbUserId, planKey, billingReason, logError) {
    const activationReasons = new Set([
        'subscription_create',
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'customer.subscription.created',
        'admin_activation'
    ]);
    if (!activationReasons.has(String(billingReason || ''))) return;
    fireAndForget(
        trySendSubscriptionActivated(fbUserId, planKey, logError),
        'subscription',
        logError
    );
}

async function processTrialEndingReminders(logError) {
    if (!emailService.isEmailConfigured() || !db.isConnected()) return 0;
    const users = await db.getUsersNeedingTrialReminder(TRIAL_REMINDER_DAYS_BEFORE);
    let sent = 0;
    for (const u of users) {
        const email = (u.app_email || u.user_email || '').trim();
        if (!email) continue;
        const claimed = await db.tryClaimTrialReminderEmail(u.fb_user_id);
        if (!claimed) continue;
        try {
            const trialEnd = u.free_trial_expires_at ? new Date(u.free_trial_expires_at) : null;
            let daysLeft = TRIAL_REMINDER_DAYS_BEFORE;
            if (trialEnd) {
                daysLeft = Math.max(1, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000));
            }
            await emailService.sendTrialEndingReminderEmail(email, {
                firstName: u.first_name || '',
                trialDaysLeft: daysLeft,
                expiresAt: trialEnd
            });
            sent += 1;
        } catch (err) {
            logError?.('email_trial_reminder', err, { fbUserId: u.fb_user_id });
        }
    }
    return sent;
}

function startTrialReminderScheduler(logError) {
    const INTERVAL_MS = 6 * 60 * 60 * 1000;
    const tick = () => {
        processTrialEndingReminders(logError).catch((err) => {
            logError?.('trial_reminder_scheduler', err);
        });
    };
    setTimeout(tick, 60 * 1000);
    setInterval(tick, INTERVAL_MS);
}

module.exports = {
    queueWelcomeForAppAccount,
    queueFreeTrialForNewFbUser,
    queueSubscriptionActivated,
    startTrialReminderScheduler,
    processTrialEndingReminders,
    trySendWelcome,
    resolveEmailForFbUser
};
