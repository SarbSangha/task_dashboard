import { useEffect, useMemo, useState } from 'react';
import { sheetsAPI } from '../../services/sheets';

/**
 * Add or edit a registered sheet (admins). Adding: paste the link, the
 * backend downloads the link-shared workbook, lists its tabs and guesses
 * each column's role from its header; everything stays editable.
 */

const ROLE_OPTIONS = [
  ['topic', 'Topic (marks a new request)'],
  ['input', 'Other user input'],
  ['structure', 'Optimized Structure (Claude, editable by users)'],
  ['status', 'Status'],
  ['final_link', 'Final doc link'],
  ['output', 'Other Claude output'],
  ['row_number', 'Row number (No.)'],
  ['request_id', 'Request ID'],
  ['ignore', 'Ignore'],
];
const SIDE_FOR_ROLE = {
  topic: 'input', input: 'input', structure: 'output', status: 'output', final_link: 'output', output: 'output',
  row_number: 'ignore', request_id: 'ignore', ignore: 'ignore',
};
const STATUS_FIELDS = [
  ['awaiting', 'Structure ready (Claude, stage 1)'],
  ['approved', 'Approved (user)'],
  ['in_progress', 'Drafting (Claude, stage 2)'],
  ['delivered', 'Delivered (Claude)'],
];

const errorText = (err, fallback) => {
  const d = err?.response?.data?.detail;
  return typeof d === 'string' ? d : fallback;
};

// isAdmin: who sees the sheet and removing it stay admin-only, so a member
// with the "settings" permission (or the "Add Sheets" grant) gets the form
// without those parts. Without "openInGoogle" the server leaves the links
// out, so the source link field is hidden rather than saved back empty.
export default function SheetSetup({ sheet, isAdmin, onSaved, onCancel, onDeleted }) {
  const editing = Boolean(sheet);
  const canSeeLinks = !editing || sheet.permissions?.openInGoogle !== false;
  const [url, setUrl] = useState(sheet?.url || '');
  const [sheetType, setSheetType] = useState(sheet?.sheetType || 'content_workflow');
  const [sourceUrl, setSourceUrl] = useState(sheet?.sourceUrl || '');
  const [name, setName] = useState(sheet?.name || '');
  const [tabs, setTabs] = useState(sheet?.tabs || []);
  const [tabInfo, setTabInfo] = useState({});
  const [mapping, setMapping] = useState(sheet?.mapping || {});
  const [statuses, setStatuses] = useState(sheet?.statuses || {});
  const [config, setConfig] = useState(sheet?.config || {});
  const [isActive, setIsActive] = useState(sheet ? sheet.isActive : true);
  const [people, setPeople] = useState([]);
  const [members, setMembers] = useState(new Set((sheet?.members || []).map((m) => m.id)));
  const [peopleFilter, setPeopleFilter] = useState('');
  const [inspected, setInspected] = useState(editing);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    sheetsAPI.people().then((d) => setPeople(d?.people || [])).catch(() => {});
  }, [isAdmin]);

  const inspect = async () => {
    setBusy('inspect');
    setError('');
    try {
      const d = await sheetsAPI.inspect(url);
      setTabs(d.tabs.map((t) => ({ name: t.name, tracked: t.suggestTracked })));
      setTabInfo(Object.fromEntries(d.tabs.map((t) => [t.name, t])));
      setSheetType(d.sheetType || 'content_workflow');
      setMapping(d.mapping);
      setStatuses(d.statuses);
      setConfig(d.config);
      setInspected(true);
    } catch (err) {
      setError(errorText(err, 'Could not read that sheet.'));
    } finally {
      setBusy('');
    }
  };

  const headers = useMemo(() => Object.keys(mapping), [mapping]);
  const isRanking = sheetType === 'keyword_ranking';
  const setRole = (header, role) =>
    setMapping((m) => ({ ...m, [header]: { role, side: SIDE_FOR_ROLE[role] } }));
  const setSide = (header, side) => setMapping((m) => ({ ...m, [header]: { ...m[header], side } }));
  const toggleTab = (tabName) => setTabs((ts) => ts.map((t) => (t.name === tabName ? { ...t, tracked: !t.tracked } : t)));
  const toggleMember = (id) => setMembers((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const saveGoogleEmail = async (person, value) => {
    if ((value || '').trim().toLowerCase() === (person.googleEmail || '').toLowerCase()) return;
    try {
      await sheetsAPI.setGoogleEmail(person.id, value);
      setPeople((ps) => ps.map((p) => (p.id === person.id
        ? { ...p, googleEmail: value || p.email, googleEmailIsOverride: Boolean(value) && value !== p.email } : p)));
    } catch (err) {
      setError(errorText(err, 'Could not save that Google email.'));
    }
  };

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const payload = { name: name.trim(), tabs, mapping, statuses, config, ...(canSeeLinks ? { sourceUrl } : {}) };
      let saved;
      if (editing) {
        saved = (await sheetsAPI.update(sheet.id, { ...payload, isActive })).sheet;
        if (isAdmin) saved = { ...saved, members: (await sheetsAPI.setMembers(sheet.id, [...members])).members };
        // Re-read right away so a corrected setting shows its effect now,
        // not at the next scheduled poll.
        try {
          const synced = await sheetsAPI.sync(sheet.id);
          saved = { ...saved, ...(synced?.sheet || {}), members: saved.members };
        } catch {
          // The scheduled poll will pick it up.
        }
      } else {
        const res = await sheetsAPI.create({ ...payload, sheetType, url, memberIds: isAdmin ? [...members] : [] });
        saved = res.sheet;
        const first = res.firstSync || {};
        let done = `Saved. Imported ${first.created ?? 0} existing request(s).`;
        if (sheetType === 'keyword_ranking') {
          done = `Saved. Imported ${first.keywords ?? 0} keywords with ${first.newRuns ?? 0} runs (${first.checks ?? 0} results).`;
        }
        setNotice(first.error ? `Saved, but the first read failed: ${first.error}` : done);
      }
      onSaved?.(saved);
    } catch (err) {
      setError(errorText(err, 'Could not save the sheet.'));
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${sheet.name}" and its tracked history from the dashboard? The Google Sheet itself is not touched.`)) return;
    setBusy('delete');
    try {
      await sheetsAPI.remove(sheet.id);
      onDeleted?.();
    } catch (err) {
      setError(errorText(err, 'Could not remove the sheet.'));
      setBusy('');
    }
  };

  const visiblePeople = people.filter((p) => {
    const q = peopleFilter.trim().toLowerCase();
    return !q || `${p.name} ${p.email} ${p.department || ''}`.toLowerCase().includes(q);
  });

  return (
    <div className="shs-setup">
      <h3>{editing ? `Settings: ${sheet.name}` : 'Add a sheet'}</h3>

      {!editing && (
        <div className="shs-step">
          <label className="trp-field shs-grow">
            <span>Google Sheets link</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
          </label>
          <button type="button" className="trp-generate-btn" onClick={inspect} disabled={!url || busy === 'inspect'}>
            {busy === 'inspect' ? 'Reading…' : 'Check access'}
          </button>
          <p className="shs-muted shs-full">
            The sheet must be shared as <strong>Anyone with the link → Viewer</strong>. The dashboard reads it every 90
            seconds and never writes to it.
          </p>
        </div>
      )}

      {error && <div className="trp-error" role="alert">{error}</div>}
      {notice && <div className="shs-success" role="status">{notice}</div>}

      {inspected && (
        <>
          <section className="shs-block">
            <label className="trp-field shs-grow">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Content Automation & Tracker" />
            </label>
          </section>

          <section className="shs-block">
            <h4>Tabs to track</h4>
            <div className="shs-chips">
              {tabs.map((t) => (
                <label key={t.name} className={`shs-chip${t.tracked ? ' shs-chip--on' : ''}`}>
                  <input type="checkbox" checked={t.tracked} onChange={() => toggleTab(t.name)} />
                  <span>{t.name}</span>
                  {tabInfo[t.name] && <small>{tabInfo[t.name].rows} rows · {tabInfo[t.name].headers.length} columns</small>}
                </label>
              ))}
            </div>
          </section>

          {isRanking && (
            <section className="shs-block">
              <h4>Keyword ranking layout <span className="shs-muted">(found by header text on every read)</span></h4>
              {Object.keys(tabInfo).length > 0 && (
                <div className="trp-table-wrap">
                  <table className="trp-table shs-compact">
                    <thead><tr><th>Tab</th><th>Header / sub-header / data rows</th><th>Keywords</th><th>Runs</th><th>First → last run</th><th>Problems</th></tr></thead>
                    <tbody>
                      {Object.values(tabInfo).filter((t) => t.layout).map((t) => (
                        <tr key={t.name}>
                          <td><strong>{t.name}</strong></td>
                          <td>{t.layout.headerRow ? `${t.layout.headerRow} / ${t.layout.subHeaderRow || '—'} / ${t.layout.firstDataRow}` : <span className="shs-warn">not a ranking tab</span>}</td>
                          <td>{t.layout.keywords}</td>
                          <td>{t.layout.runs}</td>
                          <td>{t.layout.firstRun ? `${t.layout.firstRun} → ${t.layout.lastRun}` : '—'}</td>
                          <td className="shs-warn">{(t.layout.problems || []).join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canSeeLinks && (
              <label className="trp-field shs-grow">
                <span>Keyword source sheet (optional)</span>
                <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="Leave empty if people type keywords into this sheet" />
              </label>
              )}
              <p className="shs-muted shs-small">
                Paste the link of the <strong>other</strong> spreadsheet where people type new keywords (the &quot;Keyword URL
                Source Sheet&quot;), only if keywords are typed there and copied into this sheet. If people type keywords
                straight into this sheet, leave it empty: this sheet is already watched.
              </p>
              <p className="shs-muted shs-small">
                To see <em>who</em> typed each keyword, install the Apps Script (Code.gs) on the sheet where they type it.
                Leave the row numbers on &quot;auto&quot;: they are found from the &quot;Keyword&quot; and &quot;Position&quot;
                headers, and a wrong number is ignored.
              </p>
              <div className="shs-step">
                {[['headerRow', 'Header row'], ['subHeaderRow', 'Sub-header row'], ['firstDataRow', 'First data row']].map(([k, label]) => (
                  <label key={k} className="trp-field">
                    <span>{label}</span>
                    <input type="number" min="1" value={config[k] ?? ''} placeholder="auto"
                      onChange={(e) => setConfig((c) => ({ ...c, [k]: e.target.value === '' ? null : Number(e.target.value) }))} />
                  </label>
                ))}
                {editing && (
                  <label className="shs-check">
                    <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                    <span>Active (uncheck to pause polling)</span>
                  </label>
                )}
              </div>
            </section>
          )}

          {!isRanking && (
          <>
          <section className="shs-block">
            <h4>Columns <span className="shs-muted">(matched by header name, never by position)</span></h4>
            <div className="trp-table-wrap">
              <table className="trp-table">
                <thead><tr><th>Header</th><th>Role</th><th>Side</th></tr></thead>
                <tbody>
                  {headers.map((h) => (
                    <tr key={h}>
                      <td><strong>{h}</strong></td>
                      <td>
                        <select value={mapping[h].role} onChange={(e) => setRole(h, e.target.value)}>
                          {ROLE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={mapping[h].side} onChange={(e) => setSide(h, e.target.value)}>
                          <option value="input">User input</option>
                          <option value="output">Claude output</option>
                          <option value="ignore">Ignore</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="shs-block shs-grid2">
            <div>
              <h4>Status values</h4>
              {STATUS_FIELDS.map(([key, label]) => (
                <label key={key} className="trp-field">
                  <span>{label}</span>
                  <input value={statuses[key] || ''} onChange={(e) => setStatuses((s) => ({ ...s, [key]: e.target.value }))} />
                </label>
              ))}
            </div>
            <div>
              <h4>Tracking</h4>
              <label className="trp-field">
                <span>Row identity column</span>
                <select value={config.keyColumn || ''} onChange={(e) => setConfig((c) => ({ ...c, keyColumn: e.target.value || null }))}>
                  <option value="">Automatic (Request ID, else No., else row number)</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>Flag Awaiting Approval after (hours)</span>
                <input type="number" min="1" value={config.stuckAwaitingHours ?? 48}
                  onChange={(e) => setConfig((c) => ({ ...c, stuckAwaitingHours: Number(e.target.value) }))} />
              </label>
              <label className="trp-field">
                <span>Flag In Progress after (hours)</span>
                <input type="number" min="1" value={config.stuckInProgressHours ?? 24}
                  onChange={(e) => setConfig((c) => ({ ...c, stuckInProgressHours: Number(e.target.value) }))} />
              </label>
              <label className="shs-check">
                <input type="checkbox" checked={config.skipExampleRows !== false}
                  onChange={(e) => setConfig((c) => ({ ...c, skipExampleRows: e.target.checked }))} />
                <span>Skip pale-yellow example rows</span>
              </label>
              {editing && (
                <label className="shs-check">
                  <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                  <span>Active (uncheck to pause polling)</span>
                </label>
              )}
            </div>
          </section>
          </>
          )}

          {isAdmin ? (
          <section className="shs-block">
            <h4>Who can see this sheet <span className="shs-muted">(admins always can; people also need the Sheets grant in Section Access)</span></h4>
            <input className="shs-filter" type="search" placeholder="Filter people…" value={peopleFilter}
              onChange={(e) => setPeopleFilter(e.target.value)} />
            <div className="trp-table-wrap shs-people-table">
              <table className="trp-table">
                <thead><tr><th>Can see</th><th>Name</th><th>Department</th><th>Google email (for edit attribution)</th></tr></thead>
                <tbody>
                  {visiblePeople.map((p) => (
                    <tr key={p.id}>
                      <td><input type="checkbox" checked={members.has(p.id)} onChange={() => toggleMember(p.id)} aria-label={`Let ${p.name} see this sheet`} /></td>
                      <td>{p.name}</td>
                      <td>{p.department || '—'}</td>
                      <td>
                        <input className="shs-email" defaultValue={p.googleEmailIsOverride ? p.googleEmail : ''} placeholder={p.email}
                          onBlur={(e) => saveGoogleEmail(p, e.target.value)} aria-label={`Google email for ${p.name}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="shs-muted shs-small">
              What each person can do with it (Open, Open in Google Sheets, Settings) is set in Admin Queue &rarr; Sheet Access.
            </p>
          </section>
          ) : (
            !editing && (
              <p className="shs-muted shs-small">
                You will be able to open and manage this sheet. An admin decides who else can see it.
              </p>
            )
          )}

          <div className="shs-actions">
            {editing && isAdmin && <button type="button" className="shs-danger-btn" onClick={remove} disabled={Boolean(busy)}>Remove sheet</button>}
            <span className="shs-spacer" />
            <button type="button" className="shs-secondary-btn" onClick={onCancel} disabled={Boolean(busy)}>Cancel</button>
            <button type="button" className="trp-generate-btn" onClick={save}
              disabled={Boolean(busy) || !name.trim() || !tabs.some((t) => t.tracked)}>
              {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Add sheet'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
