import { useId, type ReactNode } from 'react';

export type OfficeIconName =
  | 'home' | 'dashboard' | 'history' | 'approval' | 'plus' | 'calendar'
  | 'list' | 'search' | 'chevron' | 'close' | 'more' | 'send' | 'refresh'
  | 'file' | 'check' | 'chef' | 'settings' | 'back' | 'analytics' | 'pin';

export type OfficeIconProps = {
  name: OfficeIconName;
  size?: number;
  className?: string;
};

const icons: Record<Exclude<OfficeIconName, 'chef'>, ReactNode> = {
  home: <path d="m2.4 10 8.7-7.3a1.4 1.4 0 0 1 1.8 0l8.7 7.3v10.8a1.2 1.2 0 0 1-1.2 1.2h-5.2v-7.5H8.8V22H3.6a1.2 1.2 0 0 1-1.2-1.2Z" fill="currentColor" stroke="none" />,
  dashboard: <><rect x="3" y="3" width="18" height="18" rx="1.5" strokeWidth="2.4" /><path d="M9 3v18M15 3v18M3 10h6M15 10h6" strokeWidth="2.2" /></>,
  analytics: <><rect x="2.5" y="14" width="5" height="8" rx="1" fill="currentColor" stroke="none" /><rect x="9.5" y="8" width="5" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="16.5" y="2" width="5" height="20" rx="1" fill="currentColor" stroke="none" /></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6" /><path d="M12 7v5l3 2" /></>,
  approval: <><path d="M8.6 3.8A2 2 0 0 1 10.5 2h3a2 2 0 0 1 1.9 1.8H19a2.4 2.4 0 0 1 2.4 2.4v14a2.4 2.4 0 0 1-2.4 2.4H5a2.4 2.4 0 0 1-2.4-2.4v-14A2.4 2.4 0 0 1 5 3.8Z" fill="currentColor" stroke="none" /><path d="m7.1 13 3.3 3.3 6.7-7" stroke="white" strokeWidth="2.7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  calendar: <><rect x="3.5" y="5" width="17" height="16" rx="1.7" strokeWidth="2.1" /><path d="M7.5 2.5v5M16.5 2.5v5M3.5 10h17" strokeWidth="2.1" /><path d="M16 14h.1M13 17h.1" opacity=".45" strokeWidth="2.8" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13" strokeWidth="2" /><circle cx="3" cy="6" r="1.35" fill="currentColor" stroke="none" /><circle cx="3" cy="12" r="1.35" fill="currentColor" stroke="none" /><circle cx="3" cy="18" r="1.35" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.3" cy="10.3" r="7.4" strokeWidth="2.1" /><path d="m15.6 15.6 6 6" strokeWidth="2.1" /></>,
  chevron: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  close: <path d="m5.5 5.5 13 13M18.5 5.5l-13 13" />,
  more: <><circle cx="12" cy="4.5" r="1.65" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none" /><circle cx="12" cy="19.5" r="1.65" fill="currentColor" stroke="none" /></>,
  pin: <><path d="M10 3.3c3.8-.3 7.8 3.7 10.7 6.6 1.2 1.2 1.4 4.6 0 5.9-.8.8-2.6.8-3.4 0l-2.1-2.1-4.1 3.5L6.8 13l3.5-4.1-2.1-2.1c-.8-.8-.7-2.5.1-3.3Z" fill="currentColor" stroke="none" /><path d="m9.4 14.5-7 7" strokeWidth="2.5" /></>,
  send: <><path d="m21 3-7 18-4-7-7-4Z" /><path d="m10 14 11-11" /></>,
  refresh: <><path d="M20 8a8.5 8.5 0 0 0-14-3L3 8M3 3v5h5M4 16a8.5 8.5 0 0 0 14 3l3-3M16 16h5v5" /></>,
  file: <><path d="M14 2.2H6a2 2 0 0 0-2 2v15.6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.2Z" fill="currentColor" stroke="none" /><path d="M14 2.2v6h6" fill="white" fillOpacity=".6" stroke="none" /><path d="M8.3 11.6h4M8.3 15h7.4M8.3 18.4h5" stroke="white" strokeWidth="1.4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  settings: <><path d="m9.5 3-.6 2.5-2 .9-2.3-.7-2.5 4.4L4 12v2l-1.9 1.9 2.5 4.4 2.3-.7 2 .9.6 2.5h5l.6-2.5 2-.9 2.3.7 2.5-4.4L20 14v-2l1.9-1.9-2.5-4.4-2.3.7-2-.9-.6-2.5Z" transform="translate(0 -1) scale(1 .95)" /><circle cx="12" cy="12" r="3" /></>,
  back: <path d="m12 5-7 7 7 7M5 12h15" />,
};

// Decorative SVGs inherit their control's label; they never supply an accessible
// name or change a task's meaning, connection status, or permissions.
export function OfficeIcon({ name, size = 20, className }: OfficeIconProps) {
  const chefFillId = useId();
  if (name === 'chef') {
    return <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false" fill="none" stroke="#11170d" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <defs><linearGradient id={chefFillId} x1="0" y1="5" x2="0" y2="28" gradientUnits="userSpaceOnUse"><stop stopColor="#cbff68" /><stop offset="1" stopColor="#daf477" /></linearGradient></defs>
      <path d="M8.8 20.3C5.9 20 4 17.6 4 14.6 4 11.5 6.2 9 9.2 9c.5 0 1 .1 1.4.2C11.3 6.8 13.5 5.1 16 5.1s4.7 1.7 5.4 4.1c.4-.1.9-.2 1.4-.2 3 0 5.2 2.5 5.2 5.6 0 3-1.9 5.4-4.8 5.7v5.4a2.4 2.4 0 0 1-2.4 2.4h-9.6a2.4 2.4 0 0 1-2.4-2.4Z" fill={`url(#${chefFillId})`} />
      <path d="M8.8 22.4h14.4M12.7 17.8v4.6M19.3 17.8v4.6" />
    </svg>;
  }

  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}

export default OfficeIcon;
