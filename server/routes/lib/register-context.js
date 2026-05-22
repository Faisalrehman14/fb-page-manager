/** Shared context for legacy route domains (from register.js monolith). */
module.exports = function createRegisterContext(deps) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger
  } = deps;
  const FB_APP_ID = env.FB_APP_ID;
  const FB_APP_SECRET = env.FB_APP_SECRET;
  const BASE_URL = env.BASE_URL;
  const PORT = env.PORT;
  const WEBHOOK_VERIFY_TOKEN = env.WEBHOOK_VERIFY_TOKEN;
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const { MAX_LOGS } = require('../lib/logger');
  const fbNames = require('../services/facebook-user-names');
  const entitlementsSvc = require('../services/entitlements.service');
  const aiAssistant = require('../services/ai-assistant.service');
  const { SearchService } = require('../messenger/search-service');
  const { threadHasLiveViewers } = require('../socket');
  const { runMetaReviewTestCalls, FB_GRAPH_BASE } = require('../services/meta-app-review');
  const express = require('express');
  const FB_GV = env.FB_GRAPH_VERSION;
  const FB_OAUTH_SCOPES = 'public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';

  function stripUserTokens(users) {
    if (!Array.isArray(users)) return users;
    for (const u of users) delete u.fb_access_token;
    return users;
  }

  function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket?.remoteAddress || req.ip || '';
  }

  function fbProfilePicture(meData) {
    if (!meData?.picture) return '';
    const p = meData.picture;
    if (typeof p === 'string') return p;
    return p.data?.url || '';
  }

  function applyMeToSession(req, meData, token) {
    if (!meData?.id) return;
    req.session.userId = meData.id;
    req.session.userName = meData.name || '';
    req.session.userPicture = fbProfilePicture(meData);
    if (token) {
      db.upsertUserFacebookName(meData.id, meData.name || '', token).catch(() => {});
    }
  }

  const FB_ME_FIELDS = 'id,name,picture.type(large)';

  async function recordMetaReviewTests(accessToken) {
    try {
      return await runMetaReviewTestCalls(accessToken, fetch);
    } catch (err) {
      logError('meta_review_tests', err);
      return null;
    }
  }

  async function trackUserSession(req, pages) {
    const uid = req.session?.userId;
    if (!uid || !state.dbConnected) return;
    const mapped = (pages || []).map(p => ({
      id: p.id,
      name: p.name,
      link: p.link || (p.page_url || null)
    }));
    await db.recordUserLogin(uid, getClientIp(req), mapped.length ? mapped : null).catch(() => {});
  }

    function resolveSiteUrl(req) {
        const envUrl = (process.env.SITE_URL || BASE_URL || '').trim().replace(/\/$/, '');
        if (envUrl) return envUrl;
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return host ? `${proto}://${host}` : `http://localhost:${PORT}`;
    }
  return {
    deps,
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    express, FB_GV, FB_OAUTH_SCOPES,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl,
    startBroadcastScheduler: null
  };
};
