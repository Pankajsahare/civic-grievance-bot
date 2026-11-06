"""Telegram webhook: Approve/Reject बटण हाताळतो आणि Sheet मध्ये मंजुरीचा लेखाजोखा नोंदवतो."""

import json
import os
from datetime import datetime

import gspread
import requests
from flask import Flask, jsonify, request
from google.oauth2.service_account import Credentials

app = Flask(__name__)

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
# setWebhook करताना हाच secret_token द्यावा; Telegram तो प्रत्येक request च्या header मध्ये पाठवते
WEBHOOK_SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET")
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON")

SPREADSHEET_NAME = "Civic Grievances Tracker"
STATUS_COLUMN = 6      # Status
ISSUE_ID_COLUMN = 7    # IssueID
ACTION_BY_COLUMN = 10  # ActionBy
ACTION_AT_COLUMN = 11  # ActionAt

# मंजुरी म्हणजे मसुदा तयार - प्रत्यक्ष पाठवणी अजून हाताने करायची आहे
STATUS_BY_ACTION = {
    "approve": "Approved - Manual Submission Required",
    "reject": "Rejected",
}

TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

_sheet_cache = None


def get_sheet():
    global _sheet_cache
    if _sheet_cache is not None:
        return _sheet_cache

    creds = Credentials.from_service_account_info(
        json.loads(GOOGLE_CREDENTIALS_JSON),
        scopes=[
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ],
    )
    _sheet_cache = gspread.authorize(creds).open(SPREADSHEET_NAME).sheet1
    return _sheet_cache


def answer_callback(callback_id, text=""):
    try:
        requests.post(
            f"{TELEGRAM_API}/answerCallbackQuery",
            json={"callback_query_id": callback_id, "text": text},
            timeout=10,
        )
    except requests.RequestException as e:
        print(f"answerCallbackQuery failed: {e}")


def record_decision(issue_hash, status_text, actor):
    """IssueID वरून नेमकी row शोधून Status + कोणी/केव्हा नोंदवतो."""
    sheet = get_sheet()
    # फक्त IssueID column मध्ये शोधतो - दुसऱ्या column मधला योगायोगाने जुळणारा मजकूर टाळण्यासाठी
    cell = sheet.find(issue_hash, in_column=ISSUE_ID_COLUMN)
    if not cell:
        print(f"IssueID not found in sheet: {issue_hash}")
        return False

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sheet.update_cell(cell.row, STATUS_COLUMN, status_text)
    sheet.update_cell(cell.row, ACTION_BY_COLUMN, actor)
    sheet.update_cell(cell.row, ACTION_AT_COLUMN, now)
    return True


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route(f"/{TELEGRAM_BOT_TOKEN}", methods=["POST"])
def telegram_webhook():
    # सुरक्षा 1: secret header - URL कुठे गळाली तरी बनावट request आत येत नाही
    if WEBHOOK_SECRET:
        sent = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if sent != WEBHOOK_SECRET:
            print("Rejected request: bad secret token.")
            return jsonify({"status": "forbidden"}), 403

    try:
        update = request.get_json(silent=True) or {}
        callback = update.get("callback_query")
        if not callback:
            return jsonify({"status": "ignored"})

        callback_id = callback.get("id", "")
        message = callback.get("message", {})
        chat_id = str(message.get("chat", {}).get("id", ""))
        message_id = message.get("message_id")
        user = callback.get("from", {})
        actor = user.get("username") or str(user.get("id", "unknown"))

        # सुरक्षा 2: फक्त ठरलेल्या chat मधूनच कृती स्वीकारतो
        if TELEGRAM_CHAT_ID and chat_id != str(TELEGRAM_CHAT_ID):
            print(f"Rejected callback from unauthorised chat: {chat_id}")
            answer_callback(callback_id, "Not authorised.")
            return jsonify({"status": "forbidden"}), 403

        action, _, issue_hash = (callback.get("data") or "").partition(":")

        # सुरक्षा 3: अवैध कृती नाकारतो (पूर्वी approve नसलेली कोणतीही कृती Rejected ठरत होती)
        if action not in STATUS_BY_ACTION or not issue_hash:
            print(f"Rejected unknown callback data: {callback.get('data')!r}")
            answer_callback(callback_id, "Unknown action.")
            return jsonify({"status": "bad_request"}), 400

        status_text = STATUS_BY_ACTION[action]

        try:
            recorded = record_decision(issue_hash, status_text, actor)
        except Exception as e:
            print(f"Sheet update failed: {e}")
            answer_callback(callback_id, "Could not update the sheet. Try again.")
            return jsonify({"status": "sheet_error"}), 200

        if not recorded:
            answer_callback(callback_id, "Entry not found in the sheet.")
            return jsonify({"status": "not_found"}), 200

        answer_callback(callback_id, status_text)

        try:
            requests.post(
                f"{TELEGRAM_API}/editMessageText",
                json={
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": f"{message.get('text', '')}\n\nStatus: {status_text}\nBy: {actor}",
                },
                timeout=10,
            )
        except requests.RequestException as e:
            print(f"editMessageText failed: {e}")

    except Exception as e:
        # कोणताही call अयशस्वी झाला तरी server crash होत नाही
        print(f"Webhook processing failed: {e}")

    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
