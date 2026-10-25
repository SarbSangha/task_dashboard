"""OTP picking from a shared inbox (services/otp_mail_service.py, ChatGPT defaults).

Run from backend/:  python tests/otp_pick_smoke.py

A fake Gmail inbox that answers every search with every email (the worst
case: the search widened to "anything recent"), so the per-email checks do
all the work. Checks:
  * ChatGPT: the fresh login code wins over the "New sign-in" alert (a date,
    so the year 2026), a code from before the launch, a code sent to another
    account, and unrelated mail with numbers in it;
  * nothing usable -> None (not a wrong code);
  * default pattern (other tools): a year in a footer is never a code, a
    4-digit code right after "code" still is;
  * _apply_otp_tool_defaults fills ChatGPT's filters only where the admin
    left the defaults.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import services.otp_mail_service as S  # noqa: E402
from routers.it_tools_router import DEFAULT_OTP_REGEX, _apply_otp_tool_defaults  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


NOW = datetime.now(timezone.utc)
LAUNCH = NOW - timedelta(seconds=40)


def mail(uid, sender, to, subject, body, age_s):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = sender, to, subject
    msg.set_content(body)
    return uid, NOW - timedelta(seconds=age_s), msg.as_bytes()


class FakeInbox:
    messages = []

    def __init__(self, *_a):
        pass

    def login(self, *_a):
        return "OK", []

    def select(self, *_a, **_k):
        return "OK", []

    def logout(self):
        return "OK", []

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [b" ".join(str(u).encode() for u, _d, _r in self.messages)]
        uid = int(args[0])
        for u, when, raw in self.messages:
            if u == uid:
                date = when.strftime("%d-%b-%Y %H:%M:%S +0000")
                return "OK", [(f'1 (UID {u} INTERNALDATE "{date}")'.encode(), raw)]
        return "NO", []


S.imaplib.IMAP4_SSL = FakeInbox

OPENAI = "ChatGPT <noreply@tm.openai.com>"
TOOLS = "tools@ritzmediaworld.com"


def fetch(entry, recipient=TOOLS, not_before=LAUNCH):
    return S.fetch_otp_from_gmail(TOOLS, "pw", entry["otp_regex"], entry.get("otp_sender_filter"),
                                  entry.get("otp_subject_pattern"), 120, 75, 0, 1, not_before, None,
                                  otp_recipient=entry.get("otp_recipient"))


chatgpt = _apply_otp_tool_defaults({"email_address": TOOLS, "otp_regex": DEFAULT_OTP_REGEX}, "chatgpt", TOOLS)
check(chatgpt["otp_sender_filter"] == "openai.com" and chatgpt["otp_subject_pattern"] == "code"
      and chatgpt["otp_regex"] == r"\b(\d{6})\b" and chatgpt["otp_recipient"] == TOOLS,
      "ChatGPT defaults: openai.com sender, 'code' subject, 6 digits, addressed to the login")
custom = _apply_otp_tool_defaults({"email_address": TOOLS, "otp_sender_filter": "x.com", "otp_regex": r"(\d{5})"},
                                  "chatgpt", TOOLS)
check(custom["otp_sender_filter"] == "x.com" and custom["otp_regex"] == r"(\d{5})", "an admin's own settings win")
check(_apply_otp_tool_defaults({"otp_regex": DEFAULT_OTP_REGEX}, "canva", "a@b.c") == {"otp_regex": DEFAULT_OTP_REGEX},
      "other tools are left as configured")

FakeInbox.messages = [
    mail(1, OPENAI, TOOLS, "Your temporary ChatGPT login code", "Enter this code: 111111", 90),        # before launch
    mail(2, OPENAI, TOOLS, "Your temporary ChatGPT login code", "Enter this code: 482913", 20),        # the one
    mail(3, OPENAI, "rmweye@contenaissance.com", "Your temporary ChatGPT login code", "Code 999999", 10),  # other account
    mail(4, "OpenAI <noreply@tm.openai.com>", TOOLS, "New sign-in to your OpenAI account",
         "We noticed a new sign-in on October 25, 2026 from Delhi.", 5),                           # the "2026" email
    mail(5, "Pinterest <recommendations@explore.pinterest.com>", TOOLS, "Ideas for you", "Pin 54321 and 123456", 2),
]
check(fetch(chatgpt) == "482913", "ChatGPT gets the fresh code, not 2026 / an old code / another account's / noise")

FakeInbox.messages = [m for m in FakeInbox.messages if m[0] != 2]
check(fetch(chatgpt) is None, "no fresh code for this login -> nothing, never a wrong one")

FakeInbox.messages = [mail(2, OPENAI, TOOLS, "Your temporary ChatGPT login code", "Enter this code: 482913", 20)]
check(fetch(chatgpt, not_before=NOW - timedelta(seconds=5)) is None, "a code from before the launch is not used")

plain = {"otp_regex": DEFAULT_OTP_REGEX}
FakeInbox.messages = [mail(1, "Canva <no-reply@canva.com>", TOOLS, "Welcome", "© 2026 Canva. All rights reserved.", 5)]
check(fetch(plain) is None, "default pattern: a footer year is not a code")
FakeInbox.messages = [mail(1, "Canva <no-reply@canva.com>", TOOLS, "Your code", "Your Canva code is 2025\n© 2026 Canva", 5)]
check(fetch(plain) == "2025", "default pattern: a 4-digit code right after 'code' still counts")
FakeInbox.messages = [mail(1, "Canva <no-reply@canva.com>", TOOLS, "Sign in", "October 25, 2026 - your code: 739104", 5)]
check(fetch(plain) == "739104", "default pattern: skips the date's year, takes the real code")
print("\nALL OTP PICK CHECKS PASSED")
