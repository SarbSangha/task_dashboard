const Icon = ({ size = 16, children, strokeWidth = 1.8, ...props }) => (
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

export const IconSearch = (props) => (
  <Icon {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
);
export const IconPlus = (props) => (
  <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>
);
export const IconRefresh = (props) => (
  <Icon {...props}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></Icon>
);
export const IconSmile = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></Icon>
);
export const IconPaperclip = (props) => (
  <Icon {...props}><path d="m20.5 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></Icon>
);
export const IconFolder = (props) => (
  <Icon {...props}><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /></Icon>
);
export const IconSend = (props) => (
  <Icon {...props}><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5Z" /></Icon>
);
export const IconCheck = (props) => (
  <Icon {...props}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
);
export const IconClose = (props) => (
  <Icon {...props}><path d="M18 6 6 18M6 6l12 12" /></Icon>
);
export const IconReply = (props) => (
  <Icon {...props}><path d="M9.5 7 4.5 12l5 5" /><path d="M5 12h9a5.5 5.5 0 0 1 5.5 5.5V19" /></Icon>
);
export const IconPin = (props) => (
  <Icon {...props}><path d="M9 4h6l-1 5 3.5 3.5v1.5h-11v-1.5L10 9Z" /><path d="M12 14v6" /></Icon>
);
export const IconPinOff = (props) => (
  <Icon {...props}><path d="M9 4h6l-1 5 3.5 3.5v1.5h-11v-1.5L10 9Z" /><path d="M12 14v6" /><path d="M4 4l16 16" /></Icon>
);
export const IconCopy = (props) => (
  <Icon {...props}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></Icon>
);
export const IconEdit = (props) => (
  <Icon {...props}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></Icon>
);
export const IconTrash = (props) => (
  <Icon {...props}><path d="M4.5 7h15" /><path d="M9.5 7V5h5v2" /><path d="m6.5 7 .8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7" /><path d="M10.5 11v5M13.5 11v5" /></Icon>
);
export const IconBell = (props) => (
  <Icon {...props}><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></Icon>
);
export const IconBellOff = (props) => (
  <Icon {...props}><path d="M8.5 5.6A6 6 0 0 1 18 11v4" /><path d="M6 11v5.5L4.5 18H17" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /><path d="m3.5 3.5 17 17" /></Icon>
);
export const IconSelect = (props) => (
  <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Icon>
);
export const IconUsers = (props) => (
  <Icon {...props}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19" /></Icon>
);
export const IconUser = (props) => (
  <Icon {...props}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5a7 7 0 0 1 14 0" /></Icon>
);
export const IconArrowDown = (props) => (
  <Icon {...props}><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></Icon>
);
export const IconChevronLeft = (props) => (
  <Icon {...props}><path d="m15 18-6-6 6-6" /></Icon>
);
export const IconChevronDown = (props) => (
  <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>
);
export const IconMore = (props) => (
  <Icon {...props}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></Icon>
);
export const IconChat = (props) => (
  <Icon {...props}><path d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" /><path d="M8.5 9h7M8.5 12.5h4.5" /></Icon>
);
export const IconForward = (props) => (
  <Icon {...props}><path d="M14.5 7 19.5 12l-5 5" /><path d="M19 12h-9a5.5 5.5 0 0 0-5.5 5.5V19" /></Icon>
);
export const IconUpload = (props) => (
  <Icon {...props}><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></Icon>
);
export const IconAlert = (props) => (
  <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" strokeWidth="2.6" /></Icon>
);
