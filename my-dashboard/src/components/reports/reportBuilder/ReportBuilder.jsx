import React, { useEffect, useMemo, useRef, useState } from 'react';
import { reportsAPI, downloadBlobResponse } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import { REPORT_QUESTIONS, QUESTION_CATEGORIES, READINESS_META, ANSWER_BINDINGS, resolveAnswerItems, resolveAnswerTable, answerApiFor } from './reportQuestions';
import { buildReportHtml, liveSnapshotItems } from './reportTemplate';
import './ReportBuilder.css';

const uid = () => `b${Math.random().toString(36).slice(2, 9)}`;
const todayISO = () => new Date().toISOString().slice(0, 10);

const BLOCK_LIBRARY = [
  { kind: 'live-exec', title: 'Executive KPIs', desc: 'Live active users, generations, adoption, cost', live: true },
  { kind: 'live-kling', title: 'Kling Summary', desc: 'Live videos, creators, success, credits', live: true },
  { kind: 'live-chatgpt', title: 'ChatGPT Summary', desc: 'Live conversations, prompts, responses, users', live: true },
  { kind: 'live-cost', title: 'Cost Summary', desc: 'Live credits, cost/output, waste', live: true },
  { kind: 'live-users', title: 'User Summary', desc: 'Live active users, DAU/WAU/MAU, sessions', live: true },
  { kind: 'live-tasks', title: 'Task Summary', desc: 'Live completed, completion rate, cycle time, on-time', live: true },
  { kind: 'live-prompts', title: 'Prompt Summary', desc: 'Live prompts, unique, success, reuse, length', live: true },
  { kind: 'kpis', title: 'Custom KPI Cards', desc: 'Three editable metric cards' },
  { kind: 'text', title: 'Narrative / Text', desc: 'A written section' },
  { kind: 'table', title: 'Milestone Table', desc: 'Editable phase / allocation table' },
];

const defaultPayload = (kind, extra) => {
  if (kind === 'kpis') return { heading: 'Performance Metrics', items: [{ label: 'Media Reach', value: '+42%' }, { label: 'Engagement', value: '1.2M' }, { label: 'Retention', value: '98.4%' }] };
  if (kind === 'text') return { heading: 'Executive Summary', body: 'Summarise the key findings and strategic direction here.' };
  if (kind === 'table') return { title: 'Structural Overview & Projections', columns: ['Project Phase', 'Target Date', 'Allocation', 'Status'], rows: [['Phase 1: Brand Alignment', 'Q1 2026', '$45,000', 'Completed'], ['Phase 2: Digital Frameworks', 'Q2 2026', '$80,000', 'In Progress'], ['Phase 3: Scale & Syndication', 'Q3 2026', '$125,000', 'Pending']] };
  return { ...extra };
};

// Pre-generation report readiness: how much of the report is actually backed by data.
const isLiveBlock = (kind) => kind.startsWith('live-');
const computeReadiness = (blocks) => {
  const qs = blocks.filter((b) => b.kind === 'question');
  const live = blocks.filter((b) => isLiveBlock(b.kind)).length;
  const available = qs.filter((b) => b.readiness === 'available').length;
  const partial = qs.filter((b) => b.readiness === 'needs_capture').length;
  const future = qs.filter((b) => b.readiness === 'future').length;
  const totalSections = qs.length + live;
  const coverage = totalSections ? Math.round(((available + live) / totalSections) * 100) : 0;
  const hasData = available > 0 || live > 0;
  const hasGaps = partial > 0 || future > 0;
  let state = 'ready';
  if (!hasData && qs.length > 0) state = 'spec-only';
  else if (hasData && hasGaps) state = 'partial';
  return { totalQ: qs.length, available, partial, future, live, coverage, state };
};

const ReportBuilder = ({ filters }) => {
  const [tab, setTab] = useState('questions');
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('All');
  const [blocks, setBlocks] = useState([]);
  const [previewHtml, setPreviewHtml] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [caps, setCaps] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [validation, setValidation] = useState(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    reportsAPI.distributionCapabilities().then((d) => { if (alive) setCaps(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const flash = (msg, ms = 3200) => { setToast(msg); setTimeout(() => setToast(null), ms); };

  const [branding, setBranding] = useState({
    brandName: 'RITZ MEDIA WORLD',
    title: 'Corporate Performance & Strategic Growth Report',
    subtitle: 'AI Intelligence Report',
    preparedFor: 'Executive Board',
    preparedBy: 'Analytics & BI Office',
    date: todayISO(),
    docId: `RMW-${new Date().getFullYear()}-AI01`,
    confidential: 'Confidential',
    navy: '#101f3f',
    gold: '#c99a2e',
    logo: null,
  });

  const setB = (k, v) => setBranding((b) => ({ ...b, [k]: v }));

  const onLogo = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setB('logo', reader.result);
    reader.readAsDataURL(file);
  };

  const questions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return REPORT_QUESTIONS.filter((item) =>
      (cat === 'All' || item.cat === cat) &&
      (!q || `${item.q} ${item.cat} ${item.metric}`.toLowerCase().includes(q)),
    );
  }, [search, cat]);

  const addBlock = (kind, payload) => setBlocks((b) => [...b, { uid: uid(), kind, ...(payload || defaultPayload(kind)) }]);
  const removeBlock = (u) => setBlocks((b) => b.filter((x) => x.uid !== u));
  const updateBlock = (u, patch) => setBlocks((b) => b.map((x) => (x.uid === u ? { ...x, ...patch } : x)));

  /* ---- Drag & drop ---- */
  const onLibDragStart = (e, kind, payload) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'lib', kind, payload }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const onItemDragStart = (e, u) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'move', uid: u }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const parse = (e) => { try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; } };

  const onCanvasDrop = (e) => {
    e.preventDefault();
    const d = parse(e);
    if (d?.source === 'lib') addBlock(d.kind, d.payload);
  };
  const onItemDrop = (e, targetUid) => {
    e.preventDefault();
    e.stopPropagation();
    const d = parse(e);
    if (!d) return;
    if (d.source === 'lib') { addBlock(d.kind, d.payload); return; }
    if (d.source === 'move' && d.uid !== targetUid) {
      setBlocks((b) => {
        const from = b.findIndex((x) => x.uid === d.uid);
        const to = b.findIndex((x) => x.uid === targetUid);
        if (from < 0 || to < 0) return b;
        const copy = [...b];
        const [moved] = copy.splice(from, 1);
        copy.splice(to, 0, moved);
        return copy;
      });
    }
  };

  // Fetch live data (for live-data blocks AND question answer-bindings), bake
  // snapshots into a self-contained definition, render HTML with real numbers.
  const buildAll = async () => {
    const p = { start: filters?.start, end: filters?.end, department: filters?.department, account: filters?.account };
    const fetchers = {
      executive: () => reportsAPI.executive(p),
      klingSummary: () => reportsAPI.klingSummary(p),
      klingTiming: () => reportsAPI.klingTiming(p),
      costSummary: () => reportsAPI.costSummary(p),
      usersSummary: () => reportsAPI.usersSummary(p),
      chatgptSummary: () => reportsAPI.chatgptSummary(p),
      tasksSummary: () => reportsAPI.tasksSummary(p),
      promptsSummary: () => reportsAPI.promptsSummary(p),
      klingAccounts: () => reportsAPI.klingAccounts(p),
    };
    // Which live-data block maps to which endpoint.
    const LIVE_BLOCK_API = {
      'live-exec': 'executive', 'live-kling': 'klingSummary', 'live-cost': 'costSummary',
      'live-users': 'usersSummary', 'live-tasks': 'tasksSummary',
      'live-prompts': 'promptsSummary', 'live-chatgpt': 'chatgptSummary',
    };
    const kinds = new Set(blocks.map((b) => b.kind));
    const needed = new Set();
    Object.entries(LIVE_BLOCK_API).forEach(([kind, api]) => { if (kinds.has(kind)) needed.add(api); });
    blocks.forEach((b) => {
      if (b.kind === 'question') { const api = answerApiFor(b.id); if (api && fetchers[api]) needed.add(api); }
    });

    const data = {};
    await Promise.all([...needed].map(async (api) => {
      try { data[api] = await fetchers[api](); } catch { /* degrade gracefully */ }
    }));
    const live = {
      exec: data.executive, kling: data.klingSummary, cost: data.costSummary,
      users: data.usersSummary, tasks: data.tasksSummary,
      prompts: data.promptsSummary, chatgpt: data.chatgptSummary,
    };

    const enriched = blocks.map((b) => {
      if (b.kind.startsWith('live-')) return { ...b, snapshotItems: liveSnapshotItems(b.kind, live) };
      if (b.kind === 'question') {
        const bind = ANSWER_BINDINGS[b.id];
        if (bind && data[bind.api]) {
          if (bind.table) return { ...b, answerTable: resolveAnswerTable(bind, data[bind.api]) };
          if (bind.items) return { ...b, answerItems: resolveAnswerItems(bind, data[bind.api]) };
        }
      }
      return b;
    });
    const readiness = computeReadiness(blocks);
    const meta = { kind: readiness.state === 'spec-only' ? 'specification' : 'report', coverage: readiness.coverage };
    const html = buildReportHtml({ branding, blocks: enriched, live, meta });
    return { definition: { branding, blocks: enriched, meta }, html };
  };

  // Validate before generating: green → straight through; partial/spec-only → dialog.
  const onGenerateClick = () => {
    const r = computeReadiness(blocks);
    if (r.state === 'ready') { generate(); return; }
    setValidation(r);
  };
  const proceedGenerate = () => { setValidation(null); generate(); };

  const deptScope = filters?.department && filters.department !== 'all' ? filters.department : null;

  const generate = async () => {
    setGenerating(true);
    try { const { html } = await buildAll(); setPreviewHtml(html); } finally { setGenerating(false); }
  };

  const saveToLibrary = async () => {
    setSaving(true);
    try {
      const { definition, html } = await buildAll();
      await reportsAPI.saveReport({ name: branding.title || 'Untitled report', definition, htmlSnapshot: html, department: deptScope });
      flash('Saved to report library');
    } catch (e) {
      flash(e?.response?.data?.detail || 'Save failed');
    } finally { setSaving(false); }
  };

  const exportServer = async (format) => {
    try {
      const { definition, html } = await buildAll();
      const res = await reportsAPI.exportAdhoc({ definition, format, htmlSnapshot: html, name: branding.title });
      downloadBlobResponse(res, `${branding.title || 'report'}.${format}`);
    } catch (e) {
      flash(e?.response?.status === 501 ? 'That export engine is not installed on the server.' : 'Export failed');
    }
  };

  const printPreview = () => iframeRef.current?.contentWindow?.print();
  const openTab = () => {
    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(previewHtml); w.document.close(); }
  };

  return (
    <div>
      <SectionHeader
        title="Report Builder"
        subtitle="Compose a branded report — drag questions and live-data blocks onto the canvas, add your logo and details, then generate a print-ready document in your corporate template."
      />

      <div className="rb-grid">
        {/* ---------- Library ---------- */}
        <aside className="rb-library">
          <div className="rb-tabs">
            <button className={tab === 'questions' ? 'on' : ''} onClick={() => setTab('questions')}>Questions</button>
            <button className={tab === 'blocks' ? 'on' : ''} onClick={() => setTab('blocks')}>Data blocks</button>
          </div>

          {tab === 'questions' ? (
            <>
              <input className="rpt-input rb-search" placeholder="Search questions…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="rb-cats">
                {['All', ...QUESTION_CATEGORIES].map((c) => (
                  <button key={c} className={`rb-cat ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
                ))}
              </div>
              <div className="rb-liblist">
                {questions.map((item) => (
                  <div key={item.id} className="rb-libcard" draggable onDragStart={(e) => onLibDragStart(e, 'question', item)} title="Drag onto the canvas">
                    <span className="rb-libcat">{item.cat}</span>
                    <span
                      className="rb-libready"
                      title={`${READINESS_META[item.readiness]?.label}${item.dataNote ? ` — ${item.dataNote}` : ''}`}
                      style={{ color: READINESS_META[item.readiness]?.color }}
                    >
                      {READINESS_META[item.readiness]?.badge}
                    </span>
                    <span className="rb-libtitle">{item.q}</span>
                    <button className="rb-addbtn" onClick={() => addBlock('question', item)} aria-label="Add">+</button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rb-liblist">
              {BLOCK_LIBRARY.map((b) => (
                <div key={b.kind} className="rb-libcard" draggable onDragStart={(e) => onLibDragStart(e, b.kind)} title="Drag onto the canvas">
                  <span className={`rb-libcat ${b.live ? 'live' : ''}`}>{b.live ? 'Live data' : 'Block'}</span>
                  <span className="rb-libtitle">{b.title}</span>
                  <span className="rb-libdesc">{b.desc}</span>
                  <button className="rb-addbtn" onClick={() => addBlock(b.kind)} aria-label="Add">+</button>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ---------- Canvas ---------- */}
        <main className="rb-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onCanvasDrop}>
          <div className="rb-canvas-head">
            <span>Report canvas · {blocks.length} block{blocks.length === 1 ? '' : 's'}</span>
            {blocks.length > 0 && <button className="rb-clear" onClick={() => setBlocks([])}>Clear all</button>}
          </div>

          {blocks.length === 0 ? (
            <div className="rb-drop-empty">Drag questions or data blocks here to build your report.</div>
          ) : (
            blocks.map((b, i) => (
              <div key={b.uid} className="rb-block" draggable onDragStart={(e) => onItemDragStart(e, b.uid)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onItemDrop(e, b.uid)}>
                <div className="rb-block-head">
                  <span className="rb-block-n">{i + 1}</span>
                  <span className="rb-block-kind">{b.kind === 'question' ? b.cat : b.kind.replace('live-', 'Live: ')}</span>
                  <span className="rb-grip" title="Drag to reorder">⠿</span>
                  <button className="rb-remove" onClick={() => removeBlock(b.uid)} aria-label="Remove">✕</button>
                </div>

                {b.kind === 'question' && <div className="rb-block-body"><strong>{b.q}</strong><span className="rb-muted">{b.metric} · {b.decision}</span></div>}
                {b.kind.startsWith('live-') && <div className="rb-block-body rb-muted">Live KPI cards — populated from real data at generate time.</div>}

                {b.kind === 'text' && (
                  <div className="rb-block-body rb-edit">
                    <input className="rpt-input" value={b.heading} onChange={(e) => updateBlock(b.uid, { heading: e.target.value })} placeholder="Heading" />
                    <textarea className="rpt-input" rows={3} value={b.body} onChange={(e) => updateBlock(b.uid, { body: e.target.value })} placeholder="Body text" />
                  </div>
                )}

                {b.kind === 'kpis' && (
                  <div className="rb-block-body rb-edit">
                    <input className="rpt-input" value={b.heading} onChange={(e) => updateBlock(b.uid, { heading: e.target.value })} placeholder="Section heading" />
                    <div className="rb-kpi-edit">
                      {b.items.map((it, ix) => (
                        <div key={ix} className="rb-kpi-pair">
                          <input className="rpt-input" value={it.value} onChange={(e) => updateBlock(b.uid, { items: b.items.map((x, j) => (j === ix ? { ...x, value: e.target.value } : x)) })} placeholder="Value" />
                          <input className="rpt-input" value={it.label} onChange={(e) => updateBlock(b.uid, { items: b.items.map((x, j) => (j === ix ? { ...x, label: e.target.value } : x)) })} placeholder="Label" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {b.kind === 'table' && (
                  <div className="rb-block-body rb-edit">
                    <input className="rpt-input" value={b.title} onChange={(e) => updateBlock(b.uid, { title: e.target.value })} placeholder="Table title" />
                    {b.rows.map((row, ri) => (
                      <div key={ri} className="rb-trow">
                        {row.map((cell, ci) => (
                          <input key={ci} className="rpt-input" value={cell} onChange={(e) => updateBlock(b.uid, { rows: b.rows.map((r, j) => (j === ri ? r.map((c, k) => (k === ci ? e.target.value : c)) : r)) })} placeholder={b.columns[ci]} />
                        ))}
                        <button className="rb-remove" onClick={() => updateBlock(b.uid, { rows: b.rows.filter((_r, j) => j !== ri) })}>✕</button>
                      </div>
                    ))}
                    <button className="rb-addrow" onClick={() => updateBlock(b.uid, { rows: [...b.rows, b.columns.map(() => '')] })}>+ Add row</button>
                  </div>
                )}
              </div>
            ))
          )}
        </main>

        {/* ---------- Branding ---------- */}
        <aside className="rb-brand">
          <h3 className="rb-brand-title">Branding &amp; details</h3>
          <label className="rb-logo">
            {branding.logo ? <img src={branding.logo} alt="logo" /> : <span className="rb-logo-ph">Upload logo</span>}
            <input type="file" accept="image/*" onChange={onLogo} hidden />
          </label>
          {branding.logo && <button className="rb-clear" onClick={() => setB('logo', null)}>Remove logo</button>}

          {[
            ['brandName', 'Brand name'], ['title', 'Report title'], ['subtitle', 'Subtitle'],
            ['preparedFor', 'Prepared for'], ['preparedBy', 'Prepared by'], ['docId', 'Document ID'], ['confidential', 'Footer / confidentiality'],
          ].map(([k, label]) => (
            <label key={k} className="rb-field"><span>{label}</span>
              <input className="rpt-input" value={branding[k]} onChange={(e) => setB(k, e.target.value)} />
            </label>
          ))}
          <label className="rb-field"><span>Date</span>
            <input type="date" className="rpt-input" value={branding.date} onChange={(e) => setB('date', e.target.value)} />
          </label>
          <div className="rb-colors">
            <label><span>Primary</span><input type="color" value={branding.navy} onChange={(e) => setB('navy', e.target.value)} /></label>
            <label><span>Accent</span><input type="color" value={branding.gold} onChange={(e) => setB('gold', e.target.value)} /></label>
          </div>

          <button className="rb-generate" disabled={!blocks.length || generating} onClick={onGenerateClick}>
            {generating ? 'Generating…' : 'Generate & preview'}
          </button>
          <button className="rb-generate rb-save" disabled={!blocks.length || saving} onClick={saveToLibrary}>
            {saving ? 'Saving…' : 'Save to library'}
          </button>

          <div className="rb-export">
            <span className="rb-export-lab">Export</span>
            <div className="rb-export-btns">
              <button disabled={!blocks.length} onClick={() => exportServer('csv')}>CSV</button>
              <button disabled={!blocks.length || (caps && !caps.formats?.xlsx)} onClick={() => exportServer('xlsx')} title={caps && !caps.formats?.xlsx ? 'openpyxl not installed on server' : ''}>Excel</button>
              <button disabled={!blocks.length || (caps && !caps.formats?.pptx)} onClick={() => exportServer('pptx')} title={caps && !caps.formats?.pptx ? 'python-pptx not installed on server' : ''}>PPT</button>
              <button disabled={!blocks.length || (caps && !caps.formats?.pdf)} onClick={() => exportServer('pdf')} title={caps && !caps.formats?.pdf ? 'Server PDF off — use Generate → Print / Save as PDF' : ''}>PDF</button>
            </div>
            {caps && !caps.formats?.pdf && <span className="rb-hint">Server PDF is off — use <b>Generate</b> → Print / Save as PDF for pixel-perfect PDF.</span>}
          </div>

          {!blocks.length && <span className="rb-hint">Add at least one block to generate.</span>}
          {toast && <div className="rb-toast">{toast}</div>}
        </aside>
      </div>

      {/* ---------- Preview overlay ---------- */}
      {previewHtml && (
        <div className="rb-preview-overlay" role="dialog" aria-modal="true">
          <div className="rb-preview-bar">
            <span>Report preview</span>
            <div className="rb-preview-actions">
              <button className="ghost" onClick={openTab}>Open in new tab</button>
              <button className="ghost" onClick={printPreview}>Print / Save as PDF</button>
              <button onClick={() => setPreviewHtml(null)}>Close</button>
            </div>
          </div>
          <iframe ref={iframeRef} className="rb-preview-frame" title="Report preview" srcDoc={previewHtml} />
        </div>
      )}

      {/* Pre-generation report readiness validation */}
      {validation && (
        <div className="rb-modal-wrap" onClick={() => setValidation(null)}>
          <div className="rb-modal" role="dialog" aria-modal="true" aria-label="Report readiness" onClick={(e) => e.stopPropagation()}>
            <h3 className="rb-modal-title">
              {validation.state === 'spec-only'
                ? 'This report cannot produce meaningful analytics yet'
                : 'Report data coverage'}
            </h3>

            <div className="rb-health">
              <div className="rb-health-bar"><span className={`rb-health-fill ${validation.state}`} style={{ width: `${validation.coverage}%` }} /></div>
              <span className="rb-health-pct">{validation.coverage}% coverage</span>
            </div>

            <table className="rb-health-tbl">
              <tbody>
                <tr><td>Total questions</td><td>{validation.totalQ}</td></tr>
                <tr><td>✅ Backed by data</td><td>{validation.available}</td></tr>
                <tr><td>🟡 Partial</td><td>{validation.partial}</td></tr>
                <tr><td>🔴 Requires capture</td><td>{validation.future}</td></tr>
                <tr><td>Live-data blocks</td><td>{validation.live}</td></tr>
              </tbody>
            </table>

            {validation.state === 'spec-only' ? (
              <>
                <p className="rb-modal-note">
                  All selected questions require data that isn’t available yet. You can go back and add
                  questions backed by available data, or generate a <strong>specification document</strong> (clearly
                  labelled as planned analytics, not validated data).
                </p>
                <div className="rb-modal-actions">
                  <button className="ghost" onClick={() => setValidation(null)}>Back</button>
                  <button onClick={proceedGenerate}>Generate specification</button>
                </div>
              </>
            ) : (
              <>
                <p className="rb-modal-note">
                  Some sections aren’t backed by live data. Add live-data blocks or available-data questions to raise
                  coverage — or generate anyway. Partially-supported sections are flagged inside the report.
                </p>
                <div className="rb-modal-actions">
                  <button className="ghost" onClick={() => setValidation(null)}>Back</button>
                  <button onClick={proceedGenerate}>Generate anyway</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportBuilder;
