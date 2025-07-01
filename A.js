// Move these to the top level of your worker (outside the export default)
async function getCurrentMenuMessage(env, userId) {
  return await env.USER_CONFIG.get(`menu_msg:${userId}`);
}

async function setCurrentMenuMessage(env, userId, messageId) {
  await env.USER_CONFIG.put(`menu_msg:${userId}`, messageId.toString());
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Only POST allowed');

    const update = await request.json();
    const token = env.BOT_TOKEN;
    const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
    const menuImage = "https://raw.githubusercontent.com/svnig7/svnig7/refs/heads/main/imdbbotl.png";
    const OWNER_ID = env.OWNER_ID;

    async function cleanupOldMenu(api, env, userId) {
      const oldMessageId = await getCurrentMenuMessage(env, userId);
      if (oldMessageId) {
        try {
          await fetch(api("deleteMessage"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userId,
              message_id: oldMessageId
            })
          });
        } catch (e) {
          console.error("Failed to delete old menu:", e);
        }
        await env.USER_CONFIG.delete(`menu_msg:${userId}`);
      }
    }

    // === 1. Handle Channel Post ===
    if (update.channel_post) {
      const post = update.channel_post;
      // Skip if no caption and no media (text-only posts would have caption or text)
      if (!post.caption && !(post.photo || post.video || post.document)) {
        return new Response('OK');
      }

      const key = `channel:${post.chat.id}`;
      const configRaw = await env.USER_CONFIG.get(key);
      const config = configRaw ? JSON.parse(configRaw) : { 
        style_template: "{caption}",
        style_caption: false,
        replacements: []
      };
      
      let processedCaption = post.caption || "";
      
      // Only apply replacements if explicitly enabled in config
      if (config.replacements?.length > 0 && config.replacements_enabled) {
        for (const replacement of config.replacements) {
          try {
            if (replacement.enabled !== false) {
              const pattern = new RegExp(escapeRegExp(replacement.from), 'gi');
              processedCaption = processedCaption.replace(pattern, replacement.to);
            }
          } catch (e) {
            console.error(`Replacement error: ${e}`);
          }
        }
      }
      
      // Apply HTML styling only if explicitly enabled
      if (config.style_caption && config.style_template) {
        try {
          processedCaption = config.style_template.replace('{caption}', processedCaption);
        } catch (e) {
          console.error('Style template error:', e);
        }
      }
      
      const newCaption = formatCaption(processedCaption, config);

      // Only edit if there was a caption to begin with and changes were made
      if (post.caption && newCaption !== post.caption) {
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

      const forwardConfig = await env.USER_CONFIG.get(`forward:${post.chat.id}`);
      if (forwardConfig && forwardConfig !== "disabled") {
        const forwardData = JSON.parse(forwardConfig);
        if (forwardData.enabled) {
          const messageHash = await createMessageHash(post);
          const lastForwardedHash = await env.USER_CONFIG.get(`last_forward:${post.chat.id}`);
          
          if (messageHash !== lastForwardedHash) {
            await forwardMessageWithoutTag(api, post, forwardData.chat_id, newCaption);
            await env.USER_CONFIG.put(`last_forward:${post.chat.id}`, messageHash);
          }
        }
      }
    }

    // === 2. Handle Private Messages ===
    if (update.message?.chat?.type === 'private') {
      const msg = update.message;
      const text = msg.text || '';
      const userId = msg.chat.id.toString();

      // Owner commands
      if (userId.toString() === OWNER_ID.toString()) {
        if (text.startsWith("/broadcast ")) {
          const broadcastMessage = text.substring("/broadcast ".length);
          const users = await env.USER_CONFIG.list({ prefix: "user:" });
          await sendText(api, userId, `Broadcasting to ${users.keys.length} users...`);
          
          const failedUsers = [];
          for (const user of users.keys) {
            try {
              await sendText(api, user.name.split(":")[1], broadcastMessage);
              await new Promise(resolve => setTimeout(resolve, 200)); // Rate limiting
            } catch (e) {
              console.error(`Failed to send to ${user.name}:`, e);
              failedUsers.push(user.name.split(":")[1]);
            }
          }
          
          if (failedUsers.length > 0) {
            await sendText(api, userId, `Failed to send to ${failedUsers.length} users`);
          }
          return new Response('OK');
        }
        else if (text === "/users") {
          const users = await env.USER_CONFIG.list({ prefix: "user:" });
          await sendText(api, userId, `📊 Total users: ${users.keys.length}`);
          return new Response('OK');
        }
      }

      // Check if this is a response to a setting prompt
      const pendingAction = await env.USER_CONFIG.get(`pending:${userId}`);
      if (pendingAction && !text.startsWith('/')) {
        try {
          await fetch(api("deleteMessage"), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userId,
              message_id: msg.message_id
            })
          });
        } catch (e) {
          console.error("Failed to delete message:", e);
        }

        await env.USER_CONFIG.delete(`pending:${userId}`);
        const [action, messageId] = pendingAction.split('|');
        
        if (action.startsWith("set_")) {
          const type = action.split('_')[1];
          const channelId = await env.USER_CONFIG.get(`user:${userId}`);
          const config = channelId ? await getChannelConfig(env, channelId) : {};
          
          if (type === 'link') {
            await env.USER_CONFIG.put(`user:${userId}`, text);
            await editMessage(api, userId, messageId, 
              `✅ Channel linked to: <code>${text}</code>`,
              [[{ text: "⬅️ Back to Edit", callback_data: "edit_menu" }]],
              menuImage
            );
          } 
          else if (type === 'replace') {
            const parts = text.split('|').map(p => p.trim());
            if (parts.length < 2) {
              await editMessage(api, userId, messageId,
                "❌ Invalid format. Use: <code>original | replacement</code>",
                [[{ text: "Try Again", callback_data: "add_replace" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            if (!channelId) {
              await editMessage(api, userId, messageId,
                "❌ Please link a channel first!",
                [[{ text: "Link Channel", callback_data: "set_link" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            if (!Array.isArray(config.replacements)) config.replacements = [];
            config.replacements.push({ from: parts[0], to: parts[1], enabled: true });
            await saveChannelConfig(env, channelId, config);
            
            await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
          }
          else if (type === 'forward') {
            if (!channelId) {
              await editMessage(api, userId, messageId,
                "❌ Please link a channel first!",
                [[{ text: "Link Channel", callback_data: "set_link" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            const forwardData = {
              enabled: text.toLowerCase() !== 'disabled',
              chat_id: text.toLowerCase() !== 'disabled' ? text : null
            };
            await env.USER_CONFIG.put(`forward:${channelId}`, JSON.stringify(forwardData));
            
            await editMessage(api, userId, messageId,
              forwardData.enabled 
                ? `✅ Forwarding enabled to: <code>${text}</code>`
                : "✅ Forwarding disabled",
              [[{ text: "⬅️ Back to Edit", callback_data: "edit_menu" }]],
              menuImage
            );
          }
          else if (type === 'style_template') {
            if (!channelId) {
              await editMessage(api, userId, messageId,
                "❌ Please link a channel first!",
                [[{ text: "Link Channel", callback_data: "set_link" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            config.style_template = text;
            await saveChannelConfig(env, channelId, config);
            
            await editMessage(api, userId, messageId,
              `✅ Style template set!`,
              [[{ text: "⬅️ Back to Edit", callback_data: "edit_menu" }]],
              menuImage
            );
          }
          else if (type === 'replacements_enabled') {
            if (!channelId) {
              await editMessage(api, userId, messageId,
                "❌ Please link a channel first!",
                [[{ text: "Link Channel", callback_data: "set_link" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            config.replacements_enabled = text.toLowerCase() === 'true' || text.toLowerCase() === 'yes';
            await saveChannelConfig(env, channelId, config);
            
            await editMessage(api, userId, messageId,
              `✅ Replacements ${config.replacements_enabled ? 'enabled' : 'disabled'}`,
              [[{ text: "⬅️ Back to Edit", callback_data: "edit_menu" }]],
              menuImage
            );
          }
          else {
            if (!channelId) {
              await editMessage(api, userId, messageId,
                "❌ Please link a channel first!",
                [[{ text: "Link Channel", callback_data: "set_link" }]],
                menuImage
              );
              return new Response('OK');
            }
            
            config[type] = text;
            await saveChannelConfig(env, channelId, config);
            
            await editMessage(api, userId, messageId,
              `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} set to:\n<code>${text}</code>`,
              [[{ text: "⬅️ Back to Edit", callback_data: "edit_menu" }]],
              menuImage
            );
          }
          return new Response('OK');
        }
      }

      // Force Subscribe Check
      if (!(await checkSubscription(api, userId, env))) {
        const channelLink = await getOrCreateInviteLink(api, env, "channel", env.FORCE_CHANNEL);
        const groupLink = await getOrCreateInviteLink(api, env, "group", env.FORCE_GROUP);
        await sendJoinButtons(api, userId, channelLink, groupLink, menuImage);
        return new Response('OK');
      }

      if (text === "/start" || text === "/menu") {
        await showMainMenu(api, userId, null, menuImage);
        return new Response('OK');
      }
    }

    // === 3. Handle Callback Queries ===
    if (update.callback_query) {
      const query = update.callback_query;
      const userId = query.from.id;
      const messageId = query.message.message_id;

      await fetch(api("answerCallbackQuery"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: query.id })
      });

      const channelId = await env.USER_CONFIG.get(`user:${userId}`);
      const config = channelId ? await getChannelConfig(env, channelId) : {};

      if (query.data === "main_menu") {
        await showMainMenu(api, userId, messageId, menuImage);
      }
      else if (query.data === "view_settings") {
        await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
      }
      else if (query.data === "edit_menu") {
        await showEditMenu(api, userId, messageId, menuImage);
      }
      else if (query.data.startsWith("set_")) {
        const type = query.data.split("_")[1];
        await env.USER_CONFIG.put(`pending:${userId}`, `${query.data}|${messageId}`, { expirationTtl: 3600 });
        await showSetMenu(api, userId, messageId, type, menuImage);
      }
      else if (query.data.startsWith("clear_")) {
        const type = query.data.split("_")[1];
        await handleSettingClear(api, env, userId, messageId, channelId, config, type, menuImage);
      }
      else if (query.data === "add_replace") {
        await env.USER_CONFIG.put(`pending:${userId}`, `set_replace|${messageId}`, { expirationTtl: 3600 });
        await askForReplacement(api, userId, messageId, menuImage);
      }
      else if (query.data.startsWith("del_replace_")) {
        const index = parseInt(query.data.split("_")[2]);
        await deleteReplacement(api, env, userId, messageId, channelId, config, index, menuImage);
      }
      else if (query.data.startsWith("toggle_replace_")) {
        const index = parseInt(query.data.split("_")[2]);
        if (config.replacements?.[index]) {
          config.replacements[index].enabled = !(config.replacements[index].enabled !== false);
          await saveChannelConfig(env, channelId, config);
          await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
        }
      }
      else if (query.data === "toggle_replacements") {
        config.replacements_enabled = !config.replacements_enabled;
        await saveChannelConfig(env, channelId, config);
        await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
      }
      else if (query.data === "clear_all") {
        await handleClearAll(api, env, userId, messageId, channelId, menuImage);
      }
      else if (query.data === "check_joined") {
        if (await checkSubscription(api, userId, env)) {
          await showMainMenu(api, userId, messageId, menuImage);
        } else {
          const channelLink = await getOrCreateInviteLink(api, env, "channel", env.FORCE_CHANNEL);
          const groupLink = await getOrCreateInviteLink(api, env, "group", env.FORCE_GROUP);
          await sendJoinButtons(api, userId, channelLink, groupLink, menuImage, true);
        }
      }
      else if (query.data === "toggle_forwarding") {
        const forwardConfigRaw = await env.USER_CONFIG.get(`forward:${channelId}`);
        const forwardConfig = forwardConfigRaw ? JSON.parse(forwardConfigRaw) : { enabled: false, chat_id: null };
        forwardConfig.enabled = !forwardConfig.enabled;
        await env.USER_CONFIG.put(`forward:${channelId}`, JSON.stringify(forwardConfig));
        await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
      }
      else if (query.data === "toggle_style") {
        config.style_caption = !config.style_caption;
        await saveChannelConfig(env, channelId, config);
        await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
      }
      else if (query.data === "set_style_template") {
        await env.USER_CONFIG.put(`pending:${userId}`, `set_style_template|${messageId}`, { expirationTtl: 3600 });
        await askForStyleTemplate(api, userId, messageId, menuImage);
      }

      return new Response('OK');
    }

    return new Response('OK');
  }
};

// ===== MENU FUNCTIONS =====
async function showMainMenu(api, userId, messageId = null, menuImage) {
  const menuText = "⚙️ <b>Main Menu</b> - Select an option:";
  const buttons = [
    [
      { text: "🔍 View Settings", callback_data: "view_settings" },
      { text: "✏️ Edit Settings", callback_data: "edit_menu" }
    ],
    [
      { text: "🔄 Add Replacement", callback_data: "add_replace" },
      { text: "🧹 Clear All", callback_data: "clear_all" }
    ]
  ];

  if (messageId) {
    await editMessage(api, env, userId, messageId, menuText, buttons, menuImage);
  } else {
    const msg = await sendMenu(api, userId, menuText, buttons, menuImage);
    if (msg?.result?.message_id) {
      await setCurrentMenuMessage(env, userId, msg.result.message_id);
    }
  }
}

async function showEditMenu(api, userId, messageId, menuImage) {
  await editMessage(api, userId, messageId,
    "✏️ <b>Edit Settings</b>:",
    [
      [
        { text: "🔠 Prefix", callback_data: "set_prefix" },
        { text: "🔣 Suffix", callback_data: "set_suffix" }
      ],
      [
        { text: "➡️ Forwarding", callback_data: "set_forward" },
        { text: "🔗 Channel Link", callback_data: "set_link" }
      ],
      [
        { text: "🎨 Style Template", callback_data: "set_style_template" },
        { text: "🔤 Text Replacements", callback_data: "toggle_replacements" }
      ],
      [
        { text: "⬅️ Back", callback_data: "main_menu" }
      ]
    ],
    menuImage
  );
}

async function showSetMenu(api, userId, messageId, type, menuImage) {
  const examples = {
    prefix: "📝 Example: <b>🔥New Movie:</b>\nThis will be added before your caption",
    suffix: "📝 Example: <b>Join @YourChannel</b>\nThis will be added after your caption",
    forward: "📝 Enter channel ID or username\nSend 'disabled' to turn off forwarding",
    link: "📝 Enter your channel ID",
    style_template: "📝 Enter HTML template with <code>{caption}</code> placeholder\nExample: <code>&lt;b&gt;{caption}&lt;/b&gt;</code>",
    replacements_enabled: "📝 Enable/disable text replacements (true/false)"
  };

  await editMessage(api, userId, messageId,
    `✏️ <b>Set ${type.charAt(0).toUpperCase() + type.slice(1)}</b>\n\n${examples[type]}\n\nPlease type your new ${type.replace('_', ' ')}:`,
    [[{ text: "❌ Cancel", callback_data: "edit_menu" }]],
    menuImage
  );
}

async function askForReplacement(api, userId, messageId, menuImage) {
  await editMessage(api, userId, messageId,
    "🔄 <b>Add Replacement Rule</b>\n\nFormat: <code>original | replacement</code>\n\nExample:\n<code>Swaraj.-.Bharat.ke.swatantrata.sangram.ki.samagra.gatha | The Roundup: Punishment (2024)</code>",
    [
      [{ text: "❌ Cancel", callback_data: "main_menu" }]
    ],
    menuImage
  );
}

async function askForStyleTemplate(api, userId, messageId, menuImage) {
  await editMessage(api, userId, messageId,
    "🎨 <b>Set Style Template</b>\n\nEnter HTML template with <code>{caption}</code> placeholder:\n\nExamples:\n" +
    "- <code>{caption}</code> (default, no formatting)\n" +
    "- <code>&lt;b&gt;{caption}&lt;/b&gt;</code>\n" +
    "- <code>&lt;i&gt;&lt;u&gt;{caption}&lt;/u&gt;&lt;/i&gt;</code>\n" +
    "- <code>&lt;tg-spoiler&gt;{caption}&lt;/tg-spoiler&gt;</code>\n\n" +
    "Available tags: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strike</s>, " +
    "<code>mono</code>, <pre>pre</pre>, <blockquote>quote</blockquote>, <tg-spoiler>spoiler</tg-spoiler>, <a href=\"...\">links</a>",
    [
      [{ text: "❌ Cancel", callback_data: "edit_menu" }]
    ],
    menuImage
  );
}

// ===== SETTING HANDLERS =====
async function handleSettingClear(api, env, userId, messageId, channelId, config, type, menuImage) {
  if (!channelId) {
    await editMessage(api, userId, messageId,
      "❌ Please link a channel first!",
      [[{ text: "🔗 Link Channel", callback_data: "set_link" }]],
      menuImage
    );
    return;
  }

  switch(type) {
    case "prefix":
    case "suffix":
      delete config[type];
      await saveChannelConfig(env, channelId, config);
      break;
    case "forward":
      await env.USER_CONFIG.put(`forward:${channelId}`, JSON.stringify({ enabled: false, chat_id: null }));
      break;
    case "replace":
      config.replacements = [];
      await saveChannelConfig(env, channelId, config);
      break;
    case "style":
      config.style_caption = false;
      config.style_template = "{caption}";
      await saveChannelConfig(env, channelId, config);
      break;
    case "replacements_enabled":
      config.replacements_enabled = false;
      await saveChannelConfig(env, channelId, config);
      break;
  }

  await editMessage(api, userId, messageId,
    `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} cleared successfully!`,
    [[{ text: "⬅️ Back to Menu", callback_data: "main_menu" }]],
    menuImage
  );
}

async function handleClearAll(api, env, userId, messageId, channelId, menuImage) {
  if (!channelId) {
    await editMessage(api, userId, messageId,
      "❌ Please link a channel first!",
      [[{ text: "🔗 Link Channel", callback_data: "set_link" }]],
      menuImage
    );
    return;
  }

  // Clear all settings except channel link
  await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify({ 
    style_template: "{caption}",
    style_caption: false,
    replacements: [],
    replacements_enabled: false
  }));
  
  // Clear forwarding config
  await env.USER_CONFIG.put(`forward:${channelId}`, JSON.stringify({ 
    enabled: false,
    chat_id: null
  }));

  // Get updated config
  const config = await getChannelConfig(env, channelId);
  
  await showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage);
}

async function deleteReplacement(api, env, userId, messageId, channelId, config, index, menuImage) {
  if (!config.replacements?.[index]) {
    await editMessage(api, userId, messageId,
      "❌ Replacement not found!",
      [[{ text: "⬅️ Back", callback_data: "view_settings" }]],
      menuImage
    );
    return;
  }

  const removed = config.replacements.splice(index, 1);
  await saveChannelConfig(env, channelId, config);

  await editMessage(api, userId, messageId,
    `✅ Removed replacement:\n"${escapeHtml(removed[0].from)}" → "${escapeHtml(removed[0].to)}"`,
    [[{ text: "⬅️ Back", callback_data: "view_settings" }]],
    menuImage
  );
}

// ===== DISPLAY FUNCTIONS =====
async function showCurrentSettings(api, env, userId, messageId, channelId, config, menuImage) {
  let message = "🔍 <b>Current Settings</b>\n\n";
  message += `🔗 Channel: <code>${channelId || "Not linked"}</code>\n\n`;
  message += `🔠 Prefix: ${config.prefix ? escapeHtml(config.prefix) : "<i>Not set</i>"}\n`;
  message += `🔣 Suffix: ${config.suffix ? escapeHtml(config.suffix) : "<i>Not set</i>"}\n\n`;
  
  const forwardConfigRaw = channelId ? await env.USER_CONFIG.get(`forward:${channelId}`) : null;
  const forwardConfig = forwardConfigRaw ? JSON.parse(forwardConfigRaw) : { enabled: false, chat_id: null };
  message += `➡️ Forwarding: ${forwardConfig.enabled ? `✅ Enabled to <code>${forwardConfig.chat_id || 'no target'}</code>` : '❌ Disabled'}\n\n`;
  
  message += `🎨 Caption Styling: ${config.style_caption ? '✅ Enabled' : '❌ Disabled'}\n`;
  if (config.style_template) {
    message += `Template: <code>${escapeHtml(config.style_template)}</code>\n`;
    message += `Preview: ${config.style_template.replace('{caption}', 'Sample Text')}\n\n`;
  } else {
    message += "Template: <i>Default (no formatting)</i>\n\n";
  }
  
  message += `🔄 Text Replacements: ${config.replacements_enabled ? '✅ Enabled' : '❌ Disabled'}\n`;
  if (config.replacements?.length > 0) {
    message += "<b>Current Rules:</b>\n";
    config.replacements.forEach((rep, i) => {
      message += `${i+1}. <code>${escapeHtml(rep.from)}</code> → <code>${escapeHtml(rep.to)}</code>\n`;
    });
  } else {
    message += "No replacements set";
  }

  const buttons = [];
  if (config.replacements?.length > 0) {
    buttons.push(
      config.replacements.map((rep, i) => ({
        text: rep.enabled !== false ? `✅ ${i+1}` : `❌ ${i+1}`,
        callback_data: `toggle_replace_${i}`
      }))
    );
  }
  buttons.push([
    { 
      text: forwardConfig.enabled ? "🔴 Disable Forward" : "🟢 Enable Forward", 
      callback_data: "toggle_forwarding" 
    },
    { 
      text: config.style_caption ? "🔴 Disable Style" : "🟢 Enable Style", 
      callback_data: "toggle_style" 
    }
  ]);
  buttons.push([
    { 
      text: config.replacements_enabled ? "🔴 Disable Replace" : "🟢 Enable Replace", 
      callback_data: "toggle_replacements" 
    }
  ]);
  buttons.push([{ text: "⬅️ Menu", callback_data: "main_menu" }]);

  await editMessage(api, userId, messageId, message, buttons, menuImage);
}

// ===== UTILITY FUNCTIONS =====
async function sendMenu(api, chatId, text, buttons, photo) {
  try {
    const response = await fetch(api(photo ? "sendPhoto" : "sendMessage"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        ...(photo ? { photo, caption: text } : { text }),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
      })
    });
    return await response.json();
  } catch (e) {
    console.error("Failed to send menu:", e);
    return null;
  }
}

async function editMessage(api, env, chatId, messageId, text, buttons, photo) {
  if (photo) {
    try {
      await fetch(api("deleteMessage"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId
        })
      });
    } catch (e) {
      console.error("Failed to delete message:", e);
    }
    const msg = await sendMenu(api, chatId, text, buttons, photo);
    if (msg?.result?.message_id) {
      await setCurrentMenuMessage(env, chatId, msg.result.message_id);
    }
  } else {
    await fetch(api("editMessageText"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined
      })
    });
  }
}

async function sendText(api, chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...options
  };
  await fetch(api("sendMessage"), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function getChannelConfig(env, channelId) {
  const configRaw = await env.USER_CONFIG.get(`channel:${channelId}`);
  const config = configRaw ? JSON.parse(configRaw) : { 
    style_template: "{caption}", 
    style_caption: false,
    replacements: [],
    replacements_enabled: false
  };
  
  // Ensure config has required structure
  if (!Array.isArray(config.replacements)) config.replacements = [];
  if (typeof config.style_caption === 'undefined') config.style_caption = false;
  if (!config.style_template) config.style_template = "{caption}";
  if (typeof config.replacements_enabled === 'undefined') config.replacements_enabled = false;
  
  return config;
}

async function saveChannelConfig(env, channelId, config) {
  // Ensure we don't save undefined values
  const cleanConfig = {
    style_template: config.style_template || "{caption}",
    style_caption: config.style_caption === true,
    replacements: Array.isArray(config.replacements) ? config.replacements : [],
    replacements_enabled: config.replacements_enabled === true
  };
  
  if (config.prefix !== undefined) cleanConfig.prefix = config.prefix;
  if (config.suffix !== undefined) cleanConfig.suffix = config.suffix;
  
  await env.USER_CONFIG.put(`channel:${channelId}`, JSON.stringify(cleanConfig));
}

function formatCaption(caption, config) {
  let result = caption;
  if (config.prefix) result = config.prefix + "\n" + result;
  if (config.suffix) result = result + "\n" + config.suffix;
  return result;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function createMessageHash(post) {
  let content = post.caption || '';
  if (post.photo) content += post.photo[0]?.file_unique_id || '';
  if (post.video) content += post.video.file_unique_id || '';
  if (post.document) content += post.document.file_unique_id || '';
  
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString();
}

async function forwardMessageWithoutTag(api, originalPost, targetChatId, newCaption) {
  if (originalPost.photo) {
    await fetch(api("sendPhoto"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        photo: originalPost.photo[originalPost.photo.length - 1].file_id,
        caption: newCaption,
        parse_mode: 'HTML'
      })
    });
  } else if (originalPost.video) {
    await fetch(api("sendVideo"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        video: originalPost.video.file_id,
        caption: newCaption,
        parse_mode: 'HTML'
      })
    });
  } else if (originalPost.document) {
    await fetch(api("sendDocument"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        document: originalPost.document.file_id,
        caption: newCaption,
        parse_mode: 'HTML'
      })
    });
  } else {
    await fetch(api("sendMessage"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: newCaption,
        parse_mode: 'HTML'
      })
    });
  }
}

async function checkSubscription(api, userId, env) {
  const check = async (chat) => {
    try {
      const res = await fetch(api("getChatMember"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, user_id: userId })
      });
      const data = await res.json();
      const status = data.result?.status;
      return ['creator', 'administrator', 'member'].includes(status);
    } catch (e) {
      console.error(`Failed to check membership in ${chat}:`, e);
      return false;
    }
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

  try {
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
  } catch (e) {
    console.error("Failed to create invite link:", e);
  }

  return "https://t.me/";
}

async function sendJoinButtons(api, userId, channelLink, groupLink, menuImage, repeat = false) {
  const text = repeat
    ? "❌ You're still not joined. Please join both and try again:"
    : "🔐 Please join both before using this bot:";

  if (menuImage) {
    await fetch(api("sendPhoto"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        photo: menuImage,
        caption: text,
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
  } else {
    await fetch(api("sendMessage"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        text,
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
}
