/**
 * Telegram Approve/Reject webhook — Google Apps Script.
 *
 * Alerts GitHub Actions मधून @civic_grievance_bot पाठवतो; बटण दाबल्यावर Telegram
 * इथल्या doPost ला कळवतो आणि ते sheet मधला Status बदलतं.
 *
 * पहिल्यांदा (किंवा bot/token बदलल्यावर): connectAlertBot() मध्ये token टाकून Run.
 * doPost बदलल्यावर: Deploy → Manage deployments → Edit → New version (URL तीच राहते).
 * तपासणीसाठी: checkSettings(), checkWebhook().
 */

// तुमच्या sheet चा ID (URL मधला /d/ ... /edit मधला भाग)
// openById वापरल्याने script sheet च्या आत असो वा वेगळा, दोन्ही ठिकाणी चालतो
var SPREADSHEET_ID = '1OBpuiiXczHdvL3Tc8vSvgRwdnLuzbw3ZVchy50FZNwI';

// Sheet मधले column क्रमांक (A = 1)
var STATUS_COLUMN = 6;
var ISSUE_ID_COLUMN = 7;
var ACTION_BY_COLUMN = 10;
var ACTION_AT_COLUMN = 11;

// मंजुरी म्हणजे मसुदा तयार - प्रत्यक्ष पाठवणी अजून हाताने करायची आहे
var STATUS_BY_ACTION = {
  approve: 'Approved - Manual Submission Required',
  reject: 'Rejected'
};

function props_() {
  return PropertiesService.getScriptProperties();
}

function telegramApi_(method, payload) {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error(method + ' failed: ' + err);
  }
}

/**
 * IssueID वरून नेमकी ओळ शोधून Status + कोणी/केव्हा नोंदवतो.
 * फक्त IssueID column मध्ये शोधतो, म्हणजे दुसऱ्या column मधला
 * योगायोगाने जुळणारा मजकूर चुकून पकडला जात नाही.
 */
function recordDecision_(issueHash, statusText, actor) {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var ids = sheet.getRange(2, ISSUE_ID_COLUMN, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === issueHash) {
      var row = i + 2;
      var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(row, STATUS_COLUMN).setValue(statusText);
      sheet.getRange(row, ACTION_BY_COLUMN).setValue(actor);
      sheet.getRange(row, ACTION_AT_COLUMN).setValue(stamp);
      return true;
    }
  }
  return false;
}

/** Apps Script ला request headers मिळत नाहीत, म्हणून गुपित URL मध्ये ठेवलं आहे. */
function doPost(e) {
  // ContentService वापरल्यास Telegram ला 302 मिळतो आणि updates अडकतात
  var ok = HtmlService.createHtmlOutput('ok');

  try {
    var expected = props_().getProperty('WEBHOOK_SECRET');
    if (expected && (!e || !e.parameter || e.parameter.s !== expected)) {
      console.warn('Rejected request: bad or missing secret.');
      return ok;
    }

    var update = JSON.parse(e.postData.contents);
    var callback = update.callback_query;
    if (!callback) return ok;

    var message = callback.message || {};
    var chatId = String((message.chat || {}).id || '');
    var allowedChat = props_().getProperty('TELEGRAM_CHAT_ID');

    // फक्त ठरलेल्या chat मधूनच कृती स्वीकारतो
    if (allowedChat && chatId !== String(allowedChat)) {
      console.warn('Rejected callback from unauthorised chat: ' + chatId);
      telegramApi_('answerCallbackQuery', {
        callback_query_id: callback.id, text: 'Not authorised.'
      });
      return ok;
    }

    var parts = String(callback.data || '').split(':');
    var action = parts[0];
    var issueHash = parts.slice(1).join(':');

    // अवैध कृती नाकारतो - approve नसलेली कोणतीही कृती Rejected ठरवत नाही
    if (!STATUS_BY_ACTION.hasOwnProperty(action) || !issueHash) {
      telegramApi_('answerCallbackQuery', {
        callback_query_id: callback.id, text: 'Unknown action.'
      });
      return ok;
    }

    var from = callback.from || {};
    var actor = from.username || String(from.id || 'unknown');
    var statusText = STATUS_BY_ACTION[action];
    var recorded = recordDecision_(issueHash, statusText, actor);

    telegramApi_('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: recorded ? statusText : 'Entry not found in the sheet.'
    });

    if (recorded) {
      // Approve/Reject बटणं काढतो, पण X/WhatsApp share (url) बटणं ठेवतो
      var rows = ((message.reply_markup || {}).inline_keyboard || []).filter(function (row) {
        return row.every(function (b) { return !!b.url; });
      });
      var edit = {
        chat_id: chatId,
        message_id: message.message_id,
        text: (message.text || '') + '\n\nStatus: ' + statusText + '\nBy: ' + actor
      };
      if (rows.length) edit.reply_markup = { inline_keyboard: rows };
      telegramApi_('editMessageText', edit);
    }
  } catch (err) {
    // काहीही चुकलं तरी Telegram ला 200 परत देतो, नाहीतर तो पुन्हा पुन्हा पाठवत राहील
    console.error('Webhook processing failed: ' + err);
  }

  return ok;
}

/** ब्राउझरमध्ये URL उघडून deployment जिवंत आहे का तपासण्यासाठी. */
function doGet() {
  return HtmlService.createHtmlOutput('Civic grievance webhook is running.');
}

// ---------------------------------------------------------------
// Alerts पाठवणारा bot जोडणे — एकदाच चालवा (पुन्हा चालवलं तरी सुरक्षित)
// ---------------------------------------------------------------

/**
 * GitHub मधले alerts @civic_grievance_bot पाठवतो, पण webhook दुसऱ्याच bot वर लागला होता.
 * हे function: token तपासतं → alerts चा chat आपोआप शोधतं → आधी दाबलेली बटणं sheet मध्ये
 * नोंदवतं → त्याच bot वर webhook लावतं → Telegram वर खात्रीचा संदेश पाठवतं.
 * Deploy पुन्हा करायची गरज नाही: doPost ही settings प्रत्येक वेळी नव्याने वाचतं.
 */
function connectAlertBot() {
  // TODO [मॅन्युअल बदल]: @civic_grievance_bot चा token
  //   कुठे मिळेल: @BotFather → /mybots → @civic_grievance_bot → API Token ("Revoke" दाबू नका)
  //   न बदलल्यास: "Paste the @civic_grievance_bot token" असा error येऊन थांबेल
  var ALERT_BOT_TOKEN = 'PASTE_CIVIC_GRIEVANCE_BOT_TOKEN_HERE';  // ← येथे बदला

  // GitHub secrets मधला bot — "Telegram Check" workflow ने ओळखला
  var ALERT_BOT_ID = 9250003701;
  var EXEC_URL = 'https://script.google.com/macros/s/AKfycby9PdYc7g3tqB9cTOixyyZEu8fwcNw8re3WOFQt4xK4EorgPFfvYDLOIeRF3l4EpMQj/exec';

  var token = ALERT_BOT_TOKEN.trim();
  if (token.indexOf('PASTE_') === 0) {
    throw new Error('Paste the @civic_grievance_bot token into ALERT_BOT_TOKEN first.');
  }

  // 1. token नेमका alerts पाठवणाऱ्या bot चाच आहे का
  var me = alertBotCall_(token, 'getMe', {});
  if (!me.ok) throw new Error('Telegram rejected this token: ' + me.description);
  if (me.result.id !== ALERT_BOT_ID) {
    throw new Error('This token belongs to @' + me.result.username +
      '. Alerts come from @civic_grievance_bot - copy that bot\'s token instead.');
  }
  var botName = '@' + me.result.username;
  console.log('STEP 1 OK - token belongs to ' + botName);

  // 2. Telegram कडे अडकलेली बटणं वाचतो (webhook असताना getUpdates चालत नाही, म्हणून आधी काढतो)
  alertBotCall_(token, 'deleteWebhook', { drop_pending_updates: false });
  var got = alertBotCall_(token, 'getUpdates', { timeout: 0 });
  var updates = (got.ok && got.result) || [];

  var chatId = '';
  var presses = [];
  updates.forEach(function (u) {
    var cq = u.callback_query;
    if (cq && cq.message && cq.message.chat) {
      chatId = String(cq.message.chat.id);   // alert वरचं बटण = नेमका alerts चा chat
      presses.push(cq);
    } else if (!chatId && u.message && u.message.chat && u.message.chat.type === 'private') {
      chatId = String(u.message.chat.id);
    }
  });

  // पुन्हा चालवल्यास अडकलेले updates नसतात - तेव्हा आधी साठवलेला chat तपासून वापरतो
  if (!chatId) {
    var savedChat = props_().getProperty('TELEGRAM_CHAT_ID');
    if (savedChat && alertBotCall_(token, 'getChat', { chat_id: savedChat }).ok) chatId = savedChat;
  }
  if (!chatId) {
    console.log('STEP 2 WAITING - could not find the alerts chat yet.');
    console.log('In Telegram, open ' + botName + ' in the chat where alerts arrive, send "hi", ' +
      'then run connectAlertBot again.');
    return;
  }
  var chat = alertBotCall_(token, 'getChat', { chat_id: chatId });
  var chatName = chat.ok ? (chat.result.title || chat.result.first_name || '') : '';
  console.log('STEP 2 OK - alerts chat "' + chatName + '"; ' + presses.length +
    ' earlier button press(es) waiting.');

  // वाचलेले updates Telegram कडून काढून टाकतो, म्हणजे ते पुन्हा येणार नाहीत
  if (updates.length) {
    alertBotCall_(token, 'getUpdates', {
      offset: updates[updates.length - 1].update_id + 1, timeout: 0
    });
  }

  // 3. आधी दाबलेली बटणं sheet मध्ये नोंदवतो (एकाच alert वर दोनदा दाबलं असल्यास शेवटचं ग्राह्य)
  presses.forEach(function (cq) {
    if (String(cq.message.chat.id) !== chatId) return;
    var parts = String(cq.data || '').split(':');
    var action = parts[0];
    var issueHash = parts.slice(1).join(':');
    if (!STATUS_BY_ACTION.hasOwnProperty(action) || !issueHash) return;
    var from = cq.from || {};
    var actor = from.username || String(from.id || 'unknown');
    var stored = recordDecision_(issueHash, STATUS_BY_ACTION[action], actor);
    console.log('   ' + action + ' ' + issueHash.slice(0, 8) +
      (stored ? ' -> saved in sheet' : ' -> row not found'));
  });
  console.log('STEP 3 OK - earlier button presses processed.');

  // 4. दुसऱ्या bot वरचा याच script चा webhook काढतो, settings साठवतो, योग्य bot वर webhook लावतो
  var p = props_();
  var oldToken = p.getProperty('TELEGRAM_BOT_TOKEN');
  if (oldToken && oldToken !== token) {
    var oldHook = alertBotCall_(oldToken, 'getWebhookInfo', {});
    if (oldHook.ok && String(oldHook.result.url || '').indexOf(EXEC_URL) === 0) {
      alertBotCall_(oldToken, 'deleteWebhook', { drop_pending_updates: true });
      console.log('   removed this script\'s webhook from the other bot.');
    }
  }

  var secret = p.getProperty('WEBHOOK_SECRET') || Utilities.getUuid().replace(/-/g, '');
  p.setProperties({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, WEBHOOK_SECRET: secret });

  var hook = alertBotCall_(token, 'setWebhook', {
    url: EXEC_URL + '?s=' + secret,
    allowed_updates: ['callback_query'],
    drop_pending_updates: false
  });
  if (!hook.ok) throw new Error('setWebhook failed: ' + hook.description);
  console.log('STEP 4 OK - buttons of ' + botName + ' now reach this script.');

  // 5. खात्रीचा संदेश - हा पोहोचला म्हणजे token आणि chat दोन्ही बरोबर
  var sent = alertBotCall_(token, 'sendMessage', {
    chat_id: chatId,
    text: '✅ Approve/Reject buttons are now connected to the Google Sheet.'
  });
  console.log(sent.ok
    ? 'DONE - press Approve or Reject on any alert in Telegram.'
    : 'Webhook is set, but the confirmation message failed: ' + sent.description);
}

/** Telegram API call करून उत्तर (त्रुटी असली तरी) JSON म्हणून परत देतो. */
function alertBotCall_(token, method, payload) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  try {
    return JSON.parse(res.getContentText());
  } catch (err) {
    return { ok: false, description: 'HTTP ' + res.getResponseCode() };
  }
}

/** काही चुकल्यास Telegram काय म्हणतोय ते बघण्यासाठी. */
function checkWebhook() {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  var response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/getWebhookInfo',
    { muteHttpExceptions: true }
  );
  console.log(response.getContentText());
}

/** Script Properties नीट साठवले आहेत का ते बघण्यासाठी (गुपितं दाखवत नाही). */
function checkSettings() {
  var p = props_().getProperties();
  console.log('TELEGRAM_BOT_TOKEN: ' + (p.TELEGRAM_BOT_TOKEN ? 'set' : 'MISSING'));
  console.log('TELEGRAM_CHAT_ID: ' + (p.TELEGRAM_CHAT_ID || 'MISSING'));
  console.log('WEBHOOK_SECRET: ' + (p.WEBHOOK_SECRET ? 'set' : 'MISSING'));
}
