"""
Credit Consumption Report - display names, exclusions and budgets.

The database keeps names exactly as people typed them ("ishansh",
"CONTENT CREATOR", a client called "Applicant"). The report shows clean
names instead, decided here and only here:

* config/credit_report_display.json maps clients and departments
  (case-insensitive) and lists accounts to leave out of the management view;
* config/ai_budgets.json holds optional monthly budgets.

Client and department mapping happens inside the SQL (client_sql /
department_sql), so every GROUP BY, filter and the log's row order see the
clean name; person names are cleaned in Python (person_name), keyed by id.
Nothing here writes to the database.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import String, case, cast, func, literal

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DISPLAY_CONFIG_ENV = "CREDIT_REPORT_DISPLAY_CONFIG"
BUDGETS_CONFIG_ENV = "CREDIT_REPORT_BUDGETS"
DEFAULT_DISPLAY_PATH = os.path.join(BACKEND_DIR, "config", "credit_report_display.json")
DEFAULT_BUDGETS_PATH = os.path.join(BACKEND_DIR, "config", "ai_budgets.json")


def _key(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    return data if isinstance(data, dict) else {}


@dataclass
class DisplayConfig:
    user_names: dict = field(default_factory=dict)          # user id -> name
    department_names: dict = field(default_factory=dict)    # lower key -> name
    keep_upper: set = field(default_factory=set)            # words kept in capitals ("SEO")
    client_names: dict = field(default_factory=dict)        # lower key -> name, or None = "No client"
    internal_clients: set = field(default_factory=set)      # display names of our own work
    exclude_user_ids: set = field(default_factory=set)
    exclude_emails: set = field(default_factory=set)
    exclude_departments: set = field(default_factory=set)   # lower keys of raw department names
    account_labels: dict = field(default_factory=dict)      # account id -> label
    account_logins: dict = field(default_factory=dict)      # account id -> login email (facts.load_account_logins)
    free_preview_models: dict = field(default_factory=dict) # tool -> [model ids]
    low_use_rupees_per_item: float = 40.0
    billing: dict = field(default_factory=dict)             # account id -> "monthly" | "annual"
    billing_unconfirmed: set = field(default_factory=set)   # account ids whose fee frequency is being checked
    confirmed_billed: set = field(default_factory=set)      # renewal date passed, but confirmed still billed
    untracked_ai_tools: list = field(default_factory=list)  # AI tools paid for whose usage is not captured

    @classmethod
    def load(cls, path: Optional[str] = None) -> "DisplayConfig":
        raw = _read_json(path or os.getenv(DISPLAY_CONFIG_ENV) or DEFAULT_DISPLAY_PATH)
        users = (raw.get("users") or {}).get("rename") or {}
        depts = raw.get("departments") or {}
        clients = raw.get("clients") or {}
        exclude = raw.get("exclude") or {}
        subs = raw.get("subscriptions") or {}
        return cls(
            user_names={int(k): str(v) for k, v in users.items() if str(k).isdigit() and v},
            department_names={_key(k): str(v) for k, v in (depts.get("rename") or {}).items() if v},
            keep_upper={str(w).upper() for w in depts.get("keep_upper") or []},
            client_names={_key(k): (str(v) if v else None) for k, v in (clients.get("rename") or {}).items()},
            internal_clients={str(c) for c in clients.get("internal") or []},
            exclude_user_ids={int(x) for x in exclude.get("user_ids") or [] if str(x).isdigit()},
            exclude_emails={_key(x) for x in exclude.get("emails") or [] if x},
            exclude_departments={_key(x) for x in exclude.get("departments") or [] if x},
            account_labels={int(k): str(v) for k, v in ((raw.get("accounts") or {}).get("labels") or {}).items()
                            if str(k).isdigit() and v},
            free_preview_models={str(k): [str(m) for m in v or []]
                                 for k, v in (raw.get("free_preview_models") or {}).items()},
            low_use_rupees_per_item=float(subs.get("low_use_rupees_per_item") or 40.0),
            billing={int(k): str(v).lower() for k, v in (subs.get("billing") or {}).items() if str(k).isdigit()},
            billing_unconfirmed={int(x) for x in subs.get("billing_unconfirmed") or [] if str(x).isdigit()},
            confirmed_billed={int(x) for x in subs.get("confirmed_billed") or [] if str(x).isdigit()},
            untracked_ai_tools=[str(t) for t in subs.get("untracked_ai_tools") or [] if t],
        )

    # ------------------------------------------------------------------ #
    # Names
    # ------------------------------------------------------------------ #
    def person_name(self, user_id: Optional[int], raw: Optional[str]) -> str:
        """'ishansh' -> 'Ishansh', 'Kushi saini' -> 'Kushi Saini', 'NEHA' -> 'Neha'.
        A name that already mixes cases keeps its other letters ('McKay')."""
        if user_id in self.user_names:
            return self.user_names[user_id]
        name = re.sub(r"\s+", " ", (raw or "").strip())
        if not name:
            return name
        if name == name.upper() and any(ch.isalpha() for ch in name):
            name = name.lower()
        return " ".join(w[:1].upper() + w[1:] if w[:1].islower() else w for w in name.split(" "))

    def department_name(self, raw: Optional[str]) -> Optional[str]:
        """Configured name, else Title Case for an ALL-CAPS name ('GEN AI' -> 'Gen AI').
        None for a blank department."""
        text = re.sub(r"\s+", " ", (raw or "").strip())
        if not text:
            return None
        if _key(text) in self.department_names:
            return self.department_names[_key(text)]
        if text != text.upper():
            return text
        return " ".join(w if w.upper() in self.keep_upper else w.capitalize() for w in text.split(" "))

    def client_name(self, raw: Optional[str]) -> Optional[str]:
        """Configured name; None = no client (blank, or a placeholder such as 'Applicant')."""
        text = re.sub(r"\s+", " ", (raw or "").strip())
        if not text:
            return None
        return self.client_names.get(_key(text), text)

    def is_internal(self, client: Optional[str]) -> bool:
        return bool(client) and client in self.internal_clients

    def account_label(self, account_id: Optional[int], tool: str) -> str:
        if account_id is None:
            return f"{tool} (account not recorded)"
        account_id = int(account_id)
        return self.account_labels.get(account_id) or self.account_logins.get(account_id) or f"{tool} #{account_id}"

    def is_free_preview(self, tool: str, model_id: Optional[str]) -> bool:
        return bool(model_id) and model_id in self.free_preview_models.get(tool, [])

    # ------------------------------------------------------------------ #
    # SQL
    # ------------------------------------------------------------------ #
    def client_sql(self, col):
        """The clean client name in SQL; NULL = no client."""
        trimmed = func.nullif(func.trim(col), "")
        whens = [(func.lower(func.trim(col)) == k, literal(v, String) if v else cast(literal(None), String))
                 for k, v in self.client_names.items()]
        return case(*whens, else_=trimmed) if whens else trimmed

    def department_sql(self, col, raw_values, *, blank: str):
        """CASE mapping each raw department (as stored) to its display name;
        a blank or missing department becomes `blank`."""
        trimmed = func.nullif(func.trim(col), "")
        whens = []
        for raw in sorted({r for r in raw_values if (r or "").strip()}):
            shown = self.department_name(raw)
            if shown != raw.strip():
                whens.append((func.trim(col) == raw.strip(), literal(shown, String)))
        mapped = case(*whens, else_=trimmed) if whens else trimmed
        return func.coalesce(mapped, blank)


@dataclass
class Budgets:
    total: Optional[float] = None
    departments: dict = field(default_factory=dict)
    tools: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Budgets":
        raw = _read_json(path or os.getenv(BUDGETS_CONFIG_ENV) or DEFAULT_BUDGETS_PATH)

        def money(v):
            try:
                return float(v) if v not in (None, "") else None
            except (TypeError, ValueError):
                return None

        return cls(
            total=money(raw.get("total")),
            departments={str(k): money(v) for k, v in (raw.get("departments") or {}).items() if money(v)},
            tools={str(k): money(v) for k, v in (raw.get("tools") or {}).items() if money(v)},
        )

    @property
    def any(self) -> bool:
        return bool(self.total or self.departments or self.tools)
