export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Only POST allowed');

    const update = await request.json();
    const token = env.BOT_TOKEN;
    const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

    // === 1. Handle Channel Post ===
    if (update.channel_post?.caption) {
      const post = update.channel_post;
      const key = `channel:${post.chat.id}`;
      const configRaw = await env.USER_CONFIG.get(key);
      const config = configRaw ? JSON.parse(configRaw) : {};
      const newCaption = formatCaption(post.caption, config);

      await fetch(api("editMessageCaption"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: post.chat.id,
          message_id: post.message_id,
          caption: newCaption,
          parse_mode: 'HTML'
        })
      });
    }

    // === 2. Handle Private Commands ===
    if (update.message?.chat?.type === 'private') {
      const msg = update.message;
      const text = msg.text || '';
      const userId = msg.chat.id.toString();

      // Force Subscribe Check for All Commands
      const isSubscribed = await checkSubscription(api, userId, env);
      if (!isSubscribed) {
        const channelLink = await getOrCreateInviteLink(api, env, "channel", env.FORCE_CHANNEL);
        const groupLink = await getOrCreateInviteLink(api, env, "group", env.FORCE_GROUP);
        await sendJoinButtons(api, userId, channelLink, groupLink);
        return new Response('OK');
      }

      if (text.startsWith("/start")) {
        await sendText(api, userId,
          `👋 Welcome!\n\nUse:\n/link <channel_id>\n/pre <text>\n/suf <text>\n/clear`
        );
        return new Response('OK');
      }

      if (text.startsWith("/link ")) {
        const channelId = text.split(" ")[1];
        await env.USER_CONFIG.put(`user:${userId}`, channelId);
        await sendText(api, userId, `✅ Linked to channel ID: ${channelId}`);
        return new Response('OK');
      }

      if (text.startsWith("/pre ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) {
          await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
          return new Response('OK');
        }
        const prefix = text.slice(5).trim();
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        config.prefix = prefix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        await sendText(api, userId, "✅ Prefix saved.");
        return new Response('OK');
      }

      if (text.startsWith("/suf ")) {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) {
          await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
          return new Response('OK');
        }
        const suffix = text.slice(5).trim();
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        config.suffix = suffix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        await sendText(api, userId, "✅ Suffix saved.");
        return new Response('OK');
      }

      if (text === "/clear") {
        const channelId = await env.USER_CONFIG.get(`user:${userId}`);
        if (!channelId) {
          await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
          return new Response('OK');
        }
        const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
        const config = configRaw ? JSON.parse(configRaw) : {};
        delete config.prefix;
        delete config.suffix;
        await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
        await sendText(api, userId, "🧹 Prefix and Suffix cleared.");
        return new Response('OK');
      }

      await sendText(api, userId,
        `Available Commands:\n\n/link <channel_id>\n/pre <text>\n/suf <text>\n/clear`
      );
    }

    // === 3. Handle Callback Query ===
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

// === Format Caption ===
function formatCaption(caption, config = {}) {
  const bold = `<b>${escape(caption)}</b>`;
  const prefix = config.prefix ? `<pre>${escape(config.prefix)}</pre>\n` : '';
  const suffix = config.suffix ? `\n<pre>${escape(config.suffix)}</pre>` : '';
  return `${prefix}${bold}${suffix}`;
}

// === HTML Escape ===
function escape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// === Send Text ===
async function sendText(api, chat_id, text) {
  await fetch(api("sendMessage"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text })
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

  const inChannel = await check(env.FORCE_CHANNEL);
  const inGroup = await check(env.FORCE_GROUP);
  return inChannel && inGroup;
}

// === Create or Get Invite Link with Cache ===
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

// === Send Force Subscribe Buttons ===
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
