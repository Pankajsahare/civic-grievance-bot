import os
import json
import requests
from flask import Flask, request, jsonify
import gspread
from google.oauth2.service_account import Credentials

app = Flask(__name__)
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
SPREADSHEET_NAME = "Civic Grievances Tracker"
STATUS_COLUMN = 6  # "Status" column क्रमांक (A=1 पासून मोजून)

def get_sheet():
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open(SPREADSHEET_NAME).sheet1

@app.route(f"/{TELEGRAM_BOT_TOKEN}", methods=["POST"])
def telegram_webhook():
    try:
        update = request.get_json()
        if "callback_query" in update:
            callback = update["callback_query"]
            chat_id = callback["message"]["chat"]["id"]
            message_id = callback["message"]["message_id"]
            raw_data = callback["data"]  # उदा. "approve:<issue_hash>" किंवा "reject:<issue_hash>"

            # S3 fix: generic text शोधण्याऐवजी नेमक्या issue_hash वरून row ओळखतो
            action, _, issue_hash = raw_data.partition(":")
            status_text = "Approved & Sent" if action == "approve" else "Rejected"

            sheet = get_sheet()
            cell = sheet.find(issue_hash) if issue_hash else None
            if cell:
                sheet.update_cell(cell.row, STATUS_COLUMN, status_text)
            else:
                print(f"IssueID not found in sheet: {issue_hash}")

            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/answerCallbackQuery",
                json={"callback_query_id": callback["id"]},
                timeout=10,
            )
            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/editMessageText",
                json={
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": f"{callback['message']['text']}\n\n*Status:* {status_text}",
                    "parse_mode": "Markdown",
                },
                timeout=10,
            )
    except Exception as e:
        # S5: एखादा call fail झाला तरी server crash होणार नाही, फक्त log होईल
        print(f"Webhook processing failed: {e}")

    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
