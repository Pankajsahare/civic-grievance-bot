import os
import json
import hashlib
import requests
import gspread
from datetime import datetime
from google.oauth2.service_account import Credentials
from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
SPREADSHEET_NAME = "Civic Grievances Tracker"
STATE_FILE = "sent_issues.json"
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")


def get_sheet():
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        return None
    creds = Credentials.from_service_account_info(json.loads(creds_json), scopes=scopes)
    gc = gspread.authorize(creds)
    try:
        sheet = gc.open(SPREADSHEET_NAME).sheet1
    except gspread.SpreadsheetNotFound:
        spreadsheet = gc.create(SPREADSHEET_NAME)
        sheet = spreadsheet.sheet1
        sheet.append_row(["Date", "Problem", "Authority", "Social Handles", "Drafted Message", "Status"])
    return sheet


def log_to_sheet(date_str, problem, authority, handles, message, status="Pending Approval"):
    sheet = get_sheet()
    if sheet:
        sheet.append_row([date_str, problem, authority, handles, message, status])


def load_sent_hashes():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return set(json.load(f))
    return set()


def save_sent_hash(issue_hash):
    sent = load_sent_hashes()
    sent.add(issue_hash)
    with open(STATE_FILE, "w") as f:
        json.dump(list(sent), f)


def send_telegram_alert(message):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram credentials missing.")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    keyboard = {
        "inline_keyboard": [
            [
                {"text": "✅ Approve & Send", "callback_data": "approve_action"},
                {"text": "❌ Reject", "callback_data": "reject_action"}
            ]
        ]
    }
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
        "reply_markup": json.dumps(keyboard)
    }
    requests.post(url, json=payload)


def analyze_and_notify():
    sample_news = "Nagpur Municipal Corporation fails to repair massive potholes near Bhande Square causing severe traffic jams."
    issue_hash = hashlib.md5(sample_news.encode()).hexdigest()
    if issue_hash in load_sent_hashes():
        print("Issue already processed.")
        return

    prompt = f"""
    Analyze the following Indian newspaper text/headlines and identify:
    1. The core civic or public problem.
    2. The concerned government department, official, or institute responsible.
    3. Their official social media handles (if known/publicly standard).
    4. A polite, constructive grievance message in English with a proposed solution.

    Input Text:
    {sample_news}
    """

    response = client.models.generate_content(
        model=MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.2,
            response_mime_type="application/json",
            response_schema={
                "type": "OBJECT",
                "properties": {
                    "problem": {"type": "STRING"},
                    "authority": {"type": "STRING"},
                    "social_handles": {"type": "STRING"},
                    "drafted_message": {"type": "STRING"}
                },
                "required": ["problem", "authority", "social_handles", "drafted_message"]
            }
        )
    )

    data = json.loads(response.text)
    formatted_msg = (
        f"🚨 *Civic Issue Detected*\n\n"
        f"*Problem:* {data['problem']}\n"
        f"*Authority:* {data['authority']} ({data['social_handles']})\n\n"
        f"*Drafted Message:*\n{data['drafted_message']}"
    )

    current_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_to_sheet(current_date, data['problem'], data['authority'], data['social_handles'], data['drafted_message'])
    send_telegram_alert(formatted_msg)
    save_sent_hash(issue_hash)


if __name__ == "__main__":
    analyze_and_notify()
