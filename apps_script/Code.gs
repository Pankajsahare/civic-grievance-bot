/**
 * Telegram Approve/Reject webhook — Google Apps Script आवृत्ती.
 *
 * हे sheet च्याच आत चालतं, त्यामुळे service-account JSON ची गरजच नाही.
 * Render किंवा दुसऱ्या कोणत्याही hosting ची आवश्यकता नाही.
 *
 * सुरुवात करण्यासाठी: setup() एकदा चालवा, मग Deploy → New deployment →
 * Web app (Execute as: Me, Who has access: Anyone), मग setWebhookNow() चालवा.
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
      telegramApi_('editMessageText', {
        chat_id: chatId,
        message_id: message.message_id,
        text: (message.text || '') + '\n\nStatus: ' + statusText + '\nBy: ' + actor
      });
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
// एकदाच चालवायची setup — खालची तीन मूल्यं भरा, मग setup() चालवा
// ---------------------------------------------------------------
function setup() {
  var BOT_TOKEN = 'PASTE_YOUR_BOT_TOKEN_HERE';   // ← येथे बदला
  var CHAT_ID = 'PASTE_YOUR_CHAT_ID_HERE';       // ← येथे बदला

  if (BOT_TOKEN.indexOf('PASTE_') === 0 || CHAT_ID.indexOf('PASTE_') === 0) {
    throw new Error('Fill in BOT_TOKEN and CHAT_ID inside setup() first.');
  }

  // गुपित आपोआप तयार करतो - हाताने ठरवायची गरज नाही
  var secret = Utilities.getUuid().replace(/-/g, '');
  props_().setProperties({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: String(CHAT_ID),
    WEBHOOK_SECRET: secret
  }, true);

  console.log('Saved. Now deploy as a web app, then run setWebhookNow().');
}

/**
 * Deploy केल्यानंतर हे चालवा.
 *
 * खाली तुमची Web app URL टाका (Deploy → Manage deployments मध्ये दिसते).
 * ती /exec ने संपली पाहिजे. editor मधून चालवल्यास ScriptApp.getService().getUrl()
 * खाजगी /dev URL देतो - तिथे Telegram पोहोचू शकत नाही, म्हणून ती चालत नाही.
 */
function setWebhookNow() {
  var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycby9PdYc7g3tqB9cTOixyyZEu8fwcNw8re3WOFQt4xK4EorgPFfvYDLOIeRF3l4EpMQj/exec';

  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  var secret = props_().getProperty('WEBHOOK_SECRET');
  if (!token || !secret) throw new Error('Run setup() first.');

  var url = WEB_APP_URL.indexOf('PASTE_') === 0 ? ScriptApp.getService().getUrl() : WEB_APP_URL.trim();

  if (!url || url.slice(-5) !== '/exec') {
    throw new Error(
      'Need the public /exec URL, got: ' + (url || 'nothing') +
      ' — open Deploy → Manage deployments, copy the Web app URL (it ends in /exec) ' +
      'and paste it into WEB_APP_URL at the top of this function.'
    );
  }

  var response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/setWebhook',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        url: url + '?s=' + secret,
        allowed_updates: ['callback_query'],
        drop_pending_updates: true
      }),
      muteHttpExceptions: true
    }
  );
  console.log(response.getContentText());
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


/**
 * निदानासाठी: Telegram न वापरता थेट sheet मध्ये लिहून बघतो.
 * हे चालल्यास अडचण Telegram-कडे आहे; अयशस्वी झाल्यास sheet-कडे.
 */
function testSheetAccess() {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var lastRow = sheet.getLastRow();
  console.log('Sheet opened: "' + sheet.getName() + '", rows: ' + lastRow);

  if (lastRow < 2) {
    console.log('No data rows to test against.');
    return;
  }
  var firstId = String(sheet.getRange(2, ISSUE_ID_COLUMN).getValue()).trim();
  console.log('First IssueID: ' + firstId);

  var ok = recordDecision_(firstId, 'TEST - please ignore', 'self-test');
  console.log(ok ? 'WRITE OK - row 2 updated. Sheet access works.'
                 : 'WRITE FAILED - IssueID not found.');
  console.log('Now set row 2 Status back to "Pending Approval" by hand.');
}

/** Script Properties नीट साठवले आहेत का ते बघण्यासाठी (गुपितं दाखवत नाही). */
function checkSettings() {
  var p = props_().getProperties();
  console.log('TELEGRAM_BOT_TOKEN: ' + (p.TELEGRAM_BOT_TOKEN ? 'set' : 'MISSING'));
  console.log('TELEGRAM_CHAT_ID: ' + (p.TELEGRAM_CHAT_ID || 'MISSING'));
  console.log('WEBHOOK_SECRET: ' + (p.WEBHOOK_SECRET ? 'set' : 'MISSING'));
}
/**
 * निदान: deployed web app खरंच बाहेरून पोहोचतो का ते तपासतो.
 * editor मधून चालतं पण deployed आवृत्तीला call करतं, त्यामुळे खरी स्थिती कळते.
 * Sheet मध्ये काहीही बदलत नाही (कृती 'noop' आहे, ती नाकारली जाते).
 */
function testWebhookReachable() {
  var EXEC_URL = 'https://script.google.com/macros/s/AKfycby9PdYc7g3tqB9cTOixyyZEu8fwcNw8re3WOFQt4xK4EorgPFfvYDLOIeRF3l4EpMQj/exec';

  var p = PropertiesService.getScriptProperties();
  var secret = p.getProperty('WEBHOOK_SECRET');
  var chatId = p.getProperty('TELEGRAM_CHAT_ID');

  var fakeUpdate = {
    callback_query: {
      id: 'selftest',
      data: 'noop:selftest',
      from: { username: 'self-test' },
      message: { message_id: 1, text: 'self test', chat: { id: chatId } }
    }
  };

  var res = UrlFetchApp.fetch(EXEC_URL + '?s=' + secret, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(fakeUpdate),
    muteHttpExceptions: true,
    followRedirects: false          // 302 लपवू नये म्हणून
  });

  var code = res.getResponseCode();
  var body = res.getContentText().slice(0, 200);

  console.log('HTTP ' + code);
  console.log('BODY: ' + body);

  if (code === 200 && body.indexOf('ok') !== -1) {
    console.log('VERDICT: web app is reachable. Problem is on the Telegram side.');
  } else if (code === 302 || code === 401 || code === 403 || body.indexOf('ServiceLogin') !== -1) {
    console.log('VERDICT: deployment is private. Set "Who has access" to Anyone.');
  } else {
    console.log('VERDICT: unexpected response - send both lines above.');
  }
}
