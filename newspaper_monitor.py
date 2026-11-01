import hashlib
import json
import os
from datetime import datetime

import gspread
import requests
from google import genai
from google.oauth2.service_account import Credentials
from google.genai import types

# ----------------------------
# Environment configuration
# ----------------------------
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
# इथे 'gemini-3.8-flash' अपडेट केले आहे
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.8-flash"
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON")

SPREADSHEET_NAME = "Civic Grievances Tracker"
STATE_FILE = "sent_issues.json"

client = genai.Client(api_key=GEMINI_API_KEY)

# ----------------------------
# Utilities
# ----------------------------
def load_sent_hashes():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return set(data) if isinstance(data, list) else set()
        except (json.JSONDecodeError, TypeError):
            return set()
    return set()

def save_sent_hash(issue_hash):
    sent = load_sent_hashes()
    sent.add(issue_hash)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(list(sent)), f, ensure_ascii=False)

def get_sheet():
    if not GOOGLE_CREDENTIALS_JSON:
        print("Google credentials missing.")
        return None

    try:
        creds = Credentials.from_service_account_info(
            json.loads(GOOGLE_CREDENTIALS_JSON),
            scopes=[
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/drive",
            ],
        )
    except Exception as e:
        print(f"Invalid Google credentials: {e}")
        return None

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
        print("Successfully logged to Google Sheet.")

def send_telegram_alert(message):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram credentials missing.")
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    keyboard = {
        "inline_keyboard": [
            [
                {"text": "✅ Approve & Send", "callback_data": "approve_action"},
                {"text": "❌ Reject", "callback_data": "reject_action"},
            ]
        ]
    }

    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
        "reply_markup": json.dumps(keyboard),
    }

    try:
        response = requests.post(url, json=payload, timeout=20)
        response.raise_for_status()
        print("Successfully sent Telegram alert.")
    except requests.RequestException as e:
        print(f"Telegram send failed: {e}")

# ----------------------------
# Gemini content generation
# ----------------------------
def generate_grievance_payload(sample_news):
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is missing.")

    prompt = f"""
    Analyze the following Indian newspaper text/headlines and identify:
    1. The core civic or public problem.
    2. The concerned government department, official, or institute responsible.
    3. Their official social media handles (if known/publicly standard).
    4. A polite, constructive grievance message in English with a proposed solution.

    Input Text:
    {sample_news}
    """

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
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
                        "drafted_message": {"type": "STRING"},
                    },
                    "required": ["problem", "authority", "social_handles", "drafted_message"],
                },
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    try:
        payload = json.loads(response.text)
    except Exception as e:
        raise RuntimeError(f"Unable to parse Gemini response: {e}") from e

    if not isinstance(payload, dict):
        raise RuntimeError("Gemini response is not a JSON object.")

    required = ["problem", "authority", "social_handles", "drafted_message"]
    missing = [k for k in required if k not in payload or payload[k] is None]
    if missing:
        raise RuntimeError(f"Gemini response missing required keys: {missing}")

    return payload

# ----------------------------
# Main logic
# ----------------------------
def analyze_and_notify():
    sample_news = (
        "Nagpur Municipal Corporation fails to repair massive potholes near Bhande Square "
        "causing severe traffic jams."
    )

    issue_hash = hashlib.md5(sample_news.encode("utf-8")).hexdigest()
    if issue_hash in load_sent_hashes():
        print("Issue already processed.")
        return

    try:
        data = generate_grievance_payload(sample_news)
    except Exception as e:
        print(f"Failed to generate grievance: {e}")
        return

    formatted_msg = (
        f"🚨 *Civic Issue Detected*\n\n"
        f"*Problem:* {data['problem']}\n"
        f"*Authority:* {data['authority']} ({data['social_handles']})\n\n"
        f"*Drafted Message:*\n{data['drafted_message']}"
    )

    current_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_to_sheet(
        current_date,
        data["problem"],
        data["authority"],
        data["social_handles"],
        data["drafted_message"],
    )
    send_telegram_alert(formatted_msg)
    save_sent_hash(issue_hash)

if __name__ == "__main__":
    analyze_and_notify()
