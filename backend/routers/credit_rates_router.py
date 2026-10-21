"""
Admin CRUD for credit -> currency rates (Tier 1 cost analytics).

Rates are keyed by tool account (it_portal_tool_credentials.id) across every
provider, not just Kling: different accounts buy credits at a different rupee
price. Pricing is entered as a package (credits bought for rupees);
rate_per_credit is derived. A single global-default row (credential_id/
provider/tool_id all NULL) is the fallback used for generation records that
cannot be linked to an account.

All endpoints are admin-gated. Costing itself lives in reports_router; this router
only manages the rate rows the costing reads.
"""

import json
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, ITPortalToolCredential, ITPortalToolUsageEvent, ToolCreditRate, User
from utils.credential_crypto import decrypt_secret
from utils.permissions import require_admin
from utils.tool_renewal_service import get_current_rate

router = APIRouter(prefix="/api/reports/credit-rates", tags=["Reports Admin"])

KLING_SLUGS = {"kling", "kling-ai", "klingai"}


class RateUpsertPayload(BaseModel):
    credentialId: Optional[int] = None  # None = global default
    packageCredits: float
    packageRupees: float
    currency: Optional[str] = "INR"
    effectiveFrom: Optional[date] = None
    notes: Optional[str] = None


def _account_label(cred: ITPortalToolCredential) -> str:
    identifier = decrypt_secret(cred.login_identifier_encrypted) if cred.login_identifier_encrypted else None
    return identifier or (cred.notes or "").strip() or f"Account #{cred.id}"


def _kling_account_label_map(db: Session) -> dict:
    """Resolve each Kling credential_id to its captured account label
    (``klingAccountLabel`` — usually the account email).

    The label is read in Python, not via a SQL ``->>`` extraction, because some
    captured metadata contains a NUL char (``\\u0000``) that Postgres cannot
    convert to text (it raises UntranslatableCharacter). DISTINCT ON keeps this
    to one (most-recent) metadata row per credential.
    """
    rows = (
        db.query(ITPortalToolUsageEvent.credential_id, ITPortalToolUsageEvent.metadata_json)
        .join(ITPortalTool, ITPortalToolUsageEvent.tool_id == ITPortalTool.id)
        .filter(
            func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_SLUGS),
            ITPortalToolUsageEvent.credential_id.isnot(None),
        )
        .order_by(ITPortalToolUsageEvent.credential_id, ITPortalToolUsageEvent.created_at.desc())
        .distinct(ITPortalToolUsageEvent.credential_id)
        .all()
    )
    label_map: dict = {}
    for cid, md in rows:
        if isinstance(md, str):
            try:
                md = json.loads(md)
            except Exception:
                md = None
        if isinstance(md, dict):
            label = md.get("klingAccountLabel")
            if label:
                label_map[cid] = label
    return label_map


def _current_rate_row(db: Session, credential_id: Optional[int]) -> Optional[ToolCreditRate]:
    # Shared with reports_router's costing and the Tool Renew admin API --
    # see utils/tool_renewal_service.get_current_rate.
    return get_current_rate(db, credential_id)


@router.get("")
def list_credit_rates(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    """List every tool account with its current effective rate, plus the global default."""
    global_row = _current_rate_row(db, None)
    label_map = _kling_account_label_map(db)  # real Kling account names from captured metadata

    credentials = (
        db.query(ITPortalToolCredential, ITPortalTool)
        .join(ITPortalTool, ITPortalToolCredential.tool_id == ITPortalTool.id)
        .filter(
            ITPortalToolCredential.scope == "company",
            ITPortalToolCredential.is_active == True,
        )
        .order_by(ITPortalTool.name.asc(), ITPortalToolCredential.id.asc())
        .all()
    )

    accounts = []
    for cred, tool in credentials:
        cur = _current_rate_row(db, cred.id)
        accounts.append({
            "credentialId": cred.id,
            "toolName": tool.name,
            "toolSlug": tool.slug,
            "label": label_map.get(cred.id) or _account_label(cred),
            "isActive": bool(cred.is_active),
            "currentRate": cur.to_dict() if cur else None,
        })

    return {
        "success": True,
        "currency": (global_row.currency if global_row else "INR"),
        "globalDefault": global_row.to_dict() if global_row else None,
        "accounts": accounts,
    }


@router.get("/history")
def rate_history(
    credentialId: Optional[int] = None,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    q = db.query(ToolCreditRate)
    if credentialId is not None:
        q = q.filter(ToolCreditRate.credential_id == credentialId)
    rows = q.order_by(ToolCreditRate.effective_from.desc(), ToolCreditRate.id.desc()).all()
    return {"success": True, "rates": [r.to_dict() for r in rows]}


@router.post("")
def upsert_credit_rate(
    payload: RateUpsertPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    """Add a rate for a Kling account (or the global default), superseding the prior open row.

    Pricing is entered as a package; rate_per_credit = packageRupees / packageCredits.
    """
    if payload.packageCredits is None or payload.packageCredits <= 0:
        raise HTTPException(status_code=400, detail="packageCredits must be greater than 0")
    if payload.packageRupees is None or payload.packageRupees < 0:
        raise HTTPException(status_code=400, detail="packageRupees must be 0 or greater")

    tool_id = None
    if payload.credentialId is not None:
        cred = (
            db.query(ITPortalToolCredential)
            .filter(ITPortalToolCredential.id == payload.credentialId)
            .first()
        )
        if not cred:
            raise HTTPException(status_code=404, detail="Tool account (credential) not found")
        tool_id = cred.tool_id

    effective_from = payload.effectiveFrom or datetime.utcnow().date()
    rate_per_credit = round(payload.packageRupees / payload.packageCredits, 4)
    currency = (payload.currency or "INR").strip().upper()[:8]

    # Close the prior open row for this key so only the new row is active going forward.
    open_q = db.query(ToolCreditRate).filter(ToolCreditRate.effective_to.is_(None))
    if payload.credentialId is None:
        open_q = open_q.filter(
            ToolCreditRate.credential_id.is_(None),
            ToolCreditRate.provider.is_(None),
            ToolCreditRate.tool_id.is_(None),
        )
    else:
        open_q = open_q.filter(ToolCreditRate.credential_id == payload.credentialId)
    for prior in open_q.all():
        prior.effective_to = effective_from - timedelta(days=1)

    row = ToolCreditRate(
        credential_id=payload.credentialId,
        provider=None,
        tool_id=tool_id,
        currency=currency,
        package_credits=payload.packageCredits,
        package_rupees=payload.packageRupees,
        rate_per_credit=rate_per_credit,
        effective_from=effective_from,
        effective_to=None,
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"success": True, "rate": row.to_dict()}


@router.delete("/{rate_id}")
def delete_credit_rate(
    rate_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    row = db.query(ToolCreditRate).filter(ToolCreditRate.id == rate_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Rate not found")
    db.delete(row)
    db.commit()
    return {"success": True, "deletedId": rate_id}


# --------------------------------------------------------------------------- #
# Fixed credits per generation (tools that never report a cost, e.g. Suno)
# --------------------------------------------------------------------------- #
class GenerationPricePayload(BaseModel):
    tool: str
    creditsPerGeneration: int
    effectiveFrom: date
    notes: Optional[str] = None


@router.get("/generation-prices")
def list_generation_prices(current_user: User = Depends(require_admin), db: Session = Depends(get_operational_db)):
    """Each priced tool with its current price, price history and generation counts."""
    from services import generation_pricing

    return {"success": True, "tools": generation_pricing.summary(db)}


@router.post("/generation-prices")
def set_generation_price(
    payload: GenerationPricePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    """Add a price from a date (or correct the one starting that day). Every
    generation from that date until the next price is re-stamped."""
    from services import generation_pricing

    try:
        row, stamped = generation_pricing.set_price(db, payload.tool, payload.creditsPerGeneration,
                                                    payload.effectiveFrom, (payload.notes or "").strip() or None,
                                                    current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return {"success": True, "priceId": row.id, "generationsUpdated": stamped,
            "tools": generation_pricing.summary(db)}


@router.delete("/generation-prices/{price_id}")
def delete_generation_price(
    price_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    """Remove a price; the price before it covers those dates again."""
    from services import generation_pricing

    try:
        tool, stamped = generation_pricing.delete_price(db, price_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Price not found")
    db.commit()
    return {"success": True, "deletedId": price_id, "tool": tool, "generationsUpdated": stamped,
            "tools": generation_pricing.summary(db)}


# --------------------------------------------------------------------------- #
# Flow: credits per output from a rate table x the account's plan
# --------------------------------------------------------------------------- #
class FlowRatePayload(BaseModel):
    model: str
    resolution: Optional[str] = None
    durationSeconds: Optional[int] = None
    creditsPlusPro: Optional[int] = None   # None = no price on that plan
    creditsUltra: Optional[int] = None
    effectiveFrom: date
    notes: Optional[str] = None


class FlowPlanPayload(BaseModel):
    credentialId: int
    plan: str                               # free | pro | ultra
    effectiveFrom: date
    notes: Optional[str] = None


def _flow_accounts(db: Session) -> list:
    """Flow logins a plan can be set on: the active company logins, plus any
    account that already has generations or a plan."""
    from providers.flow.constants import TOOL_SLUGS
    from providers.flow.models import FlowAccountPlan, FlowGeneration

    used = {cid for (cid,) in db.query(FlowGeneration.credential_id).distinct().all() if cid is not None}
    used |= {cid for (cid,) in db.query(FlowAccountPlan.credential_id).distinct().all()}
    creds = (db.query(ITPortalToolCredential)
             .join(ITPortalTool, ITPortalToolCredential.tool_id == ITPortalTool.id)
             .filter(func.lower(ITPortalTool.slug).in_(list(TOOL_SLUGS)))
             .order_by(ITPortalToolCredential.id).all())
    by_id = {c.id: c for c in creds}
    # A linked user credential's generations count toward its login.
    used = {by_id[cid].linked_credential_id or cid if cid in by_id else cid for cid in used}
    # The saved company logins (what the Assign Flow Credential dialog lists).
    # A personal record is often just a placeholder - no login, no link,
    # never used (e.g. #74) - so it only shows once it has generations or a plan.
    shown = [c for c in creds if (c.is_active and c.scope == "company") or c.id in used]
    # Personal accounts often have no login email saved - name them after
    # their owner instead of "Account #74"; and say who signs in through a
    # shared login, so an admin can tell the accounts apart.
    user_ids = {c.user_id for c in creds if c.user_id}
    names = {u.id: u.name or u.email for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    linked_users = {}
    for c in creds:
        if c.linked_credential_id and c.user_id in names:
            linked_users.setdefault(c.linked_credential_id, []).append(names[c.user_id])
    accounts = []
    for c in shown:
        label = _account_label(c)
        owner = names.get(c.user_id)
        if label == f"Account #{c.id}" and owner:
            label = f"{owner} (personal account)"
        accounts.append({
            "id": c.id,
            "label": label,
            "scope": c.scope,
            "active": bool(c.is_active),
            "ownerName": owner,
            "loginMethod": c.login_method,
            "linkedUserNames": sorted(linked_users.get(c.id, [])),
        })
    return accounts


def _flow_pricing_response(db: Session, **extra) -> dict:
    from providers.flow import pricing

    return {"success": True, **extra, **pricing.summary(db, _flow_accounts(db))}


@router.get("/flow")
def get_flow_pricing(current_user: User = Depends(require_admin), db: Session = Depends(get_operational_db)):
    """Flow's rate table, each account's plan, and what is still unpriced."""
    response = _flow_pricing_response(db)
    db.commit()  # keeps the first-use seed of the default rates
    return response


@router.post("/flow/rates")
def set_flow_rate(payload: FlowRatePayload, current_user: User = Depends(require_admin),
                  db: Session = Depends(get_operational_db)):
    """Add a rate from a date (or correct the one starting that day); every
    generation it covers is re-priced."""
    from providers.flow import pricing

    try:
        row, stamped = pricing.set_rate(
            db, model_name=payload.model, resolution=payload.resolution, duration_seconds=payload.durationSeconds,
            credits_plus_pro=payload.creditsPlusPro, credits_ultra=payload.creditsUltra,
            effective_from=payload.effectiveFrom, notes=(payload.notes or "").strip() or None,
            user_id=current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return _flow_pricing_response(db, rateId=row.id, generationsUpdated=stamped)


@router.delete("/flow/rates/{rate_id}")
def delete_flow_rate(rate_id: int, current_user: User = Depends(require_admin),
                     db: Session = Depends(get_operational_db)):
    from providers.flow import pricing

    try:
        stamped = pricing.delete_rate(db, rate_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Rate not found")
    db.commit()
    return _flow_pricing_response(db, deletedId=rate_id, generationsUpdated=stamped)


@router.post("/flow/plans")
def set_flow_plan(payload: FlowPlanPayload, current_user: User = Depends(require_admin),
                  db: Session = Depends(get_operational_db)):
    """Put a Flow account on a plan from a date; its generations (and those of
    users linked to it) from that date are re-priced."""
    from providers.flow import pricing

    if payload.credentialId not in {a["id"] for a in _flow_accounts(db)}:
        raise HTTPException(status_code=404, detail="Flow account not found")
    try:
        row, stamped = pricing.set_plan(db, payload.credentialId, (payload.plan or "").strip().lower(),
                                        payload.effectiveFrom, (payload.notes or "").strip() or None,
                                        current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return _flow_pricing_response(db, planId=row.id, generationsUpdated=stamped)


@router.delete("/flow/plans/{plan_id}")
def delete_flow_plan(plan_id: int, current_user: User = Depends(require_admin),
                     db: Session = Depends(get_operational_db)):
    from providers.flow import pricing

    try:
        stamped = pricing.delete_plan(db, plan_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Plan not found")
    db.commit()
    return _flow_pricing_response(db, deletedId=plan_id, generationsUpdated=stamped)
