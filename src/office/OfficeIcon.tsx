import type { ReactNode } from 'react';

export type OfficeIconName =
  | 'home' | 'dashboard' | 'history' | 'approval' | 'plus' | 'calendar'
  | 'list' | 'search' | 'chevron' | 'close' | 'more' | 'send' | 'refresh'
  | 'file' | 'check' | 'chef' | 'settings' | 'back';

export type OfficeIconProps = {
  name: OfficeIconName;
  size?: number;
  className?: string;
};

const icons: Record<Exclude<OfficeIconName, 'chef'>, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" fill="currentColor" stroke="none" /></>,
  dashboard: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M9 9h12M15 9v12" /></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6" /><path d="M12 7v5l3 2" /></>,
  approval: <><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M8 5H6a2 2 0 0 0-2 2v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a2 2 0 0 0-2-2h-2" /><rect x="8" y="5" width="8" height="3" rx="1" /><path d="m8 14 3 3 5-6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="3" cy="18" r="1" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  more: <><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" /></>,
  send: <><path d="m21 3-7 18-4-7-7-4Z" /><path d="m10 14 11-11" /></>,
  refresh: <><path d="M20 8a8.5 8.5 0 0 0-14-3L3 8M3 3v5h5M4 16a8.5 8.5 0 0 0 14 3l3-3M16 16h5v5" /></>,
  file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5" /><path d="M9 12h6M9 16h6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  settings: <><path d="m9.5 3-.6 2.5-2 .9-2.3-.7-2.5 4.4L4 12v2l-1.9 1.9 2.5 4.4 2.3-.7 2 .9.6 2.5h5l.6-2.5 2-.9 2.3.7 2.5-4.4L20 14v-2l1.9-1.9-2.5-4.4-2.3.7-2-.9-.6-2.5Z" transform="translate(0 -1) scale(1 .95)" /><circle cx="12" cy="12" r="3" /></>,
  back: <path d="m12 5-7 7 7 7M5 12h15" />,
};

// Decorative SVGs inherit their control's label; they never supply an accessible
// name or change a task's meaning, connection status, or permissions.
export function OfficeIcon({ name, size = 20, className }: OfficeIconProps) {
  if (name === 'chef') {
    return <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false" fill="none" stroke="#131813" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 20.4a6 6 0 0 1-4.7-7.1 5.8 5.8 0 0 1 6.5-4.5 6.8 6.8 0 0 1 12.1.3 5.8 5.8 0 0 1 6.4 4.8 6 6 0 0 1-4.3 6.5V26a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2Z" fill="#d3ff6b" />
      <path d="M8 23h16M12 17v6M20 17v6" />
    </svg>;
  }

  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}

export default OfficeIcon;
