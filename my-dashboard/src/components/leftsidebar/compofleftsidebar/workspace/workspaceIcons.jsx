// Line icons for Workspace tabs and quick links (replace the old emoji set).
const Icon = ({ size = 16, children, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    {children}
  </svg>
);

export const IconOverview = (props) => (
  <Icon {...props}><rect x="3.5" y="3.5" width="7" height="8" rx="1.8" /><rect x="13.5" y="3.5" width="7" height="5" rx="1.8" /><rect x="13.5" y="11.5" width="7" height="9" rx="1.8" /><rect x="3.5" y="14.5" width="7" height="6" rx="1.8" /></Icon>
);
export const IconProjects = (props) => (
  <Icon {...props}><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /></Icon>
);
export const IconTeam = (props) => (
  <Icon {...props}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19" /></Icon>
);
export const IconCompany = (props) => (
  <Icon {...props}><path d="M4 20.5V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14 5.5v15" /><path d="M14 9.5h4.5A1.5 1.5 0 0 1 20 11v9.5" /><path d="M3 20.5h18" /><path d="M7.5 8h3M7.5 11.5h3M7.5 15h3" /></Icon>
);
export const IconAnalytics = (props) => (
  <Icon {...props}><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></Icon>
);
export const IconTools = (props) => (
  <Icon {...props}><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" /><path d="M3.5 12.5h17" /></Icon>
);
export const IconCompass = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="m15.5 8.5-2 5-5 2 2-5Z" /></Icon>
);
export const IconFilm = (props) => (
  <Icon {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" /></Icon>
);
export const IconCapture = (props) => (
  <Icon {...props}><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const IconSpark = (props) => (
  <Icon {...props}><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18" /></Icon>
);
export const IconDocument = (props) => (
  <Icon {...props}><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" /></Icon>
);
export const IconCredits = (props) => (
  <Icon {...props}><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></Icon>
);
export const IconChart = (props) => (
  <Icon {...props}><path d="M4 19.5 9 13l4 3.5 7-9" /><path d="M15.5 7.5H20V12" /></Icon>
);
export const IconChevronDown = (props) => (
  <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>
);
export const IconArrowRight = (props) => (
  <Icon {...props}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>
);
