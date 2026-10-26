import { useMemo, useState, type ReactElement, type ReactNode, type KeyboardEvent } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell content. Default: `String(sortValue)`. */
  render?: (row: T, index: number) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => number | string | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Header tooltip. */
  title?: string;
  className?: string;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  initialSort?: SortState;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Render at most this many rows (with a footer note). */
  maxRows?: number;
  empty?: ReactNode;
  caption?: string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  stickyHeader?: boolean;
}

function compare(a: number | string | null | undefined, b: number | string | null | undefined): number {
  const an = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  initialSort,
  onRowClick,
  selectedKey,
  maxRows,
  empty,
  caption,
  dense = false,
  rowClassName,
  stickyHeader = true,
}: DataTableProps<T>): ReactElement {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const copy = rows.slice();
    copy.sort((x, y) => {
      const va = get(x);
      const vb = get(y);
      // Nulls always last regardless of direction.
      const nullA = va === null || va === undefined;
      const nullB = vb === null || vb === undefined;
      if (nullA || nullB) return compare(va, vb);
      const c = compare(va, vb);
      return sort.dir === 'asc' ? c : -c;
    });
    return copy;
  }, [rows, sort, columns]);

  const visible = maxRows !== undefined ? sorted.slice(0, maxRows) : sorted;

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
      return { key, dir: 'desc' };
    });
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className="table-wrap">
      <table className={`data-table${dense ? ' dense' : ''}${stickyHeader ? ' sticky' : ''}`}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = Boolean(c.sortValue);
              const active = sort?.key === c.key;
              const ariaSort = active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={`${c.align ? `align-${c.align}` : ''} ${c.className ?? ''}`}
                  style={c.width !== undefined ? { width: c.width } : undefined}
                  aria-sort={ariaSort}
                  title={c.title}
                >
                  {sortable ? (
                    <button type="button" className={`th-sort${active ? ' active' : ''}`} onClick={() => toggleSort(c.key)}>
                      <span>{c.header}</span>
                      <span className="sort-arrow" aria-hidden="true">
                        {active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td className="table-empty" colSpan={columns.length}>
                {empty ?? 'No rows'}
              </td>
            </tr>
          ) : (
            visible.map((row, i) => {
              const key = rowKey(row, i);
              const cls = [onRowClick ? 'clickable' : '', selectedKey === key ? 'selected' : '', rowClassName?.(row) ?? '']
                .filter(Boolean)
                .join(' ');
              return (
                <tr
                  key={key}
                  className={cls || undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={onRowClick ? selectedKey === key : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`${c.align ? `align-${c.align}` : ''} ${c.className ?? ''}`}>
                      {c.render ? c.render(row, i) : String(c.sortValue?.(row) ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {maxRows !== undefined && sorted.length > maxRows ? (
        <div className="table-footnote">
          Showing {maxRows.toLocaleString()} of {sorted.length.toLocaleString()} rows
        </div>
      ) : null}
    </div>
  );
}
