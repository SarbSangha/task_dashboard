const Icon = ({ size = 14, children, strokeWidth = 1.8, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    {children}
  </svg>
);

export const IconFolder = (props) => (
  <Icon {...props}><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /></Icon>
);
export const IconUsers = (props) => (
  <Icon {...props}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19" /></Icon>
);
export const IconClock = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Icon>
);
export const IconCalendar = (props) => (
  <Icon {...props}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Icon>
);
export const IconFlag = (props) => (
  <Icon {...props}><path d="M5 21V4.5" /><path d="M5 5h11l-2 4 2 4H5" /></Icon>
);
export const IconChat = (props) => (
  <Icon {...props}><path d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" /></Icon>
);
export const IconArrowRight = (props) => (
  <Icon {...props}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>
);
export const IconChevronDown = (props) => (
  <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>
);
export const IconLink = (props) => (
  <Icon {...props}><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></Icon>
);
export const IconPaperclip = (props) => (
  <Icon {...props}><path d="m20.5 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></Icon>
);
export const IconRoute = (props) => (
  <Icon {...props}><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" /></Icon>
);
export const IconMore = (props) => (
  <Icon {...props}><circle cx="12" cy="5" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="19" r="1.2" fill="currentColor" /></Icon>
);
export const IconCopy = (props) => (
  <Icon {...props}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></Icon>
);
export const IconEye = (props) => (
  <Icon {...props}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></Icon>
);
export const IconDownload = (props) => (
  <Icon {...props}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 19h14" /></Icon>
);
export const IconAlert = (props) => (
  <Icon {...props}><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5" /><path d="M12 17.2h.01" strokeWidth="2.6" /></Icon>
);
export const IconPause = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></Icon>
);
export const IconCheckCircle = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" /></Icon>
);
export const IconSend = (props) => (
  <Icon {...props}><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5Z" /></Icon>
);
