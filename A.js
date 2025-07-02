export default {
  async fetch(request, env, ctx) {
    try {
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

        if (config.forward_channel) {
          await fetch(api("copyMessage"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.forward_channel,
              from_chat_id: post.chat.id,
              message_id: post.message_id
            })
          });
        }
        return new Response("OK");
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
            `👋 Welcome!\n\nUse:\n/link <channel_id>\n/pre <text>\n/suf <text>\n/replace old | new\n/fwd <channel_id>\n/show\n/clear <type>`
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
            return new Response("OK");
          }
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          config.prefix = text.slice(5).trim();
          await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
          await sendText(api, userId, "✅ Prefix saved.");
          return new Response("OK");
        }

        if (text.startsWith("/suf ")) {
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          if (!channelId) {
            await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
            return new Response("OK");
          }
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          config.suffix = text.slice(5).trim();
          await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
          await sendText(api, userId, "✅ Suffix saved.");
          return new Response("OK");
        }

        if (text.startsWith("/replace ")) {
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          if (!channelId) {
            await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
            return new Response("OK");
          }
          const [oldText, newText] = text.slice(9).split("|").map(s => s.trim());
          if (!oldText || !newText) {
            await sendText(api, userId, "❌ Format: /replace old text | new text");
            return new Response("OK");
          }
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          config.replacements = config.replacements || [];
          config.replacements.push({ old: oldText, new: newText });
          await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
          await sendText(api, userId, `🔁 Replacement saved:\n<b>${oldText}</b> → <b>${newText}</b>`);
          return new Response("OK");
        }

        if (text.startsWith("/fwd ")) {
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          if (!channelId) {
            await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
            return new Response("OK");
          }
          const forwardChannel = text.split(" ")[1];
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          config.forward_channel = forwardChannel;
          await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
          await sendText(api, userId, `📤 Forward channel set to: ${forwardChannel}`);
          return new Response("OK");
        }

        if (text === "/show") {
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          if (!channelId) {
            await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
            return new Response("OK");
          }
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          let msg = `🔧 Current Config:\n`;
          msg += `Prefix: ${config.prefix || '—'}\n`;
          msg += `Suffix: ${config.suffix || '—'}\n`;
          msg += `Forward Channel: ${config.forward_channel || '—'}\n`;
          if (Array.isArray(config.replacements) && config.replacements.length > 0) {
            msg += `Replacements:\n`;
            config.replacements.forEach((r, i) => {
              msg += `${i + 1}. <b>${r.old}</b> → <b>${r.new}</b>\n`;
            });
          } else msg += `Replacements: —\n`;
          await sendText(api, userId, msg);
          return new Response("OK");
        }

        if (text.startsWith("/clear")) {
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          if (!channelId) {
            await sendText(api, userId, "❌ Please link a channel first: /link <channel_id>");
            return new Response("OK");
          }
          const config = JSON.parse(await env.USER_CONFIG.get(`channel:${channelId}`) || '{}');
          const arg = text.split(" ")[1];

          if (!arg || arg === "all") {
            delete config.prefix;
            delete config.suffix;
            delete config.replacements;
          } else if (arg === "prefix") delete config.prefix;
          else if (arg === "suffix") delete config.suffix;
          else if (arg === "replacements") delete config.replacements;
          else {
            await sendText(api, userId, "❌ Invalid clear option.");
            return new Response("OK");
          }

          await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(config));
          await sendText(api, userId, `🧹 Cleared: ${arg || 'all'}`);
          return new Response("OK");
        }

        await sendText(api, userId,
          `Available Commands:\n\n/link <channel_id>\n/pre <text>\n/suf <text>\n/replace old | new\n/fwd <channel_id>\n/show\n/clear <type>`
        );
        return new Response("OK");
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
    } catch (err) {
      console.error("Unhandled error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};

function formatCaption(caption, config = {}) {
  let formatted = escape(caption);
  if (Array.isArray(config.replacements)) {
    for (const { old, new: newText } of config.replacements) {
      formatted = formatted.replaceAll(escape(old), escape(newText));
    }
  }
  const prefix = config.prefix ? `<pre>${escape(config.prefix)}</pre>\n` : '';
  const suffix = config.suffix ? `\n<pre>${escape(config.suffix)}</pre>` : '';
  return `${prefix}<b>${formatted}</b>${suffix}`;
}

function escape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendText(api, chat_id, text) {
  return await fetch(api("sendMessage"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
  });
}

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

async function sendJoinButtons(api, userId, channelLink, groupLink, repeat = false) {
  return await fetch(api("sendMessage"), {
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
