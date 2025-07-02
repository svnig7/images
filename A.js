export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Only POST allowed');

    const update = await request.json();
    const token = env.BOT_TOKEN;
    const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

    // === 1. Handle Channel Post ===
    if (update.channel_post?.caption || update.channel_post?.text) {
      const post = update.channel_post;
      const configKey = `channel:${post.chat.id}`;
      const configRaw = await env.USER_CONFIG.get(configKey);
      const config = configRaw ? JSON.parse(configRaw) : {};

      const replacementsRaw = await env.USER_CONFIG.get(`replacements:${post.chat.id}`);
      const replacements = replacementsRaw ? JSON.parse(replacementsRaw) : [];

      const newCaption = formatCaption(post.caption || post.text, config, replacements);
      const userIds = await getAllUserIdsLinkedTo(post.chat.id, env);

      for (const userId of userIds) {
        const forwardId = await env.USER_CONFIG.get(`forward:${userId}`);
        if (!forwardId) continue;

        if (post.video) {
          const fileId = post.video.file_id;
          await fetch(api("sendVideo"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: forwardId,
              video: fileId,
              caption: newCaption,
              parse_mode: 'HTML'
            })
          });
        } else if (post.document) {
          const fileId = post.document.file_id;
          await fetch(api("sendDocument"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: forwardId,
              document: fileId,
              caption: newCaption,
              parse_mode: 'HTML'
            })
          });
        } else if (post.text) {
          await fetch(api("sendMessage"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: forwardId,
              text: newCaption,
              parse_mode: 'HTML'
            })
          });
        }
      }
    }

    // === 2. Handle Private Commands ===
    if (update.message?.chat?.type === 'private') {
      const msg = update.message;
      const text = msg.text || '';
      const userId = msg.chat.id.toString();

      const isSubscribed = await checkSubscription(api, userId, env);
      if (!isSubscribed) {
        const channelLink = await getOrCreateInviteLink(api, env, "channel", env.FORCE_CHANNEL);
        const groupLink = await getOrCreateInviteLink(api, env, "group", env.FORCE_GROUP);
        await sendJoinButtons(api, userId, channelLink, groupLink);
        return new Response('OK');
      }

      if (text.startsWith("/start")) {
        await sendText(api, userId,
`👋 Welcome! Here are your commands:

/link <channel_id> – Set source channel
/forward <channel_id> – Set destination channel
/prefix <text> – Set caption prefix
/suffix <text> – Set caption suffix
/replace <old> | <new> – Add replacement rule
/remove_replace <index> – Remove a replacement
/view – View all current settings
/clear – Clear prefix, suffix, and replacements`);
        return new Response('OK');
      }

      if (text.startsWith("/link ")) {
        const channelId = text.split(" ")[1];
        await env.USER_CONFIG.put(`user:${userId}`, channelId);
        await env.USER_CONFIG.put(`watchers:${channelId}:${userId}`, Date.now().toString());
        await sendText(api, userId, `✅ Linked to source channel ID: ${channelId}`);
        return new Response('OK');
      }

      if (text.startsWith("/forward ")) {
        const forwardId = text.split(" ")[1];
        await env.USER_CONFIG.put(`forward:${userId}`, forwardId);
        await sendText(api, userId, `✅ Destination set to channel ID: ${forwardId}`);
        return new Response('OK');
      }

      if (text.startsWith("/prefix ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
        const prefix = text.slice(8).trim();
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        config.prefix = prefix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        return sendText(api, userId, "✅ Prefix saved.");
      }

      if (text.startsWith("/suffix ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
        const suffix = text.slice(8).trim();
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        config.suffix = suffix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        return sendText(api, userId, "✅ Suffix saved.");
      }

      if (text.startsWith("/replace ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ Please link a channel first with /link");
        const parts = text.slice(9).split("|").map(p => p.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          return sendText(api, userId, "❌ Use format: /replace old_text | new_text");
        }
        const configRaw = await env.USER_CONFIG.get(`replacements:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : [];
        config.push({ old: parts[0], new: parts[1] });
        await env.USER_CONFIG.put(`replacements:${channelId}`, JSON.stringify(config));
        return sendText(api, userId, `✅ Replacement added: "${parts[0]}" → "${parts[1]}"`);
      }

      if (text.startsWith("/remove_replace ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ Please link a channel first with /link <channel_id>");
        const index = parseInt(text.split(" ")[1]);
        if (isNaN(index) || index < 1) return sendText(api, userId, "❌ Invalid index. Usage: /remove_replace <number>");
        const raw = await env.USER_CONFIG.get(`replacements:${channelId}`);
        let replacements = raw ? JSON.parse(raw) : [];
        if (index > replacements.length) return sendText(api, userId, `❌ Replacement #${index} does not exist.`);
        const removed = replacements.splice(index - 1, 1);
        await env.USER_CONFIG.put(`replacements:${channelId}`, JSON.stringify(replacements));
        return sendText(api, userId, `✅ Removed: "${removed[0].old}" → "${removed[0].new}"`);
      }

      if (text === "/view") {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        const forwardId = await env.USER_CONFIG.get(`forward:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ No channel linked. Use /link <channel_id>");
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        const replacementsRaw = await env.USER_CONFIG.get(`replacements:${channelId}`);
        const replacements = replacementsRaw ? JSON.parse(replacementsRaw) : [];
        const lines = [
          `🔧 <b>Your Configuration</b>`,
          `👁️ Source Channel ID: <code>${channelId}</code>`,
          forwardId ? `📤 Forward To: <code>${forwardId}</code>` : `📤 Forward To: <i>Not set</i>`,
          config.prefix ? `🔹 Prefix: <pre>${escape(config.prefix)}</pre>` : `🔹 Prefix: <i>Not set</i>`,
          config.suffix ? `🔸 Suffix: <pre>${escape(config.suffix)}</pre>` : `🔸 Suffix: <i>Not set</i>`,
          `📝 Replacements:`,
          replacements.length
            ? replacements.map((r, i) => `${i + 1}. <code>${escape(r.old)}</code> → <code>${escape(r.new)}</code>`).join("\n")
            : `<i>No replacements set</i>`
        ];
        await sendText(api, userId, lines.join("\n\n"));
        return new Response('OK');
      }

      if (text === "/clear") {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) return sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        delete config.prefix;
        delete config.suffix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        await env.USER_CONFIG.delete(`replacements:${channelId}`);
        return sendText(api, userId, "🧹 Prefix, Suffix, and all Replacements cleared.");
      }

      return sendText(api, userId, `Available Commands:\n\n/link <channel_id>\n/forward <channel_id>\n/prefix <text>\n/suffix <text>\n/replace <old> | <new>\n/remove_replace <index>\n/view\n/clear`);
    }

    // === 3. Callback Query ===
    if (update.callback_query) {
      const query = update.callback_query;
      const userId = query.from.id;
      const msgId = query.message.message_id;
      if (query.data === 'check_joined') {
        const isSubscribed = await checkSubscription(api, userId, env);
        if (isSubscribed) {
          await fetch(api("deleteMessage"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: userId, message_id: msgId })
          });
          await sendText(api, userId, `✅ You're verified! You may now use the bot.`);
        } else {
          const channelLink = await getOrCreateInviteLink(api, env, "channel", env.FORCE_CHANNEL);
          const groupLink = await getOrCreateInviteLink(api, env, "group", env.FORCE_GROUP);
          await sendJoinButtons(api, userId, channelLink, groupLink, true);
        }
        await fetch(api("answerCallbackQuery"), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: query.id })
        });
        return new Response('OK');
      }
    }

    return new Response('OK');
  }
};

// === New: Get All User IDs Linked to Channel ===
async function getAllUserIdsLinkedTo(channelId, env) {
  const prefix = `watchers:${channelId}:`;
  const userIds = [];
  for await (const entry of env.USER_CONFIG.list({ prefix })) {
    const [, , userId] = entry.key.split(":");
    userIds.push(userId);
  }
  return userIds;
}

// === Format Caption ===
function formatCaption(caption, config = {}, replacements = []) {
  let modified = caption;
  for (const { old, new: newText } of replacements) {
    modified = modified.split(old).join(newText);
  }
  const bold = `<b>${escape(modified)}</b>`;
  const prefix = config.prefix ? `<pre>${escape(config.prefix)}</pre>\n` : '';
  const suffix = config.suffix ? `\n<pre>${escape(config.suffix)}</pre>` : '';
  return `${prefix}${bold}${suffix}`;
}

// === Escape HTML ===
function escape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// === Send Text ===
async function sendText(api, chat_id, text) {
  await fetch(api("sendMessage"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
  });
}

// === Check Subscription ===
async function checkSubscription(api, userId, env) {
  const check = async (chat) => {
    const res = await fetch(api("getChatMember"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, user_id: userId })
    });
    const data = await res.json();
    const status = data.result?.status;
    return ['creator', 'administrator', 'member'].includes(status);
  };
  return await check(env.FORCE_CHANNEL) && await check(env.FORCE_GROUP);
}

// === Invite Link with Cache ===
async function getOrCreateInviteLink(api, env, type, chatId) {
  const kvKey = `invite:${type}`;
  let link = await env.USER_CONFIG.get(kvKey);
  if (link) return link;
  if (chatId.startsWith("@")) {
    link = `https://t.me/${chatId.slice(1)}`;
    await env.USER_CONFIG.put(kvKey, link);
    return link;
  }
  const res = await fetch(api("createChatInviteLink"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId })
  });
  const data = await res.json();
  if (data.ok) {
    link = data.result.invite_link;
    await env.USER_CONFIG.put(kvKey, link);
    return link;
  }
  return "https://t.me/";
}

// === Join Buttons ===
async function sendJoinButtons(api, userId, channelLink, groupLink, repeat = false) {
  await fetch(api("sendMessage"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: userId,
      text: repeat
        ? "❌ You're still not joined. Please join both and try again:"
        : "🔐 Please join both before using this bot:",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 Join Channel", url: channelLink },
            { text: "👥 Join Group", url: groupLink }
          ],
          [{ text: "✅ I've Joined", callback_data: "check_joined" }]
        ]
      }
    })
  });
}
