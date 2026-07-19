"""
Admin CRUD for credit -> currency rates (Tier 1 cost analytics).

Rates are keyed by Kling account (it_portal_tool_credentials.id): different
accounts buy credits at a different rupee price. Pricing is entered as a package
(credits bought for rupees); rate_per_credit is derived. A single global-default
row (credential_id/provider/tool_id all NULL) is the fallback used for generation
records that cannot be linked to an account.

All endpoints are admin-gated. Costing itself lives in reports_router; this router
only manages the rate rows the costing reads.
"""

from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, ITPortalToolCredential, ToolCreditRate, User
from utils.credential_crypto import decrypt_secret
from utils.permissions import require_admin

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


def _current_rate_row(db: Session, credential_id: Optional[int]) -> Optional[ToolCreditRate]:
    today = datetime.utcnow().date()
    q = db.query(ToolCreditRate).filter(
        ToolCreditRate.effective_from <= today,
        or_(ToolCreditRate.effective_to.is_(None), ToolCreditRate.effective_to >= today),
    )
    if credential_id is None:
        q = q.filter(
            ToolCreditRate.credential_id.is_(None),
            ToolCreditRate.provider.is_(None),
            ToolCreditRate.tool_id.is_(None),
        )
    else:
        q = q.filter(ToolCreditRate.credential_id == credential_id)
    return q.order_by(ToolCreditRate.effective_from.desc(), ToolCreditRate.id.desc()).first()


@router.get("")
def list_credit_rates(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    """List Kling accounts with their current effective rate, plus the global default."""
    global_row = _current_rate_row(db, None)

    credentials = (
        db.query(ITPortalToolCredential, ITPortalTool)
        .join(ITPortalTool, ITPortalToolCredential.tool_id == ITPortalTool.id)
        .filter(func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_SLUGS))
        .order_by(ITPortalToolCredential.id.asc())
        .all()
    )

    accounts = []
    for cred, tool in credentials:
        cur = _current_rate_row(db, cred.id)
        accounts.append({
            "credentialId": cred.id,
            "toolName": tool.name,
            "toolSlug": tool.slug,
            "label": _account_label(cred),
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
            raise HTTPException(status_code=404, detail="Kling account (credential) not found")
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == cred.tool_id).first()
        if not tool or (tool.slug or "").strip().lower() not in KLING_SLUGS:
            raise HTTPException(status_code=400, detail="Credential does not belong to a Kling tool")
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
