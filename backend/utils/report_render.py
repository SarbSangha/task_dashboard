"""
Server-side renderer for Report Builder documents.

Mirrors the client template (reportTemplate.js) so the backend can render the same
branded report from a stored definition — for history downloads, exports and schedules.

Live-data blocks are rendered from a `snapshotItems` list that the client bakes into the
definition at save time (values as-of save, clearly the report's point-in-time snapshot).
"""

import html
from datetime import datetime


def _esc(s):
    return html.escape("" if s is None else str(s))


def _kpi_cards(items):
    cells = "".join(
        f'<div class="kpi"><div class="kpi-value">{_esc(it.get("value"))}</div>'
        f'<div class="kpi-label">{_esc(it.get("label"))}</div></div>'
        for it in (items or [])
        if it.get("label") or it.get("value")
    )
    return f'<div class="kpis">{cells}</div>' if cells else '<p class="muted">No metrics.</p>'


def _section_head(n, title):
    return f'<h2 class="sec"><span class="sec-n">{n}.</span> {_esc(title)}</h2>'


_LIVE_TITLES = {
    "live-exec": "Executive Performance Metrics",
    "live-kling": "Kling Video Intelligence",
    "live-cost": "Cost Intelligence",
}


def _block_html(block, idx):
    n = idx + 1
    kind = block.get("kind")
    if kind == "question":
        why = block.get("why")
        metric = block.get("metric")
        decision = block.get("decision")
        meta = ""
        if metric:
            meta += f'<div class="qmeta-item"><span class="qmeta-lab">Metric</span><span class="qmeta-val">{_esc(metric)}</span></div>'
        if decision:
            meta += f'<div class="qmeta-item"><span class="qmeta-lab">Decision</span><span class="qmeta-val">{_esc(decision)}</span></div>'
        why_html = f'<p class="lead"><strong>Why it matters:</strong> {_esc(why)}</p>' if why else ""
        return f'<section class="block">{_section_head(n, block.get("q"))}{why_html}<div class="qmeta">{meta}</div></section>'
    if kind == "text":
        body = _esc(block.get("body")).replace("\n", "<br>")
        return f'<section class="block">{_section_head(n, block.get("heading") or "Narrative")}<p class="body">{body}</p></section>'
    if kind == "kpis":
        return f'<section class="block">{_section_head(n, block.get("heading") or "Performance Metrics")}{_kpi_cards(block.get("items"))}</section>'
    if kind in _LIVE_TITLES:
        items = block.get("snapshotItems")
        inner = _kpi_cards(items) if items else '<p class="muted">Live data snapshot not stored — regenerate from the Report Builder.</p>'
        return f'<section class="block">{_section_head(n, _LIVE_TITLES[kind])}{inner}</section>'
    if kind == "table":
        cols = block.get("columns") or ["Project Phase", "Target Date", "Allocation", "Status"]
        thead = "".join(f"<th>{_esc(c)}</th>" for c in cols)
        rows = ""
        for row in block.get("rows") or []:
            rows += "<tr>" + "".join(f"<td>{_esc(row[ci] if ci < len(row) else '')}</td>" for ci in range(len(cols))) + "</tr>"
        return (
            f'<section class="block">{_section_head(n, block.get("title") or "Structural Overview & Projections")}'
            f'<table class="tbl"><thead><tr>{thead}</tr></thead><tbody>{rows}</tbody></table></section>'
        )
    return ""


def build_html(definition):
    definition = definition or {}
    branding = definition.get("branding") or {}
    blocks = definition.get("blocks") or []

    navy = branding.get("navy") or "#101f3f"
    gold = branding.get("gold") or "#c99a2e"
    brand = branding.get("brandName") or "RITZ MEDIA WORLD"
    year = datetime.utcnow().year
    parts = brand.split(" ")
    wordmark = (f'{" ".join(parts[:-1])} <strong>{_esc(parts[-1])}</strong>' if len(parts) > 1 else f"<strong>{_esc(brand)}</strong>")

    logo = branding.get("logo")
    if logo:
        logo_html = f'<img class="logo-img" src="{_esc(logo)}" alt="logo">'
    else:
        mark = "".join(c for c in brand if c.isalpha())[:2].upper() or "R"
        logo_html = f'<div class="logo-mark">{_esc(mark)}</div>'

    body = "\n".join(_block_html(b, i) for i, b in enumerate(blocks))

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>{_esc(branding.get('title') or 'Corporate Report')}</title>
<style>
  :root{{ --navy:{navy}; --gold:{gold}; --grey:#f4f6f8; }}
  *{{ box-sizing:border-box; }}
  html,body{{ margin:0; padding:0; background:#fff; color:#1c2634;
    font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }}
  .content{{ padding:20mm 18mm 24mm; }}
  .cover{{ page-break-after:always; }}
  .cover-bar{{ height:16px; background:var(--gold); }}
  .cover-hero{{ background:var(--navy); color:#fff; padding:34mm 18mm 30mm; }}
  .cover-brand{{ display:flex; align-items:center; gap:14px; }}
  .logo-img{{ width:56px; height:56px; object-fit:contain; background:#ffffff1a; border-radius:8px; }}
  .logo-mark{{ width:52px; height:52px; border-radius:10px; display:flex; align-items:center; justify-content:center;
    background:var(--gold); color:var(--navy); font-weight:800; font-size:20px; }}
  .cover-wordmark{{ font-size:19px; letter-spacing:.18em; text-transform:uppercase; color:#e9edf5; }}
  .cover-wordmark strong{{ color:var(--gold); }}
  .cover-title-wrap{{ padding:26mm 18mm 0; }}
  .cover-title{{ font-size:40px; line-height:1.1; font-weight:800; color:var(--navy); margin:0 0 14px; max-width:16ch; }}
  .cover-sub{{ font-size:17px; letter-spacing:.14em; text-transform:uppercase; color:var(--gold); font-weight:600; margin:0; }}
  .cover-meta{{ margin:70mm 18mm 0; padding-top:16px; border-top:1px solid #d5dbe4;
    display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; font-size:13px; color:#5a6675; }}
  .cover-meta b{{ color:#1c2634; }}
  h2.sec{{ font-size:20px; color:var(--navy); margin:0 0 8px; padding-bottom:8px; border-bottom:2px solid var(--gold); }}
  h2.sec .sec-n{{ color:var(--gold); }}
  .block{{ margin:0 0 22px; break-inside:avoid; }}
  p.lead{{ background:var(--grey); border-left:4px solid var(--gold); padding:12px 14px; font-size:13.5px; margin:12px 0; border-radius:0 6px 6px 0; }}
  p.body{{ font-size:13.5px; line-height:1.6; }}
  p.muted{{ font-size:13px; color:#8a95a4; }}
  .qmeta{{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:6px; }}
  .qmeta-item{{ border:1px solid #e3e8ee; border-left:3px solid var(--gold); border-radius:6px; padding:9px 12px; }}
  .qmeta-lab{{ display:block; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#8a95a4; font-weight:700; }}
  .qmeta-val{{ font-size:13px; color:#1c2634; }}
  .kpis{{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:8px 0; }}
  .kpi{{ background:var(--navy); border-radius:8px; padding:22px 14px; text-align:center; }}
  .kpi-value{{ font-size:30px; font-weight:800; color:var(--gold); line-height:1; }}
  .kpi-label{{ margin-top:8px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#c4ccd8; }}
  table.tbl{{ width:100%; border-collapse:collapse; font-size:13px; }}
  table.tbl th{{ background:var(--navy); color:#fff; text-align:left; padding:11px 14px; }}
  table.tbl td{{ padding:11px 14px; border-bottom:1px solid #e6eaf0; }}
  table.tbl tbody tr:nth-child(even){{ background:var(--grey); }}
  .docfoot{{ margin-top:10mm; padding-top:10px; border-top:1px solid #e0e5ec; font-size:11px; color:#8a95a4;
    display:flex; justify-content:space-between; }}
  @page{{ size:A4; margin:0; }}
</style></head>
<body>
  <div class="cover">
    <div class="cover-bar"></div>
    <div class="cover-hero"><div class="cover-brand">{logo_html}<span class="cover-wordmark">{wordmark}</span></div></div>
    <div class="cover-title-wrap">
      <h1 class="cover-title">{_esc(branding.get('title') or 'Corporate Performance & Strategic Growth Report')}</h1>
      <p class="cover-sub">{_esc(branding.get('subtitle') or 'AI Intelligence Report')}</p>
    </div>
    <div class="cover-meta">
      <span>Prepared For: <b>{_esc(branding.get('preparedFor') or 'Executive Board')}</b></span>
      <span>Date: <b>{_esc(branding.get('date') or datetime.utcnow().strftime('%Y-%m-%d'))}</b></span>
      <span>Prepared By: <b>{_esc(branding.get('preparedBy') or 'Analytics & BI Office')}</b></span>
      <span>Document ID: <b>{_esc(branding.get('docId') or f'RMW-{year}-AI01')}</b></span>
    </div>
  </div>
  <div class="content">
    {body or '<p class="muted">This report has no content blocks.</p>'}
    <div class="docfoot"><span>{_esc(brand)} © {year} | {_esc(branding.get('confidential') or 'Confidential')}</span><span>AI Intelligence Report</span></div>
  </div>
</body></html>"""
