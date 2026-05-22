/** webhook routes */
module.exports = function mountWebhook(app, ctx) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    express, FB_GV, FB_OAUTH_SCOPES,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl
  } = ctx;

// ── Facebook Webhook (must be before express.static so fb_webhook.php isn't served as raw PHP) ──
app.get(['/webhook', '/fb_webhook.php'], (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) return res.send(challenge);
    res.sendStatus(403);
});

app.post(['/webhook', '/fb_webhook.php'], async (req, res) => {
    if (FB_APP_SECRET) {
        const sig      = req.headers['x-hub-signature-256'] || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', FB_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
        if (sig && sig !== expected) { logError('webhook_sig', new Error('Invalid signature')); return res.sendStatus(403); }
    }

    res.sendStatus(200);

    const { object, entry } = req.body;
    if (object !== 'page' || !entry) return;

    state.webhookLogs.unshift({ time: new Date().toISOString(), entries: entry.length });
    if (state.webhookLogs.length > MAX_LOGS) state.webhookLogs.pop();

    for (const pageEntry of entry) {
        const pageId = pageEntry?.id;
        if (!pageId) continue;

        for (const event of (pageEntry.messaging || [])) {
            try {
                // Delivery receipts — watermark covers all msgs before that timestamp
                if (event.delivery) {
                    const watermark     = event.delivery.watermark;
                    const participantId = event.sender?.id;
                    if (watermark && participantId) {
                        io.to(`page_${pageId}`).emit('msg_status', {
                            type: 'delivered', pageId,
                            participantId: String(participantId),
                            watermark
                        });
                    }
                    continue;
                }
                // Read receipts
                if (event.read) {
                    const watermark     = event.read.watermark;
                    const participantId = event.sender?.id;
                    if (watermark && participantId) {
                        io.to(`page_${pageId}`).emit('msg_status', {
                            type: 'read', pageId,
                            participantId: String(participantId),
                            watermark
                        });
                    }
                    continue;
                }
                // Customer typing indicator (Facebook sends this when customer types)
                if (event.sender_action === 'typing_on' || event.typing_on) {
                    const participantId = event.sender?.id;
                    if (participantId) {
                        io.to(`page_${pageId}`).emit('customer_typing', {
                            pageId, participantId: String(participantId), typing: true
                        });
                    }
                    continue;
                }
                if (event.sender_action === 'typing_off' || event.typing_off) {
                    const participantId = event.sender?.id;
                    if (participantId) {
                        io.to(`page_${pageId}`).emit('customer_typing', {
                            pageId, participantId: String(participantId), typing: false
                        });
                    }
                    continue;
                }
                // Customer 👍 reaction on a message (Meta Business Suite / Messenger app)
                if (event.reaction) {
                    const { isThumbsUpReaction, normalizeIncomingSave, snippetForMessage, toClientMessage } = require('../messenger/message-content');
                    if (!isThumbsUpReaction(event.reaction)) continue;

                    const participantId = event.sender?.id;
                    if (!participantId) continue;

                    const ts = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
                    const rxMid = `rxn_${event.reaction.mid || '0'}_${participantId}_${event.timestamp || Date.now()}`;
                    const normalized = normalizeIncomingSave({
                        text: '👍',
                        attachments: [{ t: 'like', u: null }]
                    });

                    const threadId = await db.ensureConversation(pageId, participantId);
                    if (!threadId) continue;

                    const saved = await db.saveMessage({
                        id: rxMid, threadId, pageId, senderId: participantId,
                        senderType: 'user',
                        text: normalized.text,
                        isFromPage: false,
                        createdTime: ts,
                        attachments: normalized.attachments
                    });

                    const clientMsg = toClientMessage({
                        message_id: rxMid,
                        text: normalized.text,
                        attachments: normalized.attachments,
                        isFromPage: false,
                        createdTime: ts
                    });
                    const snippet = snippetForMessage(clientMsg);

                    if (saved?.inserted === true) {
                        const viewedLive = threadHasLiveViewers(io, threadId);
                        if (viewedLive) {
                            await db.updateConversationFromMessage({ threadId, text: snippet, createdTime: ts, lastFromMe: false }).catch(() => {});
                            await db.markAsRead(threadId).catch(() => {});
                        } else {
                            await db.onIncomingMessage(threadId, pageId, participantId, snippet);
                        }
                        io.to(`page_${pageId}`).emit('new_message', {
                            id: rxMid, threadId, pageId, participantId,
                            text: clientMsg.message,
                            isFromPage: false,
                            createdTime: ts,
                            attachment_url: null,
                            attachment_type: 'like',
                            is_like: true
                        });
                        io.to(`page_${pageId}`).emit('conversation_updated', {
                            id: threadId, pageId, participantId, snippet,
                            updatedTime: new Date(), isRead: viewedLive,
                            unreadCount: viewedLive ? 0 : 1, lastMessageFromPage: false
                        });
                    }
                    continue;
                }
                // No message body (postbacks etc.) — skip
                if (!event.message) continue;

                const isEcho      = !!event.message.is_echo;
                const senderId    = event.sender?.id;
                const recipientId = event.recipient?.id;
                const participantId = isEcho ? recipientId : senderId;
                if (!participantId) {
                    logError('webhook_no_participant', new Error('Missing sender/recipient'), { pageId, eventKeys: Object.keys(event) });
                    continue;
                }

                const mid  = event.message.mid || null;
                const text = (event.message.text || '').trim();
                const ts   = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();

                const { parseWebhookAttachments, normalizeIncomingSave, snippetForMessage, toClientMessage } = require('../messenger/message-content');
                const rawAttachments = parseWebhookAttachments(event.message.attachments || []);
                const normalized = normalizeIncomingSave({ text, attachments: rawAttachments });
                const saveText = normalized.text;
                const saveAttachments = normalized.attachments;

                const threadId = await db.ensureConversation(pageId, participantId);
                if (!threadId) {
                    logError('webhook_no_thread', new Error('ensureConversation returned null'), { pageId, participantId });
                    continue;
                }

                const saved = await db.saveMessage({
                    id: mid, threadId, pageId, senderId: senderId,
                    senderType: isEcho ? 'page' : 'user',
                    text: saveText, isFromPage: isEcho, createdTime: ts,
                    attachments: saveAttachments
                });

                const clientMsg = toClientMessage({
                    message_id: mid,
                    text: saveText,
                    attachments: saveAttachments,
                    isFromPage: isEcho,
                    createdTime: ts
                });
                const snippet = snippetForMessage(clientMsg);

                const isNewMessage = saved?.inserted === true;
                if (isEcho) {
                    if (isNewMessage) {
                        await db.updateConversationFromMessage({ threadId, text: snippet, createdTime: ts, lastFromMe: true }).catch(() => {});
                        await db.markAsRead(threadId).catch(() => {});
                        setImmediate(async () => {
                            try {
                                const token = await db.getPageToken(pageId);
                                if (token && participantId) {
                                    const { FacebookClient } = require('../messenger/facebook-client');
                                    await new FacebookClient(fetch).markSeenWithRetry(token, participantId, pageId);
                                }
                            } catch (err) {
                                logError('echo_mark_seen_meta', err, { pageId, threadId, participantId });
                            }
                        });
                    }
                } else if (isNewMessage) {
                    const viewedLive = threadHasLiveViewers(io, threadId);
                    if (viewedLive) {
                        await db.updateConversationFromMessage({ threadId, text: snippet, createdTime: ts, lastFromMe: false }).catch(() => {});
                        await db.markAsRead(threadId).catch(() => {});
                    } else {
                        await db.onIncomingMessage(threadId, pageId, participantId, snippet);
                    }
                }

                if (isNewMessage) {
                    const viewedLive = !isEcho && threadHasLiveViewers(io, threadId);
                    io.to(`page_${pageId}`).emit('new_message', {
                        id: mid, threadId, pageId, participantId,
                        text: clientMsg.message,
                        isFromPage: isEcho,
                        createdTime: ts,
                        attachment_url: clientMsg.attachment_url,
                        attachment_type: clientMsg.attachment_type,
                        is_like: clientMsg.is_like
                    });
                    io.to(`page_${pageId}`).emit('conversation_updated', {
                        id: threadId, pageId, participantId, snippet,
                        updatedTime: new Date(), isRead: isEcho || viewedLive,
                        unreadCount: (isEcho || viewedLive) ? 0 : 1, lastMessageFromPage: isEcho
                    });
                }
            } catch (err) {
                logError('webhook_event', err, { pageId, eventSender: event?.sender?.id });
            }
        }
    }
});


};
