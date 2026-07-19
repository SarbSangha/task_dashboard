import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  dashboards, dashboardsById, reportsById, questionsById,
  resolvedQuestions, reportAvailable, reportSpecCount, reportValue, reportStatus,
  isQuestionAnswerable, missingSources, sourceChecklist, readinessBadge,
  locateQuestion, recommendedReports, dashboardAvailability,
} from './libraryData';
import { track, pushRecent, getRecent } from './track';
import './ReportBuilderV2.css';

const AUDIENCES = ['EXECUTIVE', 'FINANCE', 'DEPARTMENT_HEAD', 'AI_TEAM', 'OPERATIONS', 'ADMINISTRATOR', 'INDIVIDUAL_EMPLOYEE'];
const TIERS = [1, 2, 3, 4, 5];
const STATUS_LABEL = { implemented: 'Implemented', available: 'Data ready', coming_soon: 'Coming soon', planned: 'Planned', deprecated: 'Deprecated' };
const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
const READY_STATUSES = new Set(['implemented', 'available']);

const Badge = ({ kind, children, title }) => (
  <span className={`rbv2-badge rbv2-badge-${kind}`} title={title}>{children}</span>
);

const QuestionBadges = ({ q }) => (
  <div className="rbv2-badges">
    <Badge kind={`rd-${q.readiness}`} title={`Readiness: ${q.readiness}`}><span aria-hidden="true">{readinessBadge[q.readiness]}</span></Badge>
    <Badge kind={`st-${q.status}`} title={`Status: ${q.status}`}>{STATUS_LABEL[q.status] || q.status}</Badge>
    <Badge kind="tier" title={`Priority tier ${q.priorityTier}`}>T{q.priorityTier}</Badge>
    <Badge kind={`conf-${q.confidence}`} title={CONF_LABEL[q.confidence]}>{q.confidence}</Badge>
    <Badge kind="calc" title={`Calculation type: ${q.calculationType}`}>{q.calculationType}</Badge>
  </div>
);

const ValueTag = ({ value }) => value && <span className={`rbv2-value ${value.toLowerCase()}`}>{value} value</span>;

const ReportBuilderV2 = () => {
  const [params, setParams] = useSearchParams();
  const [runNotice, setRunNotice] = useState(null);
  const drawerRef = useRef(null);

  // ---- URL-backed state (deep linking) ----
  const dParam = params.get('d') || '';
  const openQuestionId = params.get('q') || null;
  const search = params.get('search') || '';
  const fAudience = params.get('aud') || 'all';
  const fTier = params.get('tier') || 'all';
  const fTag = params.get('tag') || '';
  const showComingSoon = params.get('cs') === '1';
  const showPlanned = params.get('pl') === '1';

  const openQuestion = openQuestionId ? questionsById[openQuestionId] : null;
  const activeDashboardId = dParam || openQuestion?.dashboardId || '';
  const dashboard = activeDashboardId ? dashboardsById[activeDashboardId] : null;
  const isHome = !dashboard;

  const setParam = useCallback((patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '' || v === 'all' || v === false) next.delete(k);
      else next.set(k, v === true ? '1' : v);
    });
    setParams(next, { replace: false });
  }, [params, setParams]);

  const goHome = () => { setParams(new URLSearchParams()); track('home_open'); };

  const openDashboard = (id) => { setParam({ d: id, q: null }); track('dashboard_selected', { dashboardId: id }); };

  const openQuestionDetail = (q) => {
    setParam({ q: q.id });
    pushRecent(q.reportId);
    track('question_viewed', { id: q.id, status: q.status, readiness: q.readiness });
  };

  const navigateToQuestion = (id) => {
    const loc = locateQuestion(id);
    if (!loc) return;
    setParam({ d: loc.dashboardId, q: id });
    track('related_followed', { to: id });
  };

  // ---- Filtering (memoized) ----
  const statusVisible = useCallback((st) => READY_STATUSES.has(st) || (st === 'coming_soon' && showComingSoon) || (st === 'planned' && showPlanned), [showComingSoon, showPlanned]);

  const matchesFilters = useCallback((q) => {
    if (!q) return false;
    if (!statusVisible(q.status)) return false;
    if (fAudience !== 'all' && !(q.audience || []).includes(fAudience)) return false;
    if (fTier !== 'all' && q.priorityTier !== Number(fTier)) return false;
    if (fTag && !(q.tags || []).includes(fTag)) return false;
    if (search) {
      const hay = `${q.id} ${q.question} ${q.why} ${q.metric} ${(q.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  }, [statusVisible, fAudience, fTier, fTag, search]);

  const sortQs = (list) => [...list].sort((a, b) => a.priorityTier - b.priorityTier || (isQuestionAnswerable(b) - isQuestionAnswerable(a)));

  const filtersActive = fAudience !== 'all' || fTier !== 'all' || fTag || search || showComingSoon || showPlanned;

  const recommended = useMemo(() => recommendedReports(6), []);
  // Small list, read fresh each render so it reflects the latest views.
  const recentReports = getRecent().map((id) => reportsById[id]).filter(Boolean);

  // Global search across all questions (from Home).
  const globalResults = useMemo(() => {
    if (!search || !isHome) return [];
    return sortQs(Object.values(questionsById).filter(matchesFilters)).slice(0, 20);
  }, [search, isHome, matchesFilters]);

  // ---- Accessibility: focus + ESC on drawer ----
  useEffect(() => {
    if (!openQuestion) return undefined;
    drawerRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setParam({ q: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openQuestion, setParam]);

  useEffect(() => { track('library_open'); }, []);

  const runReport = (q) => {
    track('report_run_clicked', { id: q.id, status: q.status });
    setRunNotice(q.status === 'implemented'
      ? `“${q.id}” is implemented — wiring the backend endpoint will render it live here.`
      : `“${q.id}” is ${STATUS_LABEL[q.status]?.toLowerCase()} — reserved; not yet runnable.`);
  };

  if (!dashboards.length) {
    return <div className="rbv2"><div className="rbv2-empty">Analytics library is empty or failed to load.</div></div>;
  }

  // ================= Filter bar (shared) =================
  const FilterBar = (
    <div className="rbv2-filters" role="search">
      <input className="rbv2-search" type="search" aria-label="Search questions, metrics and tags"
        placeholder="Search questions, metrics, tags…" value={search} onChange={(e) => { setParam({ search: e.target.value }); if (e.target.value) track('search', { q: e.target.value }); }} />
      <select aria-label="Filter by audience" value={fAudience} onChange={(e) => { setParam({ aud: e.target.value }); track('filter_changed', { audience: e.target.value }); }}>
        <option value="all">All audiences</option>
        {AUDIENCES.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
      </select>
      <select aria-label="Filter by priority tier" value={fTier} onChange={(e) => { setParam({ tier: e.target.value }); track('filter_changed', { tier: e.target.value }); }}>
        <option value="all">All tiers</option>
        {TIERS.map((t) => <option key={t} value={t}>Tier {t}</option>)}
      </select>
      <div className="rbv2-toggles" role="group" aria-label="Show by status">
        <span className="rbv2-toggle on" aria-disabled="true" title="Ready and implemented reports are always shown">Ready ✓</span>
        <button className={`rbv2-toggle ${showComingSoon ? 'on' : ''}`} aria-pressed={showComingSoon} onClick={() => setParam({ cs: !showComingSoon })}>Coming soon</button>
        <button className={`rbv2-toggle ${showPlanned ? 'on' : ''}`} aria-pressed={showPlanned} onClick={() => setParam({ pl: !showPlanned })}>Planned</button>
      </div>
      {filtersActive && <button className="rbv2-reset" onClick={() => setParams(new URLSearchParams(dParam ? { d: dParam } : {}))}>Reset</button>}
    </div>
  );

  return (
    <div className="rbv2">
      <div className="rbv2-head">
        <nav className="rbv2-crumbs" aria-label="Breadcrumb">
          <button className="rbv2-crumb-link" onClick={goHome}>Analytics</button>
          {dashboard && <><span aria-hidden="true">›</span><button className="rbv2-crumb-link" onClick={() => openDashboard(dashboard.id)}>{dashboard.name.replace(' Dashboard', '')}</button></>}
          {openQuestion && <><span aria-hidden="true">›</span><span className="rbv2-crumb-cur">{reportsById[openQuestion.reportId]?.name}</span></>}
        </nav>
        {FilterBar}
        {fTag && <div className="rbv2-tagrow">Tag: <button className="rbv2-tag active" onClick={() => setParam({ tag: '' })}>#{fTag} ✕</button></div>}
      </div>

      <div className="rbv2-body">
        {/* Left nav */}
        <nav className="rbv2-nav" aria-label="Dashboards">
          <button className={`rbv2-navitem ${isHome ? 'active' : ''}`} onClick={goHome}>
            <span className="rbv2-navdomain">Start</span><span className="rbv2-navname">Overview</span>
          </button>
          {dashboards.map((d) => {
            const { available } = dashboardAvailability(d);
            return (
              <button key={d.id} className={`rbv2-navitem ${d.id === activeDashboardId ? 'active' : ''} ${available ? '' : 'muted'}`} onClick={() => openDashboard(d.id)}>
                <span className="rbv2-navdomain">{d.domain}</span>
                <span className="rbv2-navname">{d.name.replace(' Dashboard', '')}</span>
                {available ? <span className="rbv2-navcount">{available} ready</span> : <span className="rbv2-navsoon">roadmap</span>}
              </button>
            );
          })}
        </nav>

        <main className="rbv2-main">
          {/* ============ HOME / EXECUTIVE LANDING ============ */}
          {isHome && (
            <>
              {search ? (
                <section>
                  <h3 className="rbv2-h">Search results for “{search}”</h3>
                  {globalResults.length ? (
                    <div className="rbv2-cards">{globalResults.map((q) => <QuestionCard key={q.id} q={q} onOpen={openQuestionDetail} />)}</div>
                  ) : <div className="rbv2-reportempty">No questions match. Try enabling “Coming soon”/“Planned”, or clearing filters.</div>}
                </section>
              ) : (
                <>
                  <header className="rbv2-hero">
                    <h2 className="rbv2-title">AI Analytics — Executive Overview</h2>
                    <p className="rbv2-sub">Start with the highest-value reports, or jump to a stakeholder dashboard on the left.</p>
                  </header>

                  <section>
                    <h3 className="rbv2-h">Recommended reports</h3>
                    <div className="rbv2-reportgrid">
                      {recommended.map(({ report, dashboard: d }) => <ReportTile key={report.id} report={report} dashboard={d} onOpen={openDashboard} />)}
                    </div>
                  </section>

                  {recentReports.length > 0 && (
                    <section>
                      <h3 className="rbv2-h">Recently viewed</h3>
                      <div className="rbv2-reportgrid">
                        {recentReports.map((r) => <ReportTile key={r.id} report={r} dashboard={dashboardsById[r.dashboardId]} onOpen={openDashboard} />)}
                      </div>
                    </section>
                  )}

                  <section>
                    <h3 className="rbv2-h">By stakeholder</h3>
                    <div className="rbv2-reportgrid">
                      {dashboards.map((d) => {
                        const { total, available } = dashboardAvailability(d);
                        return (
                          <button key={d.id} className="rbv2-dashtile" onClick={() => openDashboard(d.id)}>
                            <span className="rbv2-navdomain">{d.domain}</span>
                            <strong>{d.name.replace(' Dashboard', '')}</strong>
                            <span className="rbv2-dashtile-meta">{available}/{total} reports ready</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {/* ============ DASHBOARD VIEW ============ */}
          {dashboard && (
            <>
              <header className="rbv2-dashhead">
                <h3>{dashboard.name}</h3>
                <p>{dashboard.objective}</p>
                <div className="rbv2-aud">{(dashboard.audience || []).map((a) => <span key={a} className="rbv2-audpill">{a.replace(/_/g, ' ')}</span>)}</div>
              </header>

              {(dashboard.reports || []).map((report) => {
                const available = reportAvailable(report);
                const { total, specified } = reportSpecCount(report);
                const allQs = resolvedQuestions(report);
                const qs = sortQs(allQs.filter(matchesFilters));
                const checklist = sourceChecklist(allQs);
                return (
                  <section key={report.id} className={`rbv2-report ${available ? '' : 'disabled'}`}>
                    <div className="rbv2-reporthead">
                      <div>
                        <h4>{report.name}</h4>
                        <p>{report.objective}</p>
                      </div>
                      <div className="rbv2-reportmeta">
                        <Badge kind={`st-${reportStatus(report)}`} title="Report status">{STATUS_LABEL[reportStatus(report)]}</Badge>
                        <ValueTag value={reportValue(report)} />
                        <span className="rbv2-spec">{specified}/{total} questions</span>
                      </div>
                    </div>

                    {specified === 0 ? (
                      <EmptyState kind="planned" report={report} checklist={checklist} />
                    ) : !available ? (
                      <EmptyState kind="missing" report={report} checklist={checklist} />
                    ) : qs.length ? (
                      <div className="rbv2-cards">{qs.map((q) => <QuestionCard key={q.id} q={q} onOpen={openQuestionDetail} />)}</div>
                    ) : (
                      <div className="rbv2-reportempty">No questions match the current filters.</div>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </main>
      </div>

      {/* ============ DETAIL DRAWER ============ */}
      {openQuestion && (
        <div className="rbv2-drawer-wrap" onClick={() => setParam({ q: null })}>
          <aside className="rbv2-drawer" ref={drawerRef} tabIndex={-1} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Question ${openQuestion.id}`}>
            <button className="rbv2-drawer-close" onClick={() => setParam({ q: null })} aria-label="Close detail">✕</button>
            <span className="rbv2-qid big">{openQuestion.id}</span>
            <h3 className="rbv2-drawer-q">{openQuestion.question}</h3>
            <QuestionBadges q={openQuestion} />
            <p className="rbv2-why">{openQuestion.why}</p>

            <div className="rbv2-panel impact"><span className="rbv2-plabel">Business impact</span>{openQuestion.businessImpact}</div>
            <div className="rbv2-panel threshold"><span className="rbv2-plabel">Threshold</span>{openQuestion.threshold}</div>
            <div className="rbv2-panel action"><span className="rbv2-plabel">Recommended action</span>{openQuestion.recommendedAction}</div>

            {/* Analysis path — prominent, not hidden */}
            {openQuestion.relatedQuestions?.length > 0 && (
              <div className="rbv2-path">
                <span className="rbv2-plabel">Analysis path — drill deeper</span>
                <ol className="rbv2-pathlist">
                  {openQuestion.relatedQuestions.map((id) => {
                    const rq = questionsById[id];
                    return (
                      <li key={id}>
                        <button className={`rbv2-pathstep ${rq ? '' : 'missing'}`} disabled={!rq} onClick={() => navigateToQuestion(id)}>
                          <span className="rbv2-qid">{id}</span>{rq ? ` ${rq.question}` : ' — not yet specified'}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            <div className="rbv2-panel"><span className="rbv2-plabel">Metric</span>{openQuestion.metric}</div>
            <div className="rbv2-panel"><span className="rbv2-plabel">Visualization</span>{openQuestion.visualization}</div>
            <div className="rbv2-panel">
              <span className="rbv2-plabel">Dependencies (data sources)</span>
              <div className="rbv2-sources">
                {(openQuestion.dataSources || []).map((s) => {
                  const na = missingSources(openQuestion).includes(s);
                  return <span key={s} className={`rbv2-source ${na ? 'na' : 'ok'}`}>{na ? '✗' : '✓'} {s}</span>;
                })}
              </div>
            </div>
            <div className="rbv2-panel"><span className="rbv2-plabel">Audience</span>
              <div className="rbv2-sources">{(openQuestion.audience || []).map((a) => <span key={a} className="rbv2-audpill">{a.replace(/_/g, ' ')}</span>)}</div>
            </div>
            {openQuestion.tags?.length > 0 && (
              <div className="rbv2-panel"><span className="rbv2-plabel">Tags</span>
                <div className="rbv2-sources">{openQuestion.tags.map((t) => <button key={t} className="rbv2-tag" onClick={() => setParam({ tag: t, q: null, d: openQuestion.dashboardId })}>#{t}</button>)}</div>
              </div>
            )}

            <div className="rbv2-runrow">
              <button className={`rbv2-run ${openQuestion.status === 'implemented' ? 'ready' : ''}`} onClick={() => runReport(openQuestion)}>
                ▶ Run report
              </button>
              {runNotice && <p className="rbv2-runnote">{runNotice}</p>}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};

// ---- Sub-components ----
const QuestionCard = ({ q, onOpen }) => (
  <button className={`rbv2-card ${isQuestionAnswerable(q) ? '' : 'na'}`} onClick={() => onOpen(q)}>
    <div className="rbv2-card-top"><span className="rbv2-qid">{q.id}</span><QuestionBadges q={q} /></div>
    <p className="rbv2-qtext">{q.question}</p>
    <p className="rbv2-qmeta"><b>Metric:</b> {q.metric} · <b>Viz:</b> {q.visualization}</p>
  </button>
);

const ReportTile = ({ report, dashboard, onOpen }) => (
  <button className="rbv2-dashtile" onClick={() => onOpen(dashboard.id)}>
    <span className="rbv2-navdomain">{dashboard.domain}</span>
    <strong>{report.name}</strong>
    <div className="rbv2-tilebadges">
      <Badge kind={`st-${reportStatus(report)}`}>{STATUS_LABEL[reportStatus(report)]}</Badge>
      <ValueTag value={reportValue(report)} />
      <span className="rbv2-spec">{reportSpecCount(report).specified} q</span>
    </div>
  </button>
);

const EmptyState = ({ kind, report, checklist }) => (
  <div className={`rbv2-emptystate ${kind}`}>
    <p className="rbv2-emptytitle">{kind === 'planned' ? 'Specification pending' : 'Unavailable — data not yet captured'}</p>
    <p className="rbv2-emptybody">
      {kind === 'planned'
        ? `“${report.name}” is on the roadmap; its questions aren’t detailed in the spec yet.`
        : `“${report.name}” can’t run until its data sources are captured.`}
    </p>
    {checklist.length > 0 && (
      <ul className="rbv2-checklist">
        {checklist.map(({ source, available }) => (
          <li key={source} className={available ? 'ok' : 'na'}>{available ? '✓' : '✗'} {source}</li>
        ))}
      </ul>
    )}
  </div>
);

export default ReportBuilderV2;
