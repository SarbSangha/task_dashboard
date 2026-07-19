import React, { useMemo, useState } from 'react';

/**
 * Lightweight sortable table.
 * columns: [{ key, label, num?, sortable?, render?(row) }]
 * rows: array of objects
 * onRowClick?(row)
 */
const DataTable = ({ columns, rows, onRowClick, initialSort, initialDir = 'desc' }) => {
  const [sortKey, setSortKey] = useState(initialSort || null);
  const [dir, setDir] = useState(initialDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      const as = `${av ?? ''}`.toLowerCase();
      const bs = `${bv ?? ''}`.toLowerCase();
      return dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return copy;
  }, [rows, sortKey, dir]);

  const toggleSort = (col) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setDir(col.num ? 'desc' : 'asc');
    }
  };

  return (
    <div className="rpt-table-wrap">
      <table className="rpt-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={col.num ? 'num' : ''}
                onClick={() => toggleSort(col)}
                aria-sort={sortKey === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                {col.label}
                {col.sortable !== false && (
                  <span className="sort">{sortKey === col.key ? (dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, ri) => (
            <tr
              key={row.id ?? row.userId ?? ri}
              className={onRowClick ? 'clickable' : ''}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className={col.num ? 'num' : ''}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} style={{ textAlign: 'center', padding: 28, color: 'var(--color-text-muted)' }}>
                No data in the selected range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

export default DataTable;
