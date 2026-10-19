import { useEffect, useRef, useState } from 'react';
import {
  DATE_PRESETS, WEEKDAYS, MONTH_FMT, addMonths, computePresetDates, daysBetween, formatRange, fromIso,
  monthGrid, sameDay, startOfDay, toIso,
} from './dateRanges';
import './DateRangePicker.css';

// Calendar range picker for the Usage & Spend report: one button showing the
// current range, opening quick presets (one click applies) and a two-month
// calendar (click a start day, then an end day; Apply confirms). Nothing is
// fetched until a range is applied, unlike the old pair of date inputs that
// reloaded the report on every keystroke.

const CalendarIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M7 2v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z" />
  </svg>
);
const Chevron = ({ dir }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d={dir === 'left' ? 'M15.4 7.4L14 6l-6 6 6 6 1.4-1.4L10.8 12z' : 'M8.6 16.6L10 18l6-6-6-6-1.4 1.4 4.6 4.6z'} />
  </svg>
);

export default function DateRangePicker({ start, end, presetKey, onChange, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(null);
  const [draftEnd, setDraftEnd] = useState(null);
  const [hoverDay, setHoverDay] = useState(null);
  const [viewMonth, setViewMonth] = useState(() => addMonths(fromIso(end) || new Date(), -1));
  const wrapRef = useRef(null);
  const today = startOfDay(new Date());

  const openPicker = () => {
    const s = fromIso(start);
    const e = fromIso(end);
    setDraftStart(s);
    setDraftEnd(e);
    setHoverDay(null);
    // Show the end month on the right, so the selected range is in view.
    setViewMonth(addMonths(e || today, -1));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const applyPreset = (key) => {
    const range = computePresetDates(key);
    onChange(range, key);
    setOpen(false);
  };

  const pickDay = (day) => {
    if (day > today) return;
    if (!draftStart || draftEnd) {
      setDraftStart(day);
      setDraftEnd(null);
      return;
    }
    if (day < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(day);
    } else {
      setDraftEnd(day);
    }
  };

  const apply = () => {
    if (!draftStart) return;
    const finalEnd = draftEnd || draftStart;
    onChange({ start: toIso(draftStart), end: toIso(finalEnd) }, 'custom');
    setOpen(false);
  };

  // While choosing the end day, the hovered day previews the range.
  const previewEnd = draftEnd || (draftStart && hoverDay && hoverDay >= draftStart ? hoverDay : null);
  const inRange = (day) => draftStart && previewEnd && day >= draftStart && day <= previewEnd;

  const activePreset = DATE_PRESETS.find((p) => p.key === presetKey);
  const buttonLabel = activePreset ? activePreset.label : formatRange(start, end);
  const draftDays = draftStart ? daysBetween(draftStart, draftEnd || draftStart) : 0;
  const canGoNext = addMonths(viewMonth, 2) <= addMonths(today, 1);

  const renderMonth = (monthStart) => (
    <div className="drp-month" key={toIso(monthStart)}>
      <div className="drp-month-title">{monthStart.toLocaleDateString('en-IN', MONTH_FMT)}</div>
      <div className="drp-grid drp-weekdays">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="drp-grid">
        {monthGrid(monthStart).map((day, i) => {
          if (!day) return <span key={`blank-${i}`} className="drp-day blank" />;
          const disabled = day > today;
          const isStart = sameDay(day, draftStart);
          const isEnd = sameDay(day, previewEnd);
          const classes = [
            'drp-day',
            inRange(day) ? 'in-range' : '',
            isStart ? 'start' : '',
            isEnd ? 'end' : '',
            sameDay(day, today) ? 'today' : '',
            disabled ? 'disabled' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              type="button"
              key={toIso(day)}
              className={classes}
              disabled={disabled}
              onClick={() => pickDay(day)}
              onMouseEnter={() => setHoverDay(day)}
              aria-label={day.toDateString()}
              aria-pressed={isStart || isEnd}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="drp" ref={wrapRef}>
      <button
        type="button"
        className={`drp-trigger ${open ? 'open' : ''}`}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={formatRange(start, end)}
      >
        <CalendarIcon />
        <span className="drp-trigger-label">{buttonLabel}</span>
        {activePreset && <span className="drp-trigger-dates">{formatRange(start, end)}</span>}
        <span className="drp-caret" />
      </button>

      {open && (
        <div className={`drp-pop drp-align-${align}`} role="dialog" aria-label="Choose a date range">
          <div className="drp-presets">
            {DATE_PRESETS.map((p) => (
              <button
                type="button"
                key={p.key}
                className={p.key === presetKey ? 'active' : ''}
                onClick={() => applyPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="drp-body">
            <div className="drp-nav">
              <button type="button" onClick={() => setViewMonth((m) => addMonths(m, -1))} aria-label="Previous month">
                <Chevron dir="left" />
              </button>
              <span className="drp-hint">
                {!draftStart || draftEnd ? 'Click a start day' : 'Now click an end day'}
              </span>
              <button
                type="button"
                onClick={() => setViewMonth((m) => addMonths(m, 1))}
                disabled={!canGoNext}
                aria-label="Next month"
              >
                <Chevron dir="right" />
              </button>
            </div>
            <div className="drp-months" onMouseLeave={() => setHoverDay(null)}>
              {renderMonth(viewMonth)}
              {renderMonth(addMonths(viewMonth, 1))}
            </div>
            <div className="drp-footer">
              <span className="drp-summary">
                {draftStart
                  ? `${formatRange(toIso(draftStart), toIso(draftEnd || draftStart))} · ${draftDays} day${draftDays === 1 ? '' : 's'}`
                  : 'No dates picked'}
              </span>
              <div className="drp-footer-actions">
                <button type="button" className="drp-btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="drp-btn primary" onClick={apply} disabled={!draftStart}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
