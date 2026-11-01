# providers/figma/models.py - Figma AI prompt + credit balance data model
"""
Two tables:

  FigmaPrompt           one row per prompt sent to Figma's AI agent, with the
                        credits Figma itself charged for it. Upserts on
                        user_action_uuid (Figma's own id for the prompt), so a
                        retried upload - or a prompt first reported as pending
                        and later with its credits - never double counts.

  FigmaBalanceSnapshot  the signed-in Figma account's AI credit bucket as Figma
                        reported it at a moment: monthly total / consumed /
                        remaining and today's. Lets the dashboard show what is
                        left and compare Figma's own "consumed" with the
                        prompts captured (credits spent outside a captured tab
                        - another browser, the desktop app - show as the gap).

The columns the credit report reads (owner_user_id, credential_id,
linked_task_name, linked_client_name, status, credits_used, prompt_text,
file_url, prompted_at, created_at) follow the other providers' names, so
utils/credit_report/facts.py reads this table like theirs.
"""
from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class FigmaPrompt(Base):
    __tablename__ = "figma_prompts"
    __table_args__ = (
        Index("ux_figma_prompts_user_action_uuid", "user_action_uuid", unique=True),
        Index("ix_figma_prompts_owner_prompted_at", "owner_user_id", "prompted_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="figma", index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    # The company Figma account the prompt was sent from.
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    # The person whose dashboard launch opened the tab.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # Figma's id for the prompt: message.clientId of POST /api/cortex/assistant/chat.
    user_action_uuid = Column(String(64), nullable=False)
    # x-cortex-request-uuid response header, for matching Figma support logs.
    request_uuid = Column(String(64))
    thread_id = Column(String(80), index=True)
    file_key = Column(String(64), index=True)
    file_name = Column(String(255))
    file_url = Column(Text)
    # userMessageOrigin, e.g. "assistant-thread".
    origin = Column(String(60))
    prompt_text = Column(Text)
    prompt_length = Column(Integer, nullable=False, default=0)

    status = Column(String(20), nullable=False, default="pending", index=True)
    # Figma's total_credit_usage / total_credit_cost for the prompt. Null until known.
    credits_used = Column(Float)
    credit_cost = Column(Float)
    # From the reply's usage-info event.
    tool_calls = Column(Integer)
    work_ms = Column(Integer)

    figma_user_id = Column(String(40), index=True)
    figma_email = Column(String(255))
    plan_id = Column(String(64), index=True)
    plan_tier = Column(String(40))

    prompted_at = Column(DateTime, nullable=False, index=True)
    finished_at = Column(DateTime)
    costed_at = Column(DateTime)
    extension_version = Column(String(40))
    tab_id = Column(Integer)
    page_url = Column(Text)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class FigmaBalanceSnapshot(Base):
    __tablename__ = "figma_balance_snapshots"
    __table_args__ = (
        Index("ix_figma_balance_figma_user_captured", "figma_user_id", "captured_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    # Who had the tab open when Figma reported it.
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    figma_user_id = Column(String(40), index=True)
    figma_email = Column(String(255))
    plan_id = Column(String(64), index=True)
    plan_tier = Column(String(40))

    period_start = Column(DateTime)
    period_end = Column(DateTime)
    monthly_total = Column(Float)
    monthly_consumed = Column(Float)
    monthly_remaining = Column(Float)
    daily_total = Column(Float)
    daily_consumed = Column(Float)

    captured_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "credentialId": self.credential_id,
            "ownerUserId": self.owner_user_id,
            "figmaUserId": self.figma_user_id,
            "figmaEmail": self.figma_email,
            "planId": self.plan_id,
            "planTier": self.plan_tier,
            "periodStart": serialize_utc_datetime(self.period_start),
            "periodEnd": serialize_utc_datetime(self.period_end),
            "monthlyTotal": self.monthly_total,
            "monthlyConsumed": self.monthly_consumed,
            "monthlyRemaining": self.monthly_remaining,
            "dailyTotal": self.daily_total,
            "dailyConsumed": self.daily_consumed,
            "capturedAt": serialize_utc_datetime(self.captured_at),
        }
