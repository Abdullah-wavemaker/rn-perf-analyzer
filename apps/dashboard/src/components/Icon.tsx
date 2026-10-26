import type { ReactElement } from 'react';

/** Tiny stroke icon set (24px grid). Decorative unless `title` is given. */
const PATHS = {
  sessions: 'M4 6h16M4 12h16M4 18h10',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  devices: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  journeys: 'M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 17h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9M4 5v4h4M4 13a8 8 0 0 0 14.9 3.9M20 19v-4h-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  record: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  back: 'M15 6l-6 6 6 6',
  home: 'M4 11l8-7 8 7M6 10v10h12V10',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7.5v.5',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  cpu: 'M7 7h10v10H7zM10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15.5 8.5l-2 5-5 2 2-5z',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  file: 'M6 2h8l4 4v16H6zM14 2v4h4',
  timeline: 'M4 6h8M8 12h10M6 18h6',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5',
  emulator: 'M3 5h18v11H3zM8 20h8M12 16v4',
  cancel: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM5 5l14 14',
  hammer: 'M14 4l6 6-3 3-6-6zM11 7l-8 8 3 3 8-8',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, title, className }: { name: IconName; size?: number; title?: string; className?: string }): ReactElement {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
