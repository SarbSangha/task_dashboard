"""
One-off repair for HeyGen cards stored before the 2026-11-01 capture fixes
(see providers/heygen/normalization.py). Uses only data already captured:

  - credits: a completed video whose credit_ledger_row event is stored but
    was skipped (ledger batch normalized before the listing batch committed).
  - prompt: a listing row whose spoken script is in extra_speech_meta.script.
  - drafts / Video Agent sessions: archived (archived_at set, reversible),
    since they are not rendered videos and only showed as empty cards.

Higgsfield, same pass (see providers/higgsfield/normalization.py):

  - Unlimited-mode jobs (params.use_unlim) get credits_used = 0.
  - project/story folder rows are archived.

Dry run by default; pass --apply to write. Prints every id it touches.
"""
import sys
from datetime import datetime

from database_config import OperationalSessionLocal
from models_new import GenerationRecord
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from providers.higgsfield.normalization import _is_project_container_row
from providers.higgsfield.normalization import _project_into_generation_record as _project_higgsfield
from providers.heygen.normalization import (
    _extract_fields,
    _is_other_videos_file,
    _is_unrendered_listing_row,
    _project_into_generation_record,
    _stored_ledger_credits,
)


def main(apply: bool) -> None:
    db = OperationalSessionLocal()
    try:
        gens = db.query(HeygenGeneration).filter(HeygenGeneration.archived_at.is_(None)).all()
        credits_fixed, prompts_fixed, archived, wrong_files = [], [], [], []
        now = datetime.utcnow()
        for gen in gens:
            meta = gen.metadata_json or {}
            if _is_unrendered_listing_row(meta) and not (gen.video_url or gen.download_url):
                archived.append(gen.id)
                gen.archived_at = now
                if gen.generation_record_id:
                    record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).first()
                    if record and record.archived_at is None:
                        record.archived_at = now
                continue
            changed = False
            for col in ("video_url", "download_url", "preview_url"):
                if _is_other_videos_file(getattr(gen, col), gen.video_id):
                    wrong_files.append((gen.id, col))
                    setattr(gen, col, None)
                    changed = True
            if gen.credits_used is None:
                credits = _stored_ledger_credits(db, gen)
                if credits is not None:
                    gen.credits_used = credits
                    credits_fixed.append((gen.id, credits))
                    changed = True
            if not gen.script_text:
                script = _extract_fields(meta)["script_text"]
                if script:
                    gen.script_text = script
                    gen.prompt_length = len(script)
                    prompts_fixed.append(gen.id)
                    changed = True
            if changed:
                _project_into_generation_record(db, gen)

        print(f"HeyGen credits filled: {len(credits_fixed)} {credits_fixed}")
        print(f"HeyGen prompts filled: {len(prompts_fixed)} {prompts_fixed}")
        print(f"HeyGen archived drafts/sessions: {len(archived)} {archived}")
        print(f"HeyGen wrong video files cleared: {len(wrong_files)} {wrong_files}")

        unlimited, folders = [], []
        for gen in db.query(HiggsfieldGeneration).filter(HiggsfieldGeneration.archived_at.is_(None)).all():
            meta = gen.metadata_json or {}
            if _is_project_container_row(meta):
                folders.append(gen.id)
                gen.archived_at = now
                if gen.generation_record_id:
                    record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).first()
                    if record and record.archived_at is None:
                        record.archived_at = now
            elif gen.credits_used is None and (meta.get("params") or {}).get("use_unlim") is True:
                unlimited.append(gen.id)
                gen.credits_used = 0.0
                _project_higgsfield(db, gen)
        print(f"Higgsfield unlimited jobs set to 0 credits: {len(unlimited)} {unlimited}")
        print(f"Higgsfield archived project folders: {len(folders)} {folders}")
        if apply:
            db.commit()
            print("applied")
        else:
            db.rollback()
            print("dry run - nothing written (pass --apply)")
    finally:
        db.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
