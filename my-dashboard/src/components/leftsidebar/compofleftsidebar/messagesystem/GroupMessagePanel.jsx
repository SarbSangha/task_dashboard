import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useDynamicRowHeight } from 'react-window';
import './GroupMessagePanel.css';
import { directMessageAPI, fileAPI, groupAPI, isRequestCanceled, subscribeRealtimeNotifications } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  getTaskPanelCacheEntry,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import { GROUP_MESSAGES_KEY, useSendGroupMessage } from '../../../../hooks/useMessages';
import { formatMonthDayTimeIndia } from '../../../../utils/dateTime';
import { clearActiveChat, setActiveChat } from '../../../../utils/activeChat';
import ChatComposer from './ChatComposer';
import ChatThread from './ChatThread';
import PinnedMessagesBar from './PinnedMessagesBar';
import {
  buildAttachmentCountLabel,
  buildAvatarHue,
  buildConversationPreview,
  buildInitials,
  buildThreadItems,
  extractMentionIdsFromText,
  formatListTimestamp,
} from './chatUtils';
import {
  IconBell,
  IconBellOff,
  IconChat,
  IconChevronLeft,
  IconClose,
  IconForward,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSelect,
  IconUser,
  IconUsers,
} from './chatIcons';

const GROUP_PANEL_CACHE_TTL_MS = 2 * 60 * 1000;
const GROUP_MESSAGES_CACHE_TTL_MS = 90 * 1000;
const TYPING_STOP_DELAY_MS = 1800;
const TYPING_REMOTE_TTL_MS = 4200;
const TYPING_REFRESH_INTERVAL_MS = 2500;
const FEEDBACK_DISMISS_MS = 4500;
const HIGHLIGHT_DURATION_MS = 2200;
const ERROR_FEEDBACK_PATTERN = /fail|unable|cannot|could not|not found|required|choose at least|select at least/i;

const createInitialForwardState = () => ({
  open: false,
  groupIds: [],
  userIds: [],
  note: '',
  sending: false,
});

const createInitialDeleteConfirmationState = () => ({
  open: false,
  mode: null,
  message: null,
  threadId: null,
  threadLabel: '',
  deleting: false,
});

const createInitialAttachmentUploadState = () => ({
  active: false,
  fileCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  currentFileName: '',
  currentFileIndex: 0,
  currentFileUploadedBytes: 0,
  currentFileTotalBytes: 0,
  currentFilePercent: 0,
});

const getUploadBytesTotal = (files = []) =>
  files.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);

const toUploadPercent = (loaded = 0, total = 0) => {
  if (!total) return 0;
  return Math.min(100, Math.round((loaded * 100) / total));
};

const buildAttachmentUploadState = (files = []) => {
  const firstFile = files[0] || null;
  const totalBytes = getUploadBytesTotal(files);
  const currentFileTotalBytes = Math.max(Number(firstFile?.size) || 0, 0);

  return {
    ...createInitialAttachmentUploadState(),
    active: files.length > 0,
    fileCount: files.length,
    totalBytes,
    currentFileName: firstFile ? getAttachmentDisplayName(firstFile) : '',
    currentFileIndex: firstFile ? 1 : 0,
    currentFileTotalBytes,
  };
};

const formatUnreadCount = (count = 0) => {
  if (!count) return '';
  return count > 99 ? '99+' : `${count}`;
};

const createInitialComposerDraft = () => ({
  text: '',
  attachments: [],
  uploading: false,
  uploadState: createInitialAttachmentUploadState(),
});

const appendMessageById = (rows = [], nextMessage) => {
  if (!nextMessage?.id) return rows;
  if (rows.some((row) => row.id === nextMessage.id)) return rows;
  return [...rows, nextMessage];
};

const replaceMessageById = (rows = [], messageId, nextMessage) => {
  if (!messageId || !nextMessage) return rows;
  const nextMessageId = nextMessage?.id;
  let replaced = false;
  const nextRows = rows.reduce((acc, row) => {
    if (!row) return acc;
    if (row?.id === nextMessageId && row?.id !== messageId) {
      return acc;
    }
    if (row?.id !== messageId) {
      acc.push(row);
      return acc;
    }
    replaced = true;
    acc.push(nextMessage);
    return acc;
  }, []);
  return replaced ? nextRows : appendMessageById(rows, nextMessage);
};

const removeMessageById = (rows = [], messageId) =>
  rows.filter((row) => row?.id !== messageId);

const createFailedMessageFromPayload = ({
  attachments = [],
  currentUserId,
  forwardMetadata = null,
  id,
  message = '',
  mode,
  payload = null,
  replyTo = null,
  senderName = 'You',
  threadId = null,
}) => ({
  id,
  senderId: currentUserId,
  senderName,
  recipientId: mode === 'direct' ? threadId : undefined,
  message,
  replyTo,
  attachments,
  forwardMetadata,
  createdAt: new Date().toISOString(),
  editedAt: null,
  deletedAt: null,
  failed: true,
  failedPayload: payload,
  failedMode: mode,
  failedThreadId: threadId,
});

const formatReceiptTimestamp = (value) => {
  const formatted = formatMonthDayTimeIndia(value);
  return formatted === 'N/A' ? '' : formatted;
};

function ReceiptPersonRow({ person, timestamp, fallbackLabel }) {
  const subtitle = [person?.department, person?.position].filter(Boolean).join(', ') || fallbackLabel;

  return (
    <div className="message-receipt-person-row">
      <div
        className="person-avatar person-avatar--sm"
        style={{ '--avatar-hue': `${buildAvatarHue(person?.name)}deg` }}
      >
        {buildInitials(person?.name)}
      </div>
      <div className="message-receipt-person-copy">
        <strong>{person?.name || 'Unknown'}</strong>
        <span>{subtitle}</span>
      </div>
      <small>{formatReceiptTimestamp(timestamp) || fallbackLabel}</small>
    </div>
  );
}

function ReceiptSection({ emptyLabel, fallbackLabel, items, title }) {
  return (
    <section className="message-receipt-section">
      <div className="message-receipt-section-title">
        <span>{title}</span>
        <strong>{items.length}</strong>
      </div>
      {items.length === 0 ? (
        <div className="message-receipt-empty">{emptyLabel}</div>
      ) : (
        <div className="message-receipt-person-list">
          {items.map((item) => (
            <ReceiptPersonRow
              key={item.id}
              fallbackLabel={fallbackLabel}
              person={item}
              timestamp={item.seenAt || item.deliveredAt}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MessageReceiptDetailsModal({
  deliveredItems,
  message,
  onClose,
  pendingItems,
  readItems,
}) {
  if (!message) return null;

  return (
    <div className="chat-modal-overlay" onClick={onClose}>
      <div className="chat-modal message-receipt-modal" role="dialog" aria-modal="true" aria-labelledby="message-receipt-title" onClick={(event) => event.stopPropagation()}>
        <div className="chat-modal-header">
          <div>
            <h4 id="message-receipt-title">Message info</h4>
            <p>{formatReceiptTimestamp(message.createdAt) || 'Sent message'}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close message info">
            <IconClose size={16} />
          </button>
        </div>

        <div className="message-receipt-preview">
          <span>{message.message || buildAttachmentCountLabel(message.attachments) || 'Message'}</span>
        </div>

        <div className="message-receipt-summary-grid">
          <div>
            <strong>{readItems.length}</strong>
            <span>Seen</span>
          </div>
          <div>
            <strong>{deliveredItems.length}</strong>
            <span>Delivered</span>
          </div>
          <div>
            <strong>{pendingItems.length}</strong>
            <span>Waiting</span>
          </div>
        </div>

        <div className="message-receipt-sections">
          <ReceiptSection
            emptyLabel="No one has seen this message yet."
            fallbackLabel="Seen"
            items={readItems}
            title="Seen by"
          />
          <ReceiptSection
            emptyLabel="No delivered-only members yet."
            fallbackLabel="Delivered"
            items={deliveredItems}
            title="Delivered to"
          />
          <ReceiptSection
            emptyLabel="Everyone has received this message."
            fallbackLabel="Waiting"
            items={pendingItems}
            title="Waiting for"
          />
        </div>
      </div>
    </div>
  );
}

const buildGroupSearchText = (group) => [
  group?.name,
  group?.myRole,
  group?.memberCount,
  group?.lastMessagePreview,
  ...(Array.isArray(group?.members)
    ? group.members.map((member) => `${member?.name || ''} ${member?.email || ''} ${member?.department || ''} ${member?.position || ''}`)
    : []),
].filter(Boolean).join(' ').toLowerCase();

const buildDirectSearchText = (item) => [
  item?.name,
  item?.email,
  item?.department,
  item?.position,
  item?.conversation?.lastMessagePreview,
].filter(Boolean).join(' ').toLowerCase();

const getPresenceStatus = (presence) => `${presence?.status || 'OFFLINE'}`.toUpperCase();

const getPresenceClassName = (presence) => {
  const status = getPresenceStatus(presence).toLowerCase();
  if (['active', 'idle', 'away'].includes(status)) return status;
  return 'offline';
};

const getPresenceLabel = (presence) => {
  const status = getPresenceStatus(presence);
  if (status === 'ACTIVE') return 'Online';
  if (status === 'IDLE') return 'Idle';
  if (status === 'AWAY') return 'Away';

  if (presence?.lastSeen) {
    const formatted = formatMonthDayTimeIndia(presence.lastSeen);
    return formatted && formatted !== 'N/A' ? `Last seen ${formatted}` : 'Offline';
  }

  return 'Offline';
};

const getOnlineMemberCount = (members = []) =>
  members.filter((member) => member?.presence?.isOnline).length;

const buildTypingLabel = (items = [], fallbackName = 'Someone') => {
  const names = items.map((item) => item?.name).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0] || fallbackName} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing…`;
};

const firstName = (value = '') => `${value}`.trim().split(/\s+/)[0] || value;

const applyMessageReactionData = (rows, messageId, reactionData) =>
  rows.map((message) => (
    message.id === messageId
      ? {
          ...message,
          reactions: reactionData?.reactions || [],
          myReaction: reactionData?.myReaction || null,
        }
      : message
  ));

const applyMessageMutationData = (rows, messageId, data = {}) =>
  rows.map((message) => (
    message.id === messageId
      ? {
          ...message,
          ...data,
          attachments: data.attachments || message.attachments || [],
          reactions: data.reactions || message.reactions || [],
          myReaction: data.myReaction === undefined ? message.myReaction : data.myReaction,
        }
      : message
  ));

const replaceMessageWithFailedMessage = (rows = [], messageId, failedMessage) => {
  let replaced = false;
  const nextRows = rows.map((message) => {
    if (message?.id !== messageId) return message;
    replaced = true;
    return failedMessage;
  });
  return replaced ? nextRows : appendMessageById(nextRows, failedMessage);
};

const upsertDirectConversation = (rows = [], conversation) => {
  if (!conversation?.user?.id) return rows;

  const nextRows = [
    conversation,
    ...rows.filter((entry) => entry?.user?.id !== conversation.user.id),
  ];

  return nextRows.sort((left, right) => {
    const leftValue = `${left?.lastMessageAt || ''}`;
    const rightValue = `${right?.lastMessageAt || ''}`;
    return rightValue.localeCompare(leftValue);
  });
};

function ThreadLoadingState() {
  return (
    <div className="chat-thread-loading" role="status" aria-label="Loading messages">
      {['is-theirs', 'is-theirs is-short', 'is-mine', 'is-theirs', 'is-mine is-short'].map((variant, index) => (
        <span key={index} className={`chat-thread-loading-bubble ${variant}`} />
      ))}
    </div>
  );
}

function ChatEmptyState({ icon: EmptyIcon, title, text }) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon"><EmptyIcon size={24} /></div>
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}

const GroupMessagePanel = ({ isOpen = true, onClose, variant = 'embedded', onMinimizedChange, onActivate }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const isActive = variant === 'embedded' || isOpen;
  const isActiveRef = useRef(isActive);
  const [activeTab, setActiveTab] = useState('groups');
  const [visibleListTab, setVisibleListTab] = useState('groups');
  const [messageSearch, setMessageSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isMessagesRefreshing, setIsMessagesRefreshing] = useState(false);
  const [groupsCacheStatus, setGroupsCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [hasResolvedGroupIndex, setHasResolvedGroupIndex] = useState(false);
  const [messageCacheStatus, setMessageCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [allUsers, setAllUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentUploadState, setAttachmentUploadState] = useState(createInitialAttachmentUploadState);
  const groupUploadAbortRef = useRef(null);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [groupComposerDrafts, setGroupComposerDrafts] = useState({});
  const [showAddMemberPanel, setShowAddMemberPanel] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [addMemberSelection, setAddMemberSelection] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [selectionMode, setSelectionMode] = useState(null);
  const [selectedGroupMessageIds, setSelectedGroupMessageIds] = useState([]);
  const [selectedDirectMessageIds, setSelectedDirectMessageIds] = useState([]);
  const [forwardState, setForwardState] = useState(createInitialForwardState);
  const [receiptDetailsMessageId, setReceiptDetailsMessageId] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [replyingMessage, setReplyingMessage] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(createInitialDeleteConfirmationState);
  const [groupPinned, setGroupPinned] = useState([]);
  const [directPinned, setDirectPinned] = useState([]);
  const [mutedGroupIds, setMutedGroupIds] = useState([]);
  const [mutedUserIds, setMutedUserIds] = useState([]);
  const [unreadMarker, setUnreadMarker] = useState(null);
  const [scrollRequest, setScrollRequest] = useState(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [createGroupFilter, setCreateGroupFilter] = useState('');
  const [pendingMemberRemovalId, setPendingMemberRemovalId] = useState(null);
  const [groupThreadLoading, setGroupThreadLoading] = useState(false);
  const [directThreadLoading, setDirectThreadLoading] = useState(false);
  const shownGroupThreadRef = useRef(null);
  const shownDirectThreadRef = useRef(null);
  const groupRowHeight = useDynamicRowHeight({
    defaultRowHeight: 116,
    key: selectedGroupId || 'group-empty',
  });
  const selectedGroupIdRef = useRef(null);
  const groupMenuRef = useRef(null);
  const [directUsers, setDirectUsers] = useState([]);
  const [directConversations, setDirectConversations] = useState([]);
  const [selectedDirectUserId, setSelectedDirectUserId] = useState(null);
  const directRowHeight = useDynamicRowHeight({
    defaultRowHeight: 116,
    key: selectedDirectUserId || 'direct-empty',
  });
  const [directMessages, setDirectMessages] = useState([]);
  const [directLoading, setDirectLoading] = useState(true);
  const [directRefreshing, setDirectRefreshing] = useState(false);
  const [directMessagesRefreshing, setDirectMessagesRefreshing] = useState(false);
  const [directCacheStatus, setDirectCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [hasResolvedDirectIndex, setHasResolvedDirectIndex] = useState(false);
  const [directMessageCacheStatus, setDirectMessageCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [directNewMessage, setDirectNewMessage] = useState('');
  const [sendingDirectMessage, setSendingDirectMessage] = useState(false);
  const [uploadingDirectAttachment, setUploadingDirectAttachment] = useState(false);
  const [directAttachmentUploadState, setDirectAttachmentUploadState] = useState(createInitialAttachmentUploadState);
  const directUploadAbortRef = useRef(null);
  const [directPendingAttachments, setDirectPendingAttachments] = useState([]);
  const [directComposerDrafts, setDirectComposerDrafts] = useState({});
  const [groupUnreadCounts, setGroupUnreadCounts] = useState({});
  const [directUnreadCounts, setDirectUnreadCounts] = useState({});
  const [groupTypingByGroupId, setGroupTypingByGroupId] = useState({});
  const [directTypingByUserId, setDirectTypingByUserId] = useState({});
  const [showGroupComposer, setShowGroupComposer] = useState(false);
  const panelRef = useRef(null);
  const panelAnimationRef = useRef(null);
  const panelFlipRectRef = useRef(null);
  const selectedDirectUserIdRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const currentUserIdRef = useRef(currentUserId);
  const directUsersRef = useRef(directUsers);
  const directConversationsRef = useRef(directConversations);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const realtimeRefreshTimersRef = useRef({
    groupIndex: null,
    groupMessages: null,
    directIndex: null,
    directMessages: null,
    unreadCounts: null,
  });
  const syncGroupsPromiseRef = useRef(null);
  const syncDirectDataPromiseRef = useRef(null);
  const groupMessagesRequestRef = useRef({ groupId: null, promise: null });
  const directMessagesRequestRef = useRef({ userId: null, promise: null });
  const unreadCountsRequestRef = useRef(null);
  const localTypingRef = useRef({
    group: { threadId: null, active: false, lastSentAt: 0, timer: null },
    direct: { threadId: null, active: false, lastSentAt: 0, timer: null },
  });
  const remoteTypingTimersRef = useRef({});
  const hasBootstrappedDirectRef = useRef(false);
  const previousSelectedGroupIdRef = useRef(null);
  const previousSelectedDirectUserIdRef = useRef(null);
  const minimizedWindowStyle = useMinimizedWindowStack('group-message-panel', variant === 'overlay' && isOpen && isMinimized);
  isActiveRef.current = isActive;
  selectedGroupIdRef.current = selectedGroupId;
  selectedDirectUserIdRef.current = selectedDirectUserId;
  activeTabRef.current = activeTab;
  currentUserIdRef.current = currentUserId;
  directUsersRef.current = directUsers;
  directConversationsRef.current = directConversations;

  const updateGroupComposerDraft = (groupId, updater) => {
    if (!groupId) return;
    setGroupComposerDrafts((prev) => {
      const currentDraft = prev[groupId] || createInitialComposerDraft();
      const nextDraft = typeof updater === 'function'
        ? updater(currentDraft)
        : { ...currentDraft, ...updater };
      return {
        ...prev,
        [groupId]: nextDraft,
      };
    });
  };

  const updateDirectComposerDraft = (userId, updater) => {
    if (!userId) return;
    setDirectComposerDrafts((prev) => {
      const currentDraft = prev[userId] || createInitialComposerDraft();
      const nextDraft = typeof updater === 'function'
        ? updater(currentDraft)
        : { ...currentDraft, ...updater };
      return {
        ...prev,
        [userId]: nextDraft,
      };
    });
  };

  const hydrateGroupComposer = (draft = createInitialComposerDraft()) => {
    setNewMessage(draft.text || '');
    setPendingAttachments(Array.isArray(draft.attachments) ? draft.attachments : []);
    setUploadingAttachment(Boolean(draft.uploading));
    setAttachmentUploadState(draft.uploadState || createInitialAttachmentUploadState());
  };

  const hydrateDirectComposer = (draft = createInitialComposerDraft()) => {
    setDirectNewMessage(draft.text || '');
    setDirectPendingAttachments(Array.isArray(draft.attachments) ? draft.attachments : []);
    setUploadingDirectAttachment(Boolean(draft.uploading));
    setDirectAttachmentUploadState(draft.uploadState || createInitialAttachmentUploadState());
  };

  const incrementGroupUnreadCount = (groupId) => {
    if (!groupId) return;
    setGroupUnreadCounts((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] || 0) + 1,
    }));
  };

  const incrementDirectUnreadCount = (userId) => {
    if (!userId) return;
    setDirectUnreadCounts((prev) => ({
      ...prev,
      [userId]: (prev[userId] || 0) + 1,
    }));
  };

  const clearGroupUnreadCount = (groupId) => {
    if (!groupId) return;
    setGroupUnreadCounts((prev) => {
      if (!prev[groupId]) return prev;
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  };

  const clearDirectUnreadCount = (userId) => {
    if (!userId) return;
    setDirectUnreadCounts((prev) => {
      if (!prev[userId]) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const markGroupThreadSeen = (groupId) => {
    if (!groupId) return;
    clearGroupUnreadCount(groupId);
  };

  const markDirectThreadSeen = (userId) => {
    if (!userId) return;
    clearDirectUnreadCount(userId);
  };

  useEffect(() => {
    if (variant !== 'overlay') return;
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange, variant]);

  useEffect(() => {
    if (activeTab !== 'groups') {
      setShowGroupComposer(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'groups' && selectedGroupId) {
      markGroupThreadSeen(selectedGroupId);
    }
  }, [activeTab, currentUserId, selectedGroupId]);

  useEffect(() => {
    if (activeTab === 'direct' && selectedDirectUserId) {
      markDirectThreadSeen(selectedDirectUserId);
    }
  }, [activeTab, currentUserId, selectedDirectUserId]);

  useLayoutEffect(() => {
    const panelNode = panelRef.current;
    const firstRect = panelFlipRectRef.current;
    if (!panelNode || !firstRect || isMinimized) return;

    const lastRect = panelNode.getBoundingClientRect();
    const deltaX = firstRect.left - lastRect.left;
    const deltaY = firstRect.top - lastRect.top;
    const scaleX = firstRect.width / Math.max(lastRect.width, 1);
    const scaleY = firstRect.height / Math.max(lastRect.height, 1);

    panelFlipRectRef.current = null;

    if (
      Math.abs(deltaX) < 0.5 &&
      Math.abs(deltaY) < 0.5 &&
      Math.abs(scaleX - 1) < 0.01 &&
      Math.abs(scaleY - 1) < 0.01
    ) {
      return;
    }

    panelAnimationRef.current?.cancel();
    panelAnimationRef.current = panelNode.animate(
      [
        {
          transformOrigin: 'top left',
          transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
        },
        {
          transformOrigin: 'top left',
          transform: 'translate(0, 0) scale(1, 1)',
        },
      ],
      {
        duration: 260,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both',
      }
    );

    panelAnimationRef.current.addEventListener(
      'finish',
      () => {
        if (panelAnimationRef.current) {
          panelAnimationRef.current = null;
        }
      },
      { once: true }
    );

    return () => {
      panelAnimationRef.current?.cancel();
    };
  }, [isMaximized, isMinimized]);

  useEffect(() => {
    const previousGroupId = previousSelectedGroupIdRef.current;
    if (previousGroupId && previousGroupId !== selectedGroupId) {
      updateGroupComposerDraft(previousGroupId, {
        text: newMessage,
        attachments: pendingAttachments,
        uploading: uploadingAttachment,
        uploadState: attachmentUploadState,
      });
    }

    if (selectedGroupId) {
      hydrateGroupComposer(groupComposerDrafts[selectedGroupId] || createInitialComposerDraft());
    } else {
      hydrateGroupComposer(createInitialComposerDraft());
    }

    previousSelectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);

  useEffect(() => {
    const previousUserId = previousSelectedDirectUserIdRef.current;
    if (previousUserId && previousUserId !== selectedDirectUserId) {
      updateDirectComposerDraft(previousUserId, {
        text: directNewMessage,
        attachments: directPendingAttachments,
        uploading: uploadingDirectAttachment,
        uploadState: directAttachmentUploadState,
      });
    }

    if (selectedDirectUserId) {
      hydrateDirectComposer(directComposerDrafts[selectedDirectUserId] || createInitialComposerDraft());
    } else {
      hydrateDirectComposer(createInitialComposerDraft());
    }

    previousSelectedDirectUserIdRef.current = selectedDirectUserId;
  }, [selectedDirectUserId]);

  const cacheKeys = useMemo(() => {
    if (!user?.id) return null;
    return {
      groupIndex: buildTaskPanelCacheKey(user.id, 'group_message_panel'),
      groupMessages: (groupId) => buildTaskPanelCacheKey(user.id, `group_message_panel_messages_${groupId}`),
      directIndex: buildTaskPanelCacheKey(user.id, 'direct_message_panel'),
      directMessages: (otherUserId) => buildTaskPanelCacheKey(user.id, `direct_message_panel_messages_${otherUserId}`),
    };
  }, [user?.id]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const isSelectedGroupAdmin = !!selectedGroup && selectedGroup.myRole === 'admin';
  const selectedGroupOnlineCount = getOnlineMemberCount(selectedGroup?.members || []);
  const selectedDirectUser = useMemo(
    () =>
      directUsers.find((directUser) => directUser.id === selectedDirectUserId) ||
      directConversations.find((conversation) => conversation.user?.id === selectedDirectUserId)?.user ||
      null,
    [directConversations, directUsers, selectedDirectUserId]
  );
  const selectedGroupTypingLabel = buildTypingLabel(
    Object.values(groupTypingByGroupId[selectedGroupId] || {})
  );
  const selectedDirectTypingLabel = buildTypingLabel(
    Object.values(directTypingByUserId[selectedDirectUserId] || {}),
    selectedDirectUser?.name || 'Someone'
  );
  const isEditingGroupMessage = editingMessage?.mode === 'group';
  const isEditingDirectMessage = editingMessage?.mode === 'direct';
  const isReplyingGroupMessage = replyingMessage?.mode === 'group';
  const isReplyingDirectMessage = replyingMessage?.mode === 'direct';
  const updateEditingMessageText = (text) => {
    setEditingMessage((prev) => (prev ? { ...prev, text } : prev));
  };
  const withGroupReceiptDefault = (message, group = selectedGroup) => {
    if (!message || message.receipt || Number(message.senderId) !== Number(currentUserId)) return message;
    const totalRecipientCount = Math.max((group?.members || []).filter((member) => Number(member.id) !== Number(currentUserId)).length, 0);
    return {
      ...message,
      receipt: {
        status: 'sent',
        totalRecipientCount,
        deliveredCount: 0,
        deliveredBy: [],
        readCount: 0,
        readBy: [],
      },
    };
  };
  const withDirectReceiptDefault = (message) => {
    if (!message || message.receipt || Number(message.senderId) !== Number(currentUserId)) return message;
    return {
      ...message,
      receipt: {
        status: 'sent',
        totalRecipientCount: 1,
        deliveredCount: 0,
        deliveredBy: [],
        readCount: 0,
        readBy: [],
      },
    };
  };
  const isBrowserTabVisible = () =>
    typeof document === 'undefined' || document.visibilityState === 'visible';
  const acknowledgeGroupMessagesDelivered = (groupId) => {
    if (!groupId) return;
    groupAPI.markMessagesDelivered(groupId).catch((error) => {
      console.error('Failed to mark group messages delivered:', error);
    });
  };
  const acknowledgeDirectMessagesDelivered = (userId) => {
    if (!userId) return;
    directMessageAPI.markMessagesDelivered(userId).catch((error) => {
      console.error('Failed to mark direct messages delivered:', error);
    });
  };
  const acknowledgeGroupMessagesRead = (groupId) => {
    if (!groupId || activeTabRef.current !== 'groups' || selectedGroupIdRef.current !== groupId || !isBrowserTabVisible()) return;
    markGroupThreadSeen(groupId);
    groupAPI.markMessagesRead(groupId)
      .then(() => syncUnreadCounts({ silent: true }))
      .catch((error) => {
        console.error('Failed to mark group messages read:', error);
      });
  };
  const acknowledgeDirectMessagesRead = (userId) => {
    if (!userId || activeTabRef.current !== 'direct' || selectedDirectUserIdRef.current !== userId || !isBrowserTabVisible()) return;
    markDirectThreadSeen(userId);
    directMessageAPI.markMessagesRead(userId)
      .then(() => syncUnreadCounts({ silent: true }))
      .catch((error) => {
        console.error('Failed to mark direct messages read:', error);
      });
  };
  const updateRemoteTyping = ({ scope, threadId, userId, userName, active }) => {
    const numericThreadId = Number(threadId);
    const numericUserId = Number(userId);
    if (!scope || !numericThreadId || !numericUserId || numericUserId === currentUserIdRef.current) return;

    const timerKey = `${scope}:${numericThreadId}:${numericUserId}`;
    if (remoteTypingTimersRef.current[timerKey]) {
      clearTimeout(remoteTypingTimersRef.current[timerKey]);
      delete remoteTypingTimersRef.current[timerKey];
    }

    const setTypingState = scope === 'group' ? setGroupTypingByGroupId : setDirectTypingByUserId;
    setTypingState((prev) => {
      const currentThread = prev[numericThreadId] || {};
      if (!active) {
        const { [numericUserId]: _removed, ...remainingThread } = currentThread;
        const { [numericThreadId]: _threadRemoved, ...remaining } = prev;
        return Object.keys(remainingThread).length
          ? { ...remaining, [numericThreadId]: remainingThread }
          : remaining;
      }

      return {
        ...prev,
        [numericThreadId]: {
          ...currentThread,
          [numericUserId]: {
            id: numericUserId,
            name: userName || 'Someone',
            updatedAt: Date.now(),
          },
        },
      };
    });

    if (active) {
      remoteTypingTimersRef.current[timerKey] = setTimeout(() => {
        updateRemoteTyping({ scope, threadId: numericThreadId, userId: numericUserId, userName, active: false });
      }, TYPING_REMOTE_TTL_MS);
    }
  };
  const emitTyping = (scope, threadId, active) => {
    if (!threadId || !isActiveRef.current) return;
    const bucket = localTypingRef.current[scope];
    const numericThreadId = Number(threadId);
    const now = Date.now();
    const shouldSend =
      !bucket.active ||
      bucket.threadId !== numericThreadId ||
      !active ||
      now - bucket.lastSentAt > TYPING_REFRESH_INTERVAL_MS;

    if (!shouldSend) return;
    bucket.active = active;
    bucket.threadId = numericThreadId;
    bucket.lastSentAt = now;

    const request = scope === 'group'
      ? groupAPI.sendTyping(numericThreadId, active)
      : directMessageAPI.sendTyping(numericThreadId, active);
    request.catch(() => {});
  };
  const stopTyping = (scope, threadId) => {
    const bucket = localTypingRef.current[scope];
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
    if (bucket.active && (!threadId || Number(threadId) === bucket.threadId)) {
      emitTyping(scope, bucket.threadId, false);
    }
    bucket.active = false;
    bucket.threadId = null;
  };
  const handleTypingInput = (scope, threadId, value) => {
    const bucket = localTypingRef.current[scope];
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }

    if (!`${value || ''}`.trim()) {
      stopTyping(scope, threadId);
      return;
    }

    emitTyping(scope, threadId, true);
    bucket.timer = setTimeout(() => stopTyping(scope, threadId), TYPING_STOP_DELAY_MS);
  };
  const handleMessageReaction = async (mode, message, emoji) => {
    if (!message?.id || message.isOptimistic) return;

    const isRemoving = message.myReaction === emoji;
    try {
      if (mode === 'group') {
        if (!selectedGroupIdRef.current) return;
        const response = isRemoving
          ? await groupAPI.removeReaction(selectedGroupIdRef.current, message.id)
          : await groupAPI.setReaction(selectedGroupIdRef.current, message.id, emoji);
        setMessages((prev) => applyMessageReactionData(prev, message.id, response?.data));
        return;
      }

      if (!selectedDirectUserIdRef.current) return;
      const response = isRemoving
        ? await directMessageAPI.removeReaction(selectedDirectUserIdRef.current, message.id)
        : await directMessageAPI.setReaction(selectedDirectUserIdRef.current, message.id, emoji);
      setDirectMessages((prev) => applyMessageReactionData(prev, message.id, response?.data));
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to update reaction.');
    }
  };
  const handleEditMessage = (mode, message) => {
    if (!message?.id || message.isOptimistic || message.deletedAt) return;
    stopTyping(mode, mode === 'group' ? selectedGroupIdRef.current : selectedDirectUserIdRef.current);
    setReplyingMessage(null);
    setEditingMessage({
      mode,
      messageId: message.id,
      originalText: message.message || '',
      text: message.message || '',
      saving: false,
    });
  };
  const cancelEditMessage = () => {
    setEditingMessage(null);
  };
  const handleReplyToMessage = (mode, message) => {
    if (!message?.id || message.isOptimistic || message.deletedAt) return;
    setEditingMessage(null);
    setReplyingMessage({
      mode,
      messageId: message.id,
      senderName: message.senderName || 'Unknown',
      message: message.message || '',
      attachments: message.attachments || [],
      deletedAt: message.deletedAt || null,
    });
  };
  const cancelReplyToMessage = () => {
    setReplyingMessage(null);
  };
  const submitEditMessage = async () => {
    if (!editingMessage?.messageId || editingMessage.saving) return;
    const trimmedText = editingMessage.text.trim();
    if (!trimmedText) return;
    if (trimmedText === (editingMessage.originalText || '').trim()) {
      setEditingMessage(null);
      return;
    }

    setEditingMessage((prev) => (prev ? { ...prev, saving: true } : prev));
    try {
      if (editingMessage.mode === 'group') {
        if (!selectedGroupIdRef.current) return;
        const response = await groupAPI.editMessage(selectedGroupIdRef.current, editingMessage.messageId, trimmedText);
        setMessages((prev) => applyMessageMutationData(prev, editingMessage.messageId, response?.data));
        setEditingMessage(null);
        return;
      }

      if (!selectedDirectUserIdRef.current) return;
      const response = await directMessageAPI.editMessage(selectedDirectUserIdRef.current, editingMessage.messageId, trimmedText);
      setDirectMessages((prev) => applyMessageMutationData(prev, editingMessage.messageId, response?.data));
      setEditingMessage(null);
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to edit message.');
      setEditingMessage((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  };
  const handleDeleteMessage = (mode, message) => {
    if (!message?.id || message.isOptimistic || message.deletedAt) return;
    const threadId = mode === 'group' ? selectedGroupIdRef.current : selectedDirectUserIdRef.current;
    if (!threadId) return;

    setDeleteConfirmation({
      open: true,
      mode,
      message,
      threadId,
      threadLabel: mode === 'group'
        ? selectedGroup?.name || 'this group'
        : selectedDirectUser?.name || 'this direct chat',
      deleting: false,
    });
  };
  const closeDeleteConfirmation = () => {
    setDeleteConfirmation((prev) => (prev.deleting ? prev : createInitialDeleteConfirmationState()));
  };
  const confirmDeleteMessage = async () => {
    if (!deleteConfirmation.message?.id || deleteConfirmation.deleting) return;
    setDeleteConfirmation((prev) => ({ ...prev, deleting: true }));
    try {
      if (deleteConfirmation.mode === 'group') {
        const response = await groupAPI.deleteMessage(deleteConfirmation.threadId, deleteConfirmation.message.id);
        setMessages((prev) => applyMessageMutationData(prev, deleteConfirmation.message.id, response?.data));
        setDeleteConfirmation(createInitialDeleteConfirmationState());
        return;
      }

      const response = await directMessageAPI.deleteMessage(deleteConfirmation.threadId, deleteConfirmation.message.id);
      setDirectMessages((prev) => applyMessageMutationData(prev, deleteConfirmation.message.id, response?.data));
      setDeleteConfirmation(createInitialDeleteConfirmationState());
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to delete message.');
      setDeleteConfirmation((prev) => ({ ...prev, deleting: false }));
    }
  };
  const syncUnreadCounts = async () => {
    if (!currentUserIdRef.current && !currentUserId) return;
    if (unreadCountsRequestRef.current) return unreadCountsRequestRef.current;

    const request = (async () => {
      try {
        const [groupResponse, directResponse] = await Promise.all([
          groupAPI.listUnreadCounts(),
          directMessageAPI.listUnreadCounts(),
        ]);
        if (!isActiveRef.current) return;

        setGroupUnreadCounts(groupResponse?.data?.countsByGroupId || {});
        setDirectUnreadCounts(directResponse?.data?.countsByUserId || {});
        setMutedGroupIds((groupResponse?.data?.mutedGroupIds || []).map(Number));
        setMutedUserIds((directResponse?.data?.mutedUserIds || []).map(Number));
      } catch (error) {
        console.error('Failed to sync message unread counts:', error);
      }
    })();

    unreadCountsRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (unreadCountsRequestRef.current === request) {
        unreadCountsRequestRef.current = null;
      }
    }
  };
  const directListItems = useMemo(() => {
    const seen = new Set();
    const items = [];

    directConversations.forEach((conversation) => {
      if (!conversation?.user?.id || seen.has(conversation.user.id)) return;
      seen.add(conversation.user.id);
      items.push({
        ...conversation.user,
        conversation,
      });
    });

    directUsers.forEach((directUser) => {
      if (!directUser?.id || seen.has(directUser.id)) return;
      seen.add(directUser.id);
      items.push({
        ...directUser,
        conversation: null,
      });
    });

    return items;
  }, [directConversations, directUsers]);
  const filteredGroups = useMemo(() => {
    const query = messageSearch.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => buildGroupSearchText(group).includes(query));
  }, [groups, messageSearch]);
  const filteredDirectListItems = useMemo(() => {
    const query = messageSearch.trim().toLowerCase();
    if (!query) return directListItems;
    return directListItems.filter((item) => buildDirectSearchText(item).includes(query));
  }, [directListItems, messageSearch]);
  const isDirectTabActive = activeTab === 'direct';
  const routeTab = `${searchParams.get('tab') || ''}`.trim().toLowerCase();
  const routeGroupId = Number(searchParams.get('groupId') || 0);
  const routeDirectUserId = Number(searchParams.get('userId') || 0);

  useEffect(() => {
    if (!isActive || !currentUserId) return;
    syncUnreadCounts({ silent: true });
  }, [currentUserId, isActive]);

  const selectedForwardMessages = useMemo(() => {
    if (selectionMode === 'group') {
      const selectedIds = new Set(selectedGroupMessageIds);
      return messages.filter((message) =>
        selectedIds.has(message.id) && !message.deletedAt && !message.failed && !message.isOptimistic
      );
    }

    if (selectionMode === 'direct') {
      const selectedIds = new Set(selectedDirectMessageIds);
      return directMessages.filter((message) =>
        selectedIds.has(message.id) && !message.deletedAt && !message.failed && !message.isOptimistic
      );
    }

    return [];
  }, [directMessages, messages, selectedDirectMessageIds, selectedGroupMessageIds, selectionMode]);
  const selectedForwardCount = selectedForwardMessages.length;
  const forwardableGroups = useMemo(
    () => groups.filter((group) => !(selectionMode === 'group' && group.id === selectedGroupId)),
    [groups, selectedGroupId, selectionMode]
  );
  const forwardableUsers = useMemo(
    () =>
      allUsers.filter(
        (groupUser) =>
          groupUser.id !== currentUserId
          && !(selectionMode === 'direct' && groupUser.id === selectedDirectUserId)
      ),
    [allUsers, currentUserId, selectedDirectUserId, selectionMode]
  );

  const openGroupReceiptDetails = (messageId) => {
    if (!messageId) return;
    setReceiptDetailsMessageId(messageId);
  };

  const closeReceiptDetails = () => setReceiptDetailsMessageId(null);

  const receiptDetailsMessage = useMemo(() => {
    if (!receiptDetailsMessageId) return null;
    const message = messages.find((row) => row.id === receiptDetailsMessageId);
    if (!message || message.senderId !== currentUserId) return null;
    return message;
  }, [currentUserId, messages, receiptDetailsMessageId]);

  const receiptDetailsData = useMemo(() => {
    if (!receiptDetailsMessage || !selectedGroup) {
      return { readItems: [], deliveredItems: [], pendingItems: [] };
    }

    const memberMap = new Map(
      (selectedGroup.members || [])
        .filter((member) => member.id !== currentUserId)
        .map((member) => [Number(member.id), member])
    );
    const readItems = (receiptDetailsMessage.receipt?.readBy || [])
      .filter((entry) => entry?.id)
      .map((entry) => ({ ...(memberMap.get(Number(entry.id)) || {}), ...entry }))
      .sort((left, right) => `${left.name || ''}`.localeCompare(`${right.name || ''}`));
    const readIds = new Set(readItems.map((entry) => Number(entry.id)));
    const deliveredItems = (receiptDetailsMessage.receipt?.deliveredBy || [])
      .filter((entry) => entry?.id && !readIds.has(Number(entry.id)))
      .map((entry) => ({ ...(memberMap.get(Number(entry.id)) || {}), ...entry }))
      .sort((left, right) => `${left.name || ''}`.localeCompare(`${right.name || ''}`));
    const deliveredIds = new Set(deliveredItems.map((entry) => Number(entry.id)));
    const pendingItems = Array.from(memberMap.values())
      .filter((member) => !readIds.has(Number(member.id)) && !deliveredIds.has(Number(member.id)))
      .sort((left, right) => `${left.name || ''}`.localeCompare(`${right.name || ''}`));

    return { readItems, deliveredItems, pendingItems };
  }, [currentUserId, receiptDetailsMessage, selectedGroup]);

  const getAttachmentLabel = (attachment) => getAttachmentDisplayName(attachment);
  const formatForwardTimestamp = (value) => {
    const formatted = formatMonthDayTimeIndia(value);
    return formatted === 'N/A' ? 'Unknown time' : formatted;
  };

  const groupUnreadMarkerCount = unreadMarker?.key === `group:${selectedGroupId}` ? unreadMarker.count : 0;
  const directUnreadMarkerCount = unreadMarker?.key === `direct:${selectedDirectUserId}` ? unreadMarker.count : 0;
  const messageItems = useMemo(
    () => buildThreadItems({
      messages,
      currentUserId,
      unreadCount: groupUnreadMarkerCount,
      prefix: `group-${selectedGroupId}`,
    }),
    [currentUserId, groupUnreadMarkerCount, messages, selectedGroupId]
  );
  const directMessageItems = useMemo(
    () => buildThreadItems({
      messages: directMessages,
      currentUserId,
      unreadCount: directUnreadMarkerCount,
      prefix: `direct-${selectedDirectUserId}`,
    }),
    [currentUserId, directMessages, directUnreadMarkerCount, selectedDirectUserId]
  );

  useEffect(() => {
    if (!isActive || !cacheKeys) return;
    setTaskPanelCache(cacheKeys.groupIndex, {
      allUsers,
      currentUserId,
      groups,
      selectedGroupId,
    });
  }, [allUsers, cacheKeys, currentUserId, groups, isActive, selectedGroupId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !selectedGroupId) return;
    setTaskPanelCache(cacheKeys.groupMessages(selectedGroupId), {
      messages,
      pinned: groupPinned,
    });
    queryClient.setQueryData(GROUP_MESSAGES_KEY(selectedGroupId), messages);
  }, [cacheKeys, groupPinned, isActive, messages, queryClient, selectedGroupId]);

  // Deep links (notification clicks: ?tab=direct&userId=…) are applied once per
  // value; afterwards the user's own tab/thread choices win.
  const appliedRouteTabRef = useRef(null);
  const appliedRouteThreadRef = useRef(null);

  useEffect(() => {
    if (!isActive) {
      appliedRouteTabRef.current = null;
      appliedRouteThreadRef.current = null;
      return;
    }
    if (!['direct', 'groups'].includes(routeTab) || appliedRouteTabRef.current === routeTab) return;
    appliedRouteTabRef.current = routeTab;
    setActiveTab(routeTab);
    setVisibleListTab(routeTab);
  }, [isActive, routeTab]);

  useEffect(() => {
    if (!isActive) return;
    let routeKey = null;
    if (routeTab === 'groups' && routeGroupId > 0) routeKey = `groups:${routeGroupId}`;
    if (routeTab === 'direct' && routeDirectUserId > 0) routeKey = `direct:${routeDirectUserId}`;
    if (!routeKey || appliedRouteThreadRef.current === routeKey) return;

    if (routeTab === 'groups') {
      const matchingGroup = groups.find((group) => Number(group.id) === routeGroupId);
      if (!matchingGroup) return;
      appliedRouteThreadRef.current = routeKey;
      setSelectedGroupId(matchingGroup.id);
      if (isMobileViewport()) setVisibleListTab(null);
      return;
    }

    const matchingDirectUser =
      directUsers.find((directUser) => Number(directUser.id) === routeDirectUserId)
      || directConversations.find((conversation) => Number(conversation.user?.id) === routeDirectUserId)?.user;
    if (!matchingDirectUser) return;
    appliedRouteThreadRef.current = routeKey;
    setSelectedDirectUserId(matchingDirectUser.id);
    if (isMobileViewport()) setVisibleListTab(null);
  }, [directConversations, directUsers, groups, isActive, routeDirectUserId, routeGroupId, routeTab]);

  const { mutateAsync: sendGroupMessage } = useSendGroupMessage(selectedGroupId, {
    onOptimisticMessage: (optimisticMessage) => {
      setMessages((prev) => appendMessageById(prev, optimisticMessage));
      setMessageCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    },
    onConfirmedMessage: ({ tempId, message }) => {
      setMessages((prev) => {
        if (message?.groupId && selectedGroupIdRef.current !== message.groupId) return prev;
        return replaceMessageById(prev, tempId, withGroupReceiptDefault(message));
      });
      setMessageCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    },
    onRollbackMessage: ({ payload, context }) => {
      if (!context?.tempId) return;
      const failedMessage = createFailedMessageFromPayload({
        id: `failed-${context.tempId}`,
        mode: 'group',
        threadId: selectedGroupIdRef.current,
        currentUserId,
        senderName: user?.name || 'You',
        message: payload?.message || '',
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
        replyTo: payload?.replyTo || null,
        forwardMetadata: payload?.forward_metadata || payload?.forwardMetadata || null,
        payload,
      });
      setMessages((prev) => replaceMessageWithFailedMessage(prev, context.tempId, failedMessage));
    },
    onSettled: async () => {
      await syncGroups({ silent: true }).catch(() => {});
    },
  });

  const syncGroups = async ({ keepSelected = true, silent = false } = {}) => {
    if (syncGroupsPromiseRef.current) {
      return syncGroupsPromiseRef.current;
    }

    const request = (async () => {
      try {
        if (silent) {
          setIsRefreshing(true);
        }
        const response = await groupAPI.listGroups();
        if (!isActiveRef.current) return;
        const nextGroups = response?.data || [];
        setHasResolvedGroupIndex(true);
        setGroups(nextGroups);
        setGroupsCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
        if (nextGroups.length === 0) {
          setSelectedGroupId(null);
          setMessages([]);
          return;
        }

        const activeGroupId = selectedGroupIdRef.current;
        if (!keepSelected || !nextGroups.some((group) => group.id === activeGroupId)) {
          const fallbackGroupId = nextGroups[0].id;
          const cachedMessages = cacheKeys
            ? getTaskPanelCache(cacheKeys.groupMessages(fallbackGroupId), GROUP_MESSAGES_CACHE_TTL_MS)
            : null;
          if (cachedMessages?.messages) {
            setMessages(cachedMessages.messages);
          }
          setSelectedGroupId(fallbackGroupId);
        }
      } catch (error) {
        if (!silent && isActiveRef.current) {
          setFeedback(error?.response?.data?.detail || 'Failed to load groups.');
        }
        throw error;
      } finally {
        if (silent) setIsRefreshing(false);
      }
    })();

    syncGroupsPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (syncGroupsPromiseRef.current === request) {
        syncGroupsPromiseRef.current = null;
      }
    }
  };

  const loadMessages = async (groupId, { silent = false } = {}) => {
    if (!groupId) {
      setMessages([]);
      return;
    }

    const activeRequest = groupMessagesRequestRef.current;
    if (activeRequest.groupId === groupId && activeRequest.promise) {
      return activeRequest.promise;
    }

    const request = (async () => {
      try {
        if (silent) setIsMessagesRefreshing(true);
        const response = await groupAPI.listMessages(groupId);
        if (selectedGroupIdRef.current !== groupId) return;
        if (!isActiveRef.current) return;
        setMessages((response?.data || []).map((message) => withGroupReceiptDefault(message)));
        setGroupPinned(Array.isArray(response?.pinned) ? response.pinned : []);
        acknowledgeGroupMessagesDelivered(groupId);
        acknowledgeGroupMessagesRead(groupId);
        setMessageCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
      } catch (error) {
        if (!silent && selectedGroupIdRef.current === groupId && isActiveRef.current) {
          setFeedback(error?.response?.data?.detail || 'Failed to load group messages.');
        }
        throw error;
      } finally {
        if (silent) setIsMessagesRefreshing(false);
      }
    })();

    groupMessagesRequestRef.current = { groupId, promise: request };
    try {
      return await request;
    } finally {
      if (groupMessagesRequestRef.current.promise === request) {
        groupMessagesRequestRef.current = { groupId: null, promise: null };
      }
    }
  };

  const syncDirectData = async ({ keepSelected = true, silent = false } = {}) => {
    if (syncDirectDataPromiseRef.current) {
      return syncDirectDataPromiseRef.current;
    }

    const request = (async () => {
      try {
        hasBootstrappedDirectRef.current = true;
        if (silent) setDirectRefreshing(true);
        const [usersResponse, conversationsResponse] = await Promise.all([
          directMessageAPI.listUsers(),
          directMessageAPI.listConversations(),
        ]);
        if (!isActiveRef.current) return;
        const nextUsers = usersResponse?.data || [];
        const nextConversations = conversationsResponse?.data || [];
        setHasResolvedDirectIndex(true);
        setDirectUsers(nextUsers);
        setDirectConversations(nextConversations);
        setDirectCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));

        const activeUserId = selectedDirectUserIdRef.current;
        const userStillExists = nextUsers.some((directUser) => directUser.id === activeUserId)
          || nextConversations.some((conversation) => conversation.user?.id === activeUserId);
        if (!keepSelected || !userStillExists) {
          const fallbackUserId = nextConversations[0]?.user?.id || null;
          if (fallbackUserId && cacheKeys) {
            const cachedDirectMessages = getTaskPanelCache(cacheKeys.directMessages(fallbackUserId), GROUP_MESSAGES_CACHE_TTL_MS);
            if (cachedDirectMessages?.messages) {
              setDirectMessages(cachedDirectMessages.messages);
            }
          }
          setSelectedDirectUserId(fallbackUserId);
        }
      } finally {
        if (silent) setDirectRefreshing(false);
      }
    })();

    syncDirectDataPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (syncDirectDataPromiseRef.current === request) {
        syncDirectDataPromiseRef.current = null;
      }
    }
  };

  const loadDirectMessages = async (otherUserId, { silent = false } = {}) => {
    if (!otherUserId) {
      setDirectMessages([]);
      return;
    }

    const activeRequest = directMessagesRequestRef.current;
    if (activeRequest.userId === otherUserId && activeRequest.promise) {
      return activeRequest.promise;
    }

    const request = (async () => {
      try {
        if (silent) setDirectMessagesRefreshing(true);
        const response = await directMessageAPI.listMessages(otherUserId);
        if (selectedDirectUserIdRef.current !== otherUserId) return;
        if (!isActiveRef.current) return;
        setDirectMessages((response?.data || []).map((message) => withDirectReceiptDefault(message)));
        setDirectPinned(Array.isArray(response?.pinned) ? response.pinned : []);
        acknowledgeDirectMessagesDelivered(otherUserId);
        acknowledgeDirectMessagesRead(otherUserId);
        if (response?.conversationWith) {
          setDirectUsers((prev) => {
            if (prev.some((entry) => entry.id === response.conversationWith.id)) return prev;
            return [response.conversationWith, ...prev];
          });
        }
        setDirectMessageCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
      } finally {
        if (silent) setDirectMessagesRefreshing(false);
      }
    })();

    directMessagesRequestRef.current = { userId: otherUserId, promise: request };
    try {
      return await request;
    } finally {
      if (directMessagesRequestRef.current.promise === request) {
        directMessagesRequestRef.current = { userId: null, promise: null };
      }
    }
  };

  const scheduleRealtimeRefresh = (key, callback, delay = 180) => {
    if (typeof window === 'undefined') return;
    if (!isActiveRef.current) return;
    if (realtimeRefreshTimersRef.current[key]) return;
    realtimeRefreshTimersRef.current[key] = window.setTimeout(() => {
      realtimeRefreshTimersRef.current[key] = null;
      if (isActiveRef.current) callback().catch(() => {});
    }, delay);
  };

  const scheduleGroupIndexRefresh = (delay = 180) =>
    scheduleRealtimeRefresh('groupIndex', () => syncGroups({ silent: true }), delay);

  const scheduleGroupMessagesRefresh = (groupId, delay = 180) =>
    scheduleRealtimeRefresh('groupMessages', () => loadMessages(groupId, { silent: true }), delay);

  const scheduleDirectIndexRefresh = (delay = 180) =>
    scheduleRealtimeRefresh('directIndex', () => syncDirectData({ silent: true }), delay);

  const scheduleDirectMessagesRefresh = (otherUserId, delay = 180) =>
    scheduleRealtimeRefresh('directMessages', () => loadDirectMessages(otherUserId, { silent: true }), delay);

  const scheduleUnreadCountsRefresh = (delay = 180) =>
    scheduleRealtimeRefresh('unreadCounts', () => syncUnreadCounts({ silent: true }), delay);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;

    const cachedGroupsEntry = getTaskPanelCacheEntry(cacheKeys.groupIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedGroups = cachedGroupsEntry?.value || null;

    if (cachedGroups) {
      setAllUsers(cachedGroups.allUsers || []);
      setCurrentUserId(cachedGroups.currentUserId || null);
      setGroups(cachedGroups.groups || []);
      setSelectedGroupId((current) => current ?? cachedGroups.selectedGroupId ?? null);
      setLoading(false);
      setGroupsCacheStatus({
        showingCached: true,
        cachedAt: cachedGroupsEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      const restoresCachedGroup = (selectedGroupIdRef.current ?? cachedGroups.selectedGroupId) === cachedGroups.selectedGroupId;
      if (cachedGroups.selectedGroupId && restoresCachedGroup) {
        const cachedMessagesEntry = getTaskPanelCacheEntry(
          cacheKeys.groupMessages(cachedGroups.selectedGroupId),
          GROUP_MESSAGES_CACHE_TTL_MS
        );
        if (cachedMessagesEntry?.value?.messages) {
          setMessages(cachedMessagesEntry.value.messages);
          setMessageCacheStatus({
            showingCached: true,
            cachedAt: cachedMessagesEntry.cachedAt || 0,
            liveUpdatedAt: 0,
          });
        }
      }
    }

    const load = async () => {
      if (cachedGroups) setIsRefreshing(true);
      else setLoading(true);

      try {
        const [usersResponse] = await Promise.all([
          groupAPI.listUsers(),
          syncGroups({ keepSelected: true, silent: !!cachedGroups }),
        ]);
        setCurrentUserId(user?.id || null);
        setAllUsers(usersResponse?.data || []);
      } catch (error) {
        console.error('Failed to load users for groups:', error);
        if (!cachedGroups) {
          setAllUsers([]);
        }
      } finally {
        if (cachedGroups) setIsRefreshing(false);
        else setLoading(false);
      }
    };

    load();
  }, [cacheKeys, isActive, user?.id]);

  useEffect(() => {
    if (!isActive) return;
    if (!selectedGroupId) {
      setMessages([]);
      return;
    }

    const cachedMessagesEntry = cacheKeys
      ? getTaskPanelCacheEntry(cacheKeys.groupMessages(selectedGroupId), GROUP_MESSAGES_CACHE_TTL_MS)
      : null;
    const cachedMessages = cachedMessagesEntry?.value || null;

    const isNewThread = shownGroupThreadRef.current !== selectedGroupId;
    shownGroupThreadRef.current = selectedGroupId;
    setGroupPinned(Array.isArray(cachedMessages?.pinned) ? cachedMessages.pinned : []);
    if (cachedMessages?.messages) {
      setMessages(cachedMessages.messages);
      setMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    } else if (isNewThread) {
      // Never show the previous thread's messages under the new header.
      setMessages([]);
      setGroupThreadLoading(true);
    }

    const requestedGroupId = selectedGroupId;
    loadMessages(selectedGroupId, { silent: !!cachedMessages })
      .catch((error) => {
        console.error('Failed to load messages:', error);
        if (!cachedMessages) {
          setMessages([]);
        }
        setIsMessagesRefreshing(false);
      })
      .finally(() => {
        if (selectedGroupIdRef.current === requestedGroupId) setGroupThreadLoading(false);
      });
  }, [cacheKeys, isActive, selectedGroupId]);

  useEffect(() => {
    if (!isActive) return;
    setShowAddMemberPanel(false);
    setShowGroupMenu(false);
    setAddMemberSelection([]);
    setPendingAttachments([]);
    setNewMessage('');
  }, [isActive, selectedGroupId]);

  useEffect(() => {
    if (variant !== 'overlay') return;
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen, variant]);

  useEffect(() => {
    if (!isActive || !showGroupMenu) return undefined;

    const handlePointerDown = (event) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target)) {
        setShowGroupMenu(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isActive, showGroupMenu]);

  useEffect(() => {
    if (!isActive) return undefined;

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      scheduleGroupIndexRefresh();
      scheduleUnreadCountsRefresh();
      if (hasBootstrappedDirectRef.current || activeTabRef.current === 'direct') {
        scheduleDirectIndexRefresh();
      }

      if (activeTabRef.current === 'groups' && selectedGroupIdRef.current) {
        scheduleGroupMessagesRefresh(selectedGroupIdRef.current);
      }

      if (activeTabRef.current === 'direct' && selectedDirectUserIdRef.current) {
        scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current);
      }
    }, 90000);

    return () => clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;

        if (payload.eventType === 'chat_typing') {
          const metadata = payload.metadata || {};
          const scope = `${metadata.scope || ''}`.toLowerCase();
          const senderId = Number(metadata.senderId);
          if (scope === 'group') {
            updateRemoteTyping({
              scope,
              threadId: metadata.groupId,
              userId: senderId,
              userName: metadata.senderName,
              active: metadata.active !== false,
            });
            scheduleGroupIndexRefresh(800);
          } else if (scope === 'direct') {
            updateRemoteTyping({
              scope,
              threadId: senderId,
              userId: senderId,
              userName: metadata.senderName,
              active: metadata.active !== false,
            });
            scheduleDirectIndexRefresh(800);
          }
          return;
        }

        if (payload.eventType === 'message_reaction') {
          const metadata = payload.metadata || {};
          const scope = `${metadata.scope || ''}`.toLowerCase();
          if (scope === 'group') {
            const groupId = Number(metadata.groupId);
            if (groupId && selectedGroupIdRef.current === groupId) {
              scheduleGroupMessagesRefresh(groupId, 120);
            }
            return;
          }

          if (scope === 'direct' && selectedDirectUserIdRef.current) {
            const otherUserId = Number(metadata.otherUserId || metadata.userId);
            if (!otherUserId || selectedDirectUserIdRef.current === otherUserId) {
              scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current, 120);
            }
          }
          return;
        }

        if (
          payload.eventType === 'message_updated'
          || payload.eventType === 'message_deleted'
          || payload.eventType === 'message_pinned'
        ) {
          const metadata = payload.metadata || {};
          const scope = `${metadata.scope || ''}`.toLowerCase();
          if (scope === 'group') {
            const groupId = Number(metadata.groupId);
            if (groupId && selectedGroupIdRef.current === groupId) {
              scheduleGroupMessagesRefresh(groupId, 120);
            }
            scheduleGroupIndexRefresh(240);
            return;
          }

          if (scope === 'direct' && selectedDirectUserIdRef.current) {
            const otherUserId = Number(metadata.otherUserId || metadata.senderId);
            if (!otherUserId || selectedDirectUserIdRef.current === otherUserId) {
              scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current, 120);
            }
            scheduleDirectIndexRefresh(240);
          }
          return;
        }

        if (payload.eventType === 'message_read_receipt' || payload.eventType === 'message_delivery_receipt') {
          const scope = `${payload?.metadata?.scope || ''}`.toLowerCase();
          if (payload.eventType === 'message_read_receipt') {
            scheduleUnreadCountsRefresh();
          }
          if (scope === 'group') {
            const groupId = Number(payload?.metadata?.groupId);
            if (groupId && selectedGroupIdRef.current === groupId) {
              scheduleGroupMessagesRefresh(groupId, 120);
            }
            return;
          }

          if (scope === 'direct') {
            const readerId = Number(payload?.metadata?.readerId || payload?.metadata?.otherUserId);
            if (selectedDirectUserIdRef.current && (!readerId || selectedDirectUserIdRef.current === readerId)) {
              scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current, 120);
            }
          }
          return;
        }

        if (payload.eventType === 'group_message') {
          const groupId = Number(payload?.metadata?.groupId);
          if (!groupId) return;
          updateRemoteTyping({
            scope: 'group',
            threadId: groupId,
            userId: payload?.metadata?.senderId,
            userName: payload?.metadata?.senderName,
            active: false,
          });
          const isViewingGroupThread =
            activeTabRef.current === 'groups' && selectedGroupIdRef.current === groupId;

          scheduleGroupIndexRefresh();
          scheduleUnreadCountsRefresh();
          if (!isViewingGroupThread) {
            incrementGroupUnreadCount(groupId);
          }
          acknowledgeGroupMessagesDelivered(groupId);

          if (selectedGroupIdRef.current === groupId) {
            const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
            const incomingMessage = {
              id: payload?.metadata?.messageId,
              senderId: payload?.metadata?.senderId || null,
              senderName: payload?.metadata?.senderName || 'Unknown',
              message: payload?.metadata?.messageText ?? payload?.message ?? '',
              replyTo: payload?.metadata?.replyTo || null,
              attachments,
              mentions: Array.isArray(payload?.metadata?.mentions) ? payload.metadata.mentions : [],
              forwardMetadata: payload?.metadata?.forwardMetadata || null,
              createdAt: payload?.metadata?.createdAt || new Date().toISOString(),
            };
            setMessages((prev) => appendMessageById(prev, incomingMessage));
            setMessageCacheStatus((prev) => ({
              showingCached: false,
              cachedAt: prev.cachedAt,
              liveUpdatedAt: Date.now(),
            }));
            if (isViewingGroupThread) {
              acknowledgeGroupMessagesRead(groupId);
            }
            scheduleGroupMessagesRefresh(groupId, 120);
          }

          return;
        }

        if (payload.eventType === 'direct_message') {
          const senderId = Number(payload?.metadata?.senderId);
          if (!senderId) return;
          updateRemoteTyping({
            scope: 'direct',
            threadId: senderId,
            userId: senderId,
            userName: payload?.metadata?.senderName,
            active: false,
          });
          const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
          const incomingMessage = {
            id: payload?.metadata?.messageId,
            senderId,
            senderName: payload?.metadata?.senderName || 'Unknown',
            recipientId: currentUserIdRef.current || user?.id || null,
            message: payload?.metadata?.messageText ?? payload?.message ?? '',
            replyTo: payload?.metadata?.replyTo || null,
            attachments,
            forwardMetadata: payload?.metadata?.forwardMetadata || null,
            createdAt: payload?.metadata?.createdAt || new Date().toISOString(),
          };
          const knownDirectUser =
            directUsersRef.current.find((entry) => entry.id === senderId)
            || directConversationsRef.current.find((entry) => entry.user?.id === senderId)?.user
            || {
              id: senderId,
              name: payload?.metadata?.senderName || 'Unknown',
              email: '',
              department: '',
              position: '',
              isAdmin: false,
            };
          const isViewingDirectThread =
            activeTabRef.current === 'direct' && selectedDirectUserIdRef.current === senderId;

          setDirectUsers((prev) => (
            prev.some((entry) => entry.id === knownDirectUser.id)
              ? prev
              : [knownDirectUser, ...prev]
          ));
          setDirectConversations((prev) => upsertDirectConversation(prev, {
            user: knownDirectUser,
            lastMessageAt: incomingMessage.createdAt,
            lastMessagePreview: buildConversationPreview(incomingMessage.message, attachments).slice(0, 180),
            lastMessageSenderId: senderId,
          }));
          setDirectCacheStatus((prev) => ({
            showingCached: false,
            cachedAt: prev.cachedAt,
            liveUpdatedAt: Date.now(),
          }));
          scheduleDirectIndexRefresh();
          scheduleUnreadCountsRefresh();
          acknowledgeDirectMessagesDelivered(senderId);
          if (!isViewingDirectThread) {
            incrementDirectUnreadCount(senderId);
          }
          if (selectedDirectUserIdRef.current === senderId) {
            setDirectMessages((prev) => appendMessageById(prev, incomingMessage));
            setDirectMessageCacheStatus((prev) => ({
              showingCached: false,
              cachedAt: prev.cachedAt,
              liveUpdatedAt: Date.now(),
            }));
            if (isViewingDirectThread) {
              acknowledgeDirectMessagesRead(senderId);
            }
            scheduleDirectMessagesRefresh(senderId, 120);
          }
        }
      },
      onOpen: () => {
        scheduleGroupIndexRefresh(120);
        scheduleUnreadCountsRefresh(120);
        if (hasBootstrappedDirectRef.current || activeTabRef.current === 'direct') {
          scheduleDirectIndexRefresh(120);
        }
        if (selectedGroupIdRef.current) {
          scheduleGroupMessagesRefresh(selectedGroupIdRef.current, 120);
        }
        if (selectedDirectUserIdRef.current) {
          scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current, 120);
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive || typeof document === 'undefined') return undefined;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (activeTabRef.current === 'groups' && selectedGroupIdRef.current) {
        acknowledgeGroupMessagesRead(selectedGroupIdRef.current);
      }
      if (activeTabRef.current === 'direct' && selectedDirectUserIdRef.current) {
        acknowledgeDirectMessagesRead(selectedDirectUserIdRef.current);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isActive]);

  useEffect(() => {
    if (activeTab !== 'groups') stopTyping('group');
    if (activeTab !== 'direct') stopTyping('direct');
  }, [activeTab]);

  useEffect(() => () => stopTyping('group'), [selectedGroupId]);

  useEffect(() => () => stopTyping('direct'), [selectedDirectUserId]);

  useEffect(() => () => {
    ['group', 'direct'].forEach((scope) => {
      const bucket = localTypingRef.current[scope];
      if (bucket?.timer) clearTimeout(bucket.timer);
    });
    Object.values(remoteTypingTimersRef.current).forEach((timer) => clearTimeout(timer));
    remoteTypingTimersRef.current = {};
  }, []);

  useEffect(() => {
    if (isActive) return;
    const timers = realtimeRefreshTimersRef.current;
    Object.keys(timers).forEach((key) => {
      if (timers[key]) {
        window.clearTimeout(timers[key]);
        timers[key] = null;
      }
    });
  }, [isActive]);

  useEffect(() => () => {
    Object.values(realtimeRefreshTimersRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
  }, []);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;
    setTaskPanelCache(cacheKeys.directIndex, {
      directUsers,
      directConversations,
      selectedDirectUserId,
    });
  }, [cacheKeys, directConversations, directUsers, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !selectedDirectUserId) return;
    setTaskPanelCache(cacheKeys.directMessages(selectedDirectUserId), {
      messages: directMessages,
      pinned: directPinned,
    });
  }, [cacheKeys, directMessages, directPinned, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !isDirectTabActive) return;

    const cachedDirectEntry = getTaskPanelCacheEntry(cacheKeys.directIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedDirectData = cachedDirectEntry?.value || null;
    if (cachedDirectData) {
      setDirectUsers(cachedDirectData.directUsers || []);
      setDirectConversations(cachedDirectData.directConversations || []);
      setSelectedDirectUserId((current) => current ?? cachedDirectData.selectedDirectUserId ?? null);
      setDirectLoading(false);
      setDirectCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      const restoresCachedDirect = (selectedDirectUserIdRef.current ?? cachedDirectData.selectedDirectUserId) === cachedDirectData.selectedDirectUserId;
      if (cachedDirectData.selectedDirectUserId && restoresCachedDirect) {
        const cachedDirectMessagesEntry = getTaskPanelCacheEntry(
          cacheKeys.directMessages(cachedDirectData.selectedDirectUserId),
          GROUP_MESSAGES_CACHE_TTL_MS
        );
        if (cachedDirectMessagesEntry?.value?.messages) {
          setDirectMessages(cachedDirectMessagesEntry.value.messages);
          setDirectMessageCacheStatus({
            showingCached: true,
            cachedAt: cachedDirectMessagesEntry.cachedAt || 0,
            liveUpdatedAt: 0,
          });
        }
      }
    }

    const load = async () => {
      hasBootstrappedDirectRef.current = true;
      if (cachedDirectData) setDirectRefreshing(true);
      else setDirectLoading(true);
      try {
        await syncDirectData({ keepSelected: true, silent: !!cachedDirectData });
      } catch (error) {
        console.error('Failed to load direct messages:', error);
        if (!cachedDirectData) {
          setDirectUsers([]);
          setDirectConversations([]);
          setSelectedDirectUserId(null);
        }
      } finally {
        if (cachedDirectData) setDirectRefreshing(false);
        else setDirectLoading(false);
      }
    };

    load();
  }, [cacheKeys, isActive, isDirectTabActive]);

  useEffect(() => {
    if (!isActive || !isDirectTabActive || !hasBootstrappedDirectRef.current) return;
    if (!selectedDirectUserId) {
      setDirectMessages([]);
      return;
    }

    const cachedDirectMessagesEntry = cacheKeys
      ? getTaskPanelCacheEntry(cacheKeys.directMessages(selectedDirectUserId), GROUP_MESSAGES_CACHE_TTL_MS)
      : null;
    const cachedDirectMessages = cachedDirectMessagesEntry?.value || null;
    const isNewThread = shownDirectThreadRef.current !== selectedDirectUserId;
    shownDirectThreadRef.current = selectedDirectUserId;
    setDirectPinned(Array.isArray(cachedDirectMessages?.pinned) ? cachedDirectMessages.pinned : []);
    if (cachedDirectMessages?.messages) {
      setDirectMessages(cachedDirectMessages.messages);
      setDirectMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    } else if (isNewThread) {
      setDirectMessages([]);
      setDirectThreadLoading(true);
    }

    const requestedUserId = selectedDirectUserId;
    loadDirectMessages(selectedDirectUserId, { silent: !!cachedDirectMessages })
      .catch((error) => {
        console.error('Failed to load direct messages:', error);
        if (!cachedDirectMessages) {
          setDirectMessages([]);
        }
        setDirectMessagesRefreshing(false);
      })
      .finally(() => {
        if (selectedDirectUserIdRef.current === requestedUserId) setDirectThreadLoading(false);
      });
  }, [cacheKeys, isActive, isDirectTabActive, selectedDirectUserId]);

  useEffect(() => {
    setSelectionMode(null);
    setSelectedGroupMessageIds([]);
    setSelectedDirectMessageIds([]);
    setForwardState(createInitialForwardState());
    setReceiptDetailsMessageId(null);
    setEditingMessage(null);
    setReplyingMessage(null);
    setScrollRequest(null);
    setHighlightedMessageId(null);
  }, [activeTab, selectedDirectUserId, selectedGroupId]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  const createGroup = async () => {
    if (!groupName.trim() || selectedIds.length === 0) return;
    try {
      setFeedback('');
      const response = await groupAPI.createGroup(groupName.trim(), selectedIds);
      const created = response?.data;
      if (created) {
        setGroups((prev) => [created, ...prev.filter((group) => group.id !== created.id)]);
        setSelectedGroupId(created.id);
      } else {
        await syncGroups({ silent: true });
      }
      setGroupName('');
      setSelectedIds([]);
      setCreateGroupFilter('');
      setShowGroupComposer(false);
      setFeedback('Group created successfully.');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to create group.');
    }
  };

  const saveAddMembers = async (groupId) => {
    if (!addMemberSelection.length) return;
    try {
      setFeedback('');
      const response = await groupAPI.addMembers(groupId, addMemberSelection);
      const updated = response?.data;
      setGroups((prev) => prev.map((group) => (group.id === groupId ? updated : group)));
      setAddMemberSelection([]);
      setShowAddMemberPanel(false);
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to add members.');
    }
  };

  const sendMessage = async () => {
    if (!selectedGroupId || sendingMessage || uploadingAttachment) return;
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage && pendingAttachments.length === 0) return;
    const draftMessage = trimmedMessage;
    setUnreadMarker(null);
    const draftAttachments = pendingAttachments;
    const draftReply = isReplyingGroupMessage ? replyingMessage : null;
    const mentionIds = extractMentionIdsFromText(draftMessage, selectedGroup?.members || [], currentUserId);
    const mentionedMembers = (selectedGroup?.members || [])
      .filter((member) => mentionIds.includes(member.id));
    setSendingMessage(true);
    setNewMessage('');
    setPendingAttachments([]);
    setReplyingMessage(null);
    stopTyping('group', selectedGroupId);
    updateGroupComposerDraft(selectedGroupId, createInitialComposerDraft());

    try {
      await sendGroupMessage({
        message: draftMessage,
        attachments: draftAttachments,
        reply_to_message_id: draftReply?.messageId || null,
        replyTo: draftReply,
        mention_ids: mentionIds,
        mentions: mentionedMembers.map((member) => ({
          id: member.id,
          name: member.name,
          email: member.email,
        })),
      });
      markGroupThreadSeen(selectedGroupId);
      setFeedback('');
    } catch (error) {
      setNewMessage(draftMessage);
      setPendingAttachments(draftAttachments);
      setReplyingMessage(draftReply);
      updateGroupComposerDraft(selectedGroupId, {
        text: draftMessage,
        attachments: draftAttachments,
        uploading: false,
        uploadState: createInitialAttachmentUploadState(),
      });
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingMessage(false);
    }
  };

  const handleAttachmentSelect = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    const targetGroupId = selectedGroupIdRef.current;
    if (!targetGroupId) return;
    const initialUploadState = buildAttachmentUploadState(files);
    const abortController = new AbortController();
    groupUploadAbortRef.current = abortController;
    setUploadingAttachment(true);
    setAttachmentUploadState(initialUploadState);
    updateGroupComposerDraft(targetGroupId, {
      text: newMessage,
      attachments: pendingAttachments,
      uploading: true,
      uploadState: initialUploadState,
    });
    try {
      const response = await fileAPI.uploadFiles(files, {
        signal: abortController.signal,
        onProgress: (_percent, metrics = {}) => {
          const applyProgress = (prev) => {
            const totalBytes = prev.totalBytes || initialUploadState.totalBytes;
            const uploadedBytes = totalBytes
              ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), totalBytes)
              : 0;
            return {
              ...prev,
              active: true,
              uploadedBytes,
              percent: toUploadPercent(uploadedBytes, totalBytes),
            };
          };

          if (selectedGroupIdRef.current === targetGroupId) {
            setAttachmentUploadState(applyProgress);
          } else {
            updateGroupComposerDraft(targetGroupId, (draft) => ({
              ...draft,
              uploading: true,
              uploadState: applyProgress(draft.uploadState || initialUploadState),
            }));
          }
        },
        onFileProgress: (metrics = {}) => {
          const currentFileTotalBytes = Math.max(Number(metrics.file?.size) || Number(metrics.total) || 0, 0);
          const currentFileUploadedBytes = currentFileTotalBytes
            ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), currentFileTotalBytes)
            : 0;
          const applyFileProgress = (prev) => ({
            ...prev,
            active: true,
            currentFileName: metrics.file ? getAttachmentDisplayName(metrics.file) : prev.currentFileName,
            currentFileIndex: Number.isFinite(metrics.fileIndex) ? metrics.fileIndex + 1 : prev.currentFileIndex,
            currentFileUploadedBytes,
            currentFileTotalBytes,
            currentFilePercent: toUploadPercent(currentFileUploadedBytes, currentFileTotalBytes),
          });

          if (selectedGroupIdRef.current === targetGroupId) {
            setAttachmentUploadState(applyFileProgress);
          } else {
            updateGroupComposerDraft(targetGroupId, (draft) => ({
              ...draft,
              uploading: true,
              uploadState: applyFileProgress(draft.uploadState || initialUploadState),
            }));
          }
        },
      });
      if (selectedGroupIdRef.current === targetGroupId) {
        setPendingAttachments((prev) => mergeUniqueAttachments(prev, response?.data || []));
      } else {
        updateGroupComposerDraft(targetGroupId, (draft) => ({
          ...draft,
          attachments: mergeUniqueAttachments(draft.attachments || [], response?.data || []),
        }));
      }
      setFeedback('');
    } catch (error) {
      setFeedback(isRequestCanceled(error) ? 'Upload canceled.' : (error?.response?.data?.detail || 'Failed to upload attachment.'));
    } finally {
      if (groupUploadAbortRef.current === abortController) {
        groupUploadAbortRef.current = null;
      }
      if (selectedGroupIdRef.current === targetGroupId) {
        setUploadingAttachment(false);
        setAttachmentUploadState(createInitialAttachmentUploadState());
      } else {
        updateGroupComposerDraft(targetGroupId, (draft) => ({
          ...draft,
          uploading: false,
          uploadState: createInitialAttachmentUploadState(),
        }));
      }
    }
  };

  const handleDirectAttachmentSelect = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    const targetUserId = selectedDirectUserIdRef.current;
    if (!targetUserId) return;
    const initialUploadState = buildAttachmentUploadState(files);
    const abortController = new AbortController();
    directUploadAbortRef.current = abortController;
    setUploadingDirectAttachment(true);
    setDirectAttachmentUploadState(initialUploadState);
    updateDirectComposerDraft(targetUserId, {
      text: directNewMessage,
      attachments: directPendingAttachments,
      uploading: true,
      uploadState: initialUploadState,
    });
    try {
      const response = await fileAPI.uploadFiles(files, {
        signal: abortController.signal,
        onProgress: (_percent, metrics = {}) => {
          const applyProgress = (prev) => {
            const totalBytes = prev.totalBytes || initialUploadState.totalBytes;
            const uploadedBytes = totalBytes
              ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), totalBytes)
              : 0;
            return {
              ...prev,
              active: true,
              uploadedBytes,
              percent: toUploadPercent(uploadedBytes, totalBytes),
            };
          };

          if (selectedDirectUserIdRef.current === targetUserId) {
            setDirectAttachmentUploadState(applyProgress);
          } else {
            updateDirectComposerDraft(targetUserId, (draft) => ({
              ...draft,
              uploading: true,
              uploadState: applyProgress(draft.uploadState || initialUploadState),
            }));
          }
        },
        onFileProgress: (metrics = {}) => {
          const currentFileTotalBytes = Math.max(Number(metrics.file?.size) || Number(metrics.total) || 0, 0);
          const currentFileUploadedBytes = currentFileTotalBytes
            ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), currentFileTotalBytes)
            : 0;
          const applyFileProgress = (prev) => ({
            ...prev,
            active: true,
            currentFileName: metrics.file ? getAttachmentDisplayName(metrics.file) : prev.currentFileName,
            currentFileIndex: Number.isFinite(metrics.fileIndex) ? metrics.fileIndex + 1 : prev.currentFileIndex,
            currentFileUploadedBytes,
            currentFileTotalBytes,
            currentFilePercent: toUploadPercent(currentFileUploadedBytes, currentFileTotalBytes),
          });

          if (selectedDirectUserIdRef.current === targetUserId) {
            setDirectAttachmentUploadState(applyFileProgress);
          } else {
            updateDirectComposerDraft(targetUserId, (draft) => ({
              ...draft,
              uploading: true,
              uploadState: applyFileProgress(draft.uploadState || initialUploadState),
            }));
          }
        },
      });
      if (selectedDirectUserIdRef.current === targetUserId) {
        setDirectPendingAttachments((prev) => mergeUniqueAttachments(prev, response?.data || []));
      } else {
        updateDirectComposerDraft(targetUserId, (draft) => ({
          ...draft,
          attachments: mergeUniqueAttachments(draft.attachments || [], response?.data || []),
        }));
      }
      setFeedback('');
    } catch (error) {
      setFeedback(isRequestCanceled(error) ? 'Upload canceled.' : (error?.response?.data?.detail || 'Failed to upload attachment.'));
    } finally {
      if (directUploadAbortRef.current === abortController) {
        directUploadAbortRef.current = null;
      }
      if (selectedDirectUserIdRef.current === targetUserId) {
        setUploadingDirectAttachment(false);
        setDirectAttachmentUploadState(createInitialAttachmentUploadState());
      } else {
        updateDirectComposerDraft(targetUserId, (draft) => ({
          ...draft,
          uploading: false,
          uploadState: createInitialAttachmentUploadState(),
        }));
      }
    }
  };

  const cancelGroupAttachmentUpload = () => {
    groupUploadAbortRef.current?.abort();
  };

  const cancelDirectAttachmentUpload = () => {
    directUploadAbortRef.current?.abort();
  };

  const openAttachmentPicker = (mode, onSelect = handleAttachmentSelect) => {
    openSystemFilePicker({
      mode,
      onSelect,
    });
  };

  const updateMemberRole = async (memberId, role) => {
    if (!selectedGroupId) return;
    try {
      const response = await groupAPI.updateMemberRole(selectedGroupId, memberId, role);
      const updated = response?.data;
      setGroups((prev) => prev.map((group) => (group.id === selectedGroupId ? updated : group)));
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to update role.');
    }
  };

  const removeMember = async (memberId) => {
    if (!selectedGroupId) return;
    try {
      const response = await groupAPI.removeMember(selectedGroupId, memberId);
      const updated = response?.data;
      if (memberId === currentUserId) {
        await syncGroups({ keepSelected: false, silent: true });
      } else {
        setGroups((prev) => prev.map((group) => (group.id === selectedGroupId ? updated : group)));
      }
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to remove member.');
    }
  };

  const sendDirectMessage = async () => {
    if (!selectedDirectUserId || sendingDirectMessage || uploadingDirectAttachment) return;
    const trimmedMessage = directNewMessage.trim();
    if (!trimmedMessage && directPendingAttachments.length === 0) return;
    const targetUserId = selectedDirectUserId;
    const targetUser = selectedDirectUser;
    const draftAttachments = directPendingAttachments;
    const draftReply = isReplyingDirectMessage ? replyingMessage : null;
    const draftPayload = {
      message: trimmedMessage,
      attachments: draftAttachments,
      reply_to_message_id: draftReply?.messageId || null,
      replyTo: draftReply,
    };
    const tempId = `temp-direct-${Date.now()}`;
    setUnreadMarker(null);
    setSendingDirectMessage(true);
    setReplyingMessage(null);
    setDirectNewMessage('');
    setDirectPendingAttachments([]);
    updateDirectComposerDraft(targetUserId, createInitialComposerDraft());
    stopTyping('direct', targetUserId);
    setDirectMessages((prev) => appendMessageById(prev, {
      id: tempId,
      senderId: currentUserId,
      senderName: user?.name || 'You',
      recipientId: targetUserId,
      message: trimmedMessage,
      replyTo: draftReply,
      attachments: draftAttachments,
      createdAt: new Date().toISOString(),
      editedAt: null,
      receipt: {
        status: 'sending',
        totalRecipientCount: 1,
        deliveredCount: 0,
        deliveredBy: [],
        readCount: 0,
        readBy: [],
      },
      isOptimistic: true,
    }));

    try {
      const response = await directMessageAPI.sendMessage(targetUserId, draftPayload);
      const sent = response?.data;
      if (sent && selectedDirectUserIdRef.current === targetUserId) {
        setDirectMessages((prev) => replaceMessageById(prev, tempId, withDirectReceiptDefault(sent)));
      }
      if (sent && targetUser) {
        markDirectThreadSeen(targetUserId);
        setDirectConversations((prev) => upsertDirectConversation(prev, {
          user: targetUser,
          lastMessageAt: sent.createdAt,
          lastMessagePreview: buildConversationPreview(sent.message, sent.attachments).slice(0, 180),
          lastMessageSenderId: sent.senderId,
        }));
        setDirectCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
      }
      await syncDirectData({ silent: true });
    } catch (error) {
      setReplyingMessage(draftReply);
      setDirectMessages((prev) => replaceMessageWithFailedMessage(prev, tempId, createFailedMessageFromPayload({
        id: `failed-${tempId}`,
        mode: 'direct',
        threadId: targetUserId,
        currentUserId,
        senderName: user?.name || 'You',
        message: trimmedMessage,
        attachments: draftAttachments,
        replyTo: draftReply,
        payload: draftPayload,
      })));
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingDirectMessage(false);
    }
  };

  const resetMessageForwarding = () => {
    setSelectionMode(null);
    setSelectedGroupMessageIds([]);
    setSelectedDirectMessageIds([]);
    setForwardState(createInitialForwardState());
  };

  const startMessageSelection = (mode) => {
    setFeedback('');
    setSelectionMode(mode);
    if (mode === 'group') {
      setSelectedDirectMessageIds([]);
      return;
    }
    setSelectedGroupMessageIds([]);
  };

  const cancelMessageSelection = () => {
    resetMessageForwarding();
  };

  const toggleMessageSelection = (mode, messageId) => {
    if (mode === 'group') {
      setSelectedGroupMessageIds((prev) =>
        prev.includes(messageId) ? prev.filter((value) => value !== messageId) : [...prev, messageId]
      );
      return;
    }

    setSelectedDirectMessageIds((prev) =>
      prev.includes(messageId) ? prev.filter((value) => value !== messageId) : [...prev, messageId]
    );
  };

  const openForwardModal = () => {
    if (!selectedForwardMessages.length) {
      setFeedback('Select at least one message to forward.');
      return;
    }

    setForwardState((prev) => ({
      ...createInitialForwardState(),
      open: true,
      note: prev.note || '',
    }));
  };

  const closeForwardModal = () => {
    setForwardState((prev) => ({
      ...createInitialForwardState(),
      open: false,
      note: prev.note,
    }));
  };

  const toggleForwardGroupTarget = (groupId) => {
    setForwardState((prev) => ({
      ...prev,
      groupIds: prev.groupIds.includes(groupId)
        ? prev.groupIds.filter((value) => value !== groupId)
        : [...prev.groupIds, groupId],
    }));
  };

  const toggleForwardUserTarget = (userId) => {
    setForwardState((prev) => ({
      ...prev,
      userIds: prev.userIds.includes(userId)
        ? prev.userIds.filter((value) => value !== userId)
        : [...prev.userIds, userId],
    }));
  };

  const buildForwardPayload = () => {
    const sourceLabel = selectionMode === 'group'
      ? `group "${selectedGroup?.name || 'Unknown group'}"`
      : `chat with ${selectedDirectUser?.name || 'Unknown user'}`;
    const note = forwardState.note.trim();
    const messageBlocks = selectedForwardMessages.map((message, index) => {
      const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
      const attachmentLine = attachmentCount
        ? `Attachments: ${message.attachments.map((attachment) => getAttachmentLabel(attachment)).join(', ')}`
        : '';

      return [
        `[${index + 1}] ${message.senderName || 'Unknown'} • ${formatForwardTimestamp(message.createdAt)}`,
        message.message || (attachmentCount ? 'Forwarded attachment message' : ''),
        attachmentLine,
      ]
        .filter(Boolean)
        .join('\n');
    });

    const attachments = selectedForwardMessages.reduce(
      (accumulator, message) => mergeUniqueAttachments(accumulator, message.attachments || []),
      []
    );

    const message = [
      `Forwarded ${selectedForwardMessages.length === 1 ? 'message' : 'messages'} from ${sourceLabel}`,
      note ? `Note: ${note}` : '',
      '',
      ...messageBlocks,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      message,
      attachments,
      forward_metadata: {
        sourceMode: selectionMode,
        sourceLabel,
        forwardedAt: new Date().toISOString(),
        messageIds: selectedForwardMessages.map((item) => item.id),
        messages: selectedForwardMessages.map((item) => ({
          id: item.id,
          senderId: item.senderId,
          senderName: item.senderName || 'Unknown',
          createdAt: item.createdAt,
          attachmentCount: Array.isArray(item.attachments) ? item.attachments.length : 0,
        })),
      },
    };
  };

  const submitForwardMessages = async () => {
    const targetCount = forwardState.groupIds.length + forwardState.userIds.length;
    if (!selectedForwardMessages.length) {
      setFeedback('Select at least one message to forward.');
      return;
    }
    if (targetCount === 0) {
      setFeedback('Choose at least one group or individual recipient.');
      return;
    }

    setForwardState((prev) => ({ ...prev, sending: true }));
    try {
      const payload = buildForwardPayload();
      const forwardingTargets = [
        ...forwardState.groupIds.map((groupId) => ({
          kind: 'group',
          id: groupId,
          request: groupAPI.sendMessage(groupId, payload),
        })),
        ...forwardState.userIds.map((userId) => ({
          kind: 'direct',
          id: userId,
          request: directMessageAPI.sendMessage(userId, payload),
        })),
      ];
      const settledResults = await Promise.allSettled(
        forwardingTargets.map((target) => target.request)
      );
      const failedTargets = [];
      let successCount = 0;

      settledResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successCount += 1;
          return;
        }
        failedTargets.push(forwardingTargets[index]);
      });

      if (successCount > 0) {
        syncGroups({ silent: true }).catch(() => {});
        syncDirectData({ silent: true }).catch(() => {});
      }

      if (failedTargets.length === 0) {
        setFeedback(
          `Forwarded ${selectedForwardMessages.length} ${selectedForwardMessages.length === 1 ? 'message' : 'messages'} to ${targetCount} ${targetCount === 1 ? 'destination' : 'destinations'}.`
        );
        resetMessageForwarding();
        return;
      }

      const firstError = settledResults.find((result) => result.status === 'rejected')?.reason;
      setForwardState((prev) => ({
        ...prev,
        sending: false,
        groupIds: failedTargets.filter((target) => target.kind === 'group').map((target) => target.id),
        userIds: failedTargets.filter((target) => target.kind === 'direct').map((target) => target.id),
      }));
      setFeedback(
        successCount > 0
          ? `Forwarded ${selectedForwardMessages.length} ${selectedForwardMessages.length === 1 ? 'message' : 'messages'} to ${successCount} ${successCount === 1 ? 'destination' : 'destinations'}. ${failedTargets.length} ${failedTargets.length === 1 ? 'destination needs' : 'destinations need'} another try.`
          : firstError?.response?.data?.detail || 'Failed to forward selected messages.'
      );
    } catch (error) {
      setForwardState((prev) => ({ ...prev, sending: false }));
      setFeedback(error?.response?.data?.detail || 'Failed to forward selected messages.');
    }
  };

  const discardFailedMessage = (mode, message) => {
    if (!message?.failed) return;
    if (mode === 'group') {
      setMessages((prev) => removeMessageById(prev, message.id));
      return;
    }
    setDirectMessages((prev) => removeMessageById(prev, message.id));
  };

  const retryFailedMessage = async (mode, message) => {
    if (!message?.failed || !message.failedPayload) return;
    if (mode === 'group') {
      const targetGroupId = message.failedThreadId || selectedGroupIdRef.current;
      if (!targetGroupId) return;
      setMessages((prev) => removeMessageById(prev, message.id));
      try {
        await sendGroupMessage(message.failedPayload);
        setFeedback('');
      } catch (error) {
        setFeedback(error?.response?.data?.detail || 'Failed to retry message.');
      }
      return;
    }

    const targetUserId = message.failedThreadId || selectedDirectUserIdRef.current;
    if (!targetUserId) return;
    const retryId = `retry-${Date.now()}`;
    const retryMessage = {
      ...message,
      id: retryId,
      failed: false,
      isOptimistic: true,
      receipt: {
        status: 'sending',
        totalRecipientCount: 1,
        deliveredCount: 0,
        deliveredBy: [],
        readCount: 0,
        readBy: [],
      },
    };
    setDirectMessages((prev) => appendMessageById(removeMessageById(prev, message.id), retryMessage));
    try {
      const response = await directMessageAPI.sendMessage(targetUserId, message.failedPayload);
      const sent = response?.data;
      if (sent) {
        setDirectMessages((prev) => replaceMessageById(prev, retryId, withDirectReceiptDefault(sent)));
        markDirectThreadSeen(targetUserId);
        await syncDirectData({ silent: true });
      }
      setFeedback('');
    } catch (error) {
      setDirectMessages((prev) => replaceMessageWithFailedMessage(prev, retryId, {
        ...message,
        id: `failed-${retryId}`,
        failed: true,
        isOptimistic: false,
      }));
      setFeedback(error?.response?.data?.detail || 'Failed to retry message.');
    }
  };

  const isGroupSelectionActive = selectionMode === 'group';
  const isDirectSelectionActive = selectionMode === 'direct';
  const mutedGroupIdSet = useMemo(() => new Set(mutedGroupIds.map(Number)), [mutedGroupIds]);
  const mutedUserIdSet = useMemo(() => new Set(mutedUserIds.map(Number)), [mutedUserIds]);
  const showEmptyGroupsState = !loading && !isRefreshing && hasResolvedGroupIndex && groups.length === 0;
  const showEmptyDirectState = !directLoading && !directRefreshing && hasResolvedDirectIndex && directListItems.length === 0;
  const showEmptyGroupSearchState =
    !loading && !isRefreshing && hasResolvedGroupIndex && groups.length > 0 && filteredGroups.length === 0;
  const showEmptyDirectSearchState =
    !directLoading && !directRefreshing && hasResolvedDirectIndex && directListItems.length > 0 && filteredDirectListItems.length === 0;
  const isSelectedGroupMuted = !!selectedGroup && mutedGroupIdSet.has(Number(selectedGroup.id));
  const isSelectedDirectMuted = !!selectedDirectUser && mutedUserIdSet.has(Number(selectedDirectUser.id));
  const countAudibleUnreadThreads = (counts, mutedSet) =>
    Object.entries(counts).filter(([threadId, count]) => count > 0 && !mutedSet.has(Number(threadId))).length;
  const groupUnreadThreadCount = countAudibleUnreadThreads(groupUnreadCounts, mutedGroupIdSet);
  const directUnreadThreadCount = countAudibleUnreadThreads(directUnreadCounts, mutedUserIdSet);
  const isErrorFeedback = ERROR_FEEDBACK_PATTERN.test(feedback);

  const refreshCurrentView = () => {
    (activeTab === 'groups' ? syncGroups({ silent: true }) : syncDirectData({ silent: true })).catch(() => {});
  };

  const switchListTab = (tab) => {
    setActiveTab(tab);
    setVisibleListTab(tab);
  };

  const openGroupThread = (groupId) => {
    if (groupId !== selectedGroupId) {
      setUnreadMarker({ key: `group:${groupId}`, count: groupUnreadCounts[groupId] || 0 });
    }
    setSelectedGroupId(groupId);
    if (isMobileViewport()) setVisibleListTab(null);
  };

  const openDirectThread = (userId) => {
    if (userId !== selectedDirectUserId) {
      setUnreadMarker({ key: `direct:${userId}`, count: directUnreadCounts[userId] || 0 });
    }
    setSelectedDirectUserId(userId);
    if (isMobileViewport()) setVisibleListTab(null);
  };

  // Background alerts stay quiet for the conversation that is on screen.
  useEffect(() => {
    // On phones the list and the conversation take turns filling the screen.
    const isConversationShown = !isMobileViewport() || visibleListTab !== activeTab;
    const isOnScreen = isActive && !isMinimized && isConversationShown;
    if (!isOnScreen) {
      clearActiveChat();
      return undefined;
    }
    if (activeTab === 'groups') setActiveChat('group', selectedGroupId);
    else setActiveChat('direct', selectedDirectUserId);
    return () => clearActiveChat();
  }, [activeTab, isActive, isMinimized, selectedDirectUserId, selectedGroupId, visibleListTab]);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(() => setFeedback(''), FEEDBACK_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!highlightedMessageId) return undefined;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), HIGHLIGHT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  // Removing someone (or leaving) takes two clicks; the armed state expires.
  const confirmMemberRemoval = (memberId) => {
    if (pendingMemberRemovalId !== memberId) {
      setPendingMemberRemovalId(memberId);
      return;
    }
    setPendingMemberRemovalId(null);
    removeMember(memberId);
  };

  useEffect(() => {
    if (!pendingMemberRemovalId) return undefined;
    const timer = window.setTimeout(() => setPendingMemberRemovalId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pendingMemberRemovalId]);

  const handleCopyMessage = async (message) => {
    const text = `${message?.message || ''}`;
    if (!text) return;
    const copyWithSelection = () => {
      // Fallback for plain-HTTP deployments (no Clipboard API) and for
      // clipboard requests the browser leaves pending.
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      return copied;
    };

    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('Clipboard timed out')), 1200)),
      ]);
      setFeedback('Message copied to clipboard.');
    } catch {
      setFeedback(copyWithSelection() ? 'Message copied to clipboard.' : 'Unable to copy this message.');
    }
  };

  const handleTogglePin = async (mode, message) => {
    if (!message?.id || message.isOptimistic || message.deletedAt) return;
    const threadId = mode === 'group' ? selectedGroupIdRef.current : selectedDirectUserIdRef.current;
    if (!threadId) return;
    const shouldPin = !message.pinnedAt;
    const chatAPI = mode === 'group' ? groupAPI : directMessageAPI;
    const setRows = mode === 'group' ? setMessages : setDirectMessages;
    const setPinned = mode === 'group' ? setGroupPinned : setDirectPinned;

    try {
      const response = shouldPin
        ? await chatAPI.pinMessage(threadId, message.id)
        : await chatAPI.unpinMessage(threadId, message.id);
      const pinnedMessage = response?.data || null;
      setRows((prev) => prev.map((row) => (
        row.id === message.id
          ? { ...row, pinnedAt: pinnedMessage?.pinnedAt || null, pinnedBy: pinnedMessage?.pinnedBy || null }
          : row
      )));
      setPinned((prev) => {
        const remaining = prev.filter((entry) => entry.id !== message.id);
        return shouldPin && pinnedMessage ? [pinnedMessage, ...remaining] : remaining;
      });
      setFeedback(shouldPin ? 'Message pinned for everyone in this chat.' : 'Message unpinned.');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to update the pin.');
    }
  };

  const toggleThreadMute = async (mode, threadId) => {
    const numericThreadId = Number(threadId);
    if (!numericThreadId) return;
    const isGroup = mode === 'group';
    const currentlyMuted = isGroup ? mutedGroupIdSet.has(numericThreadId) : mutedUserIdSet.has(numericThreadId);
    const setIds = isGroup ? setMutedGroupIds : setMutedUserIds;
    const applyMuted = (muted) => setIds((prev) => (
      muted ? Array.from(new Set([...prev, numericThreadId])) : prev.filter((id) => Number(id) !== numericThreadId)
    ));

    applyMuted(!currentlyMuted);
    try {
      await (isGroup
        ? groupAPI.setMuted(numericThreadId, !currentlyMuted)
        : directMessageAPI.setMuted(numericThreadId, !currentlyMuted));
      setFeedback(currentlyMuted
        ? 'Notifications are back on for this chat.'
        : 'Chat muted. Unread counts still show, but no sounds or pop-ups.');
      syncUnreadCounts({ silent: true });
    } catch (error) {
      applyMuted(currentlyMuted);
      setFeedback(error?.response?.data?.detail || 'Failed to update notifications.');
    }
  };

  const jumpToMessage = (mode, message) => {
    if (!message?.id) return;
    setScrollRequest({ mode, messageId: message.id, nonce: Date.now() });
    // Reset first so jumping to the same message twice replays the flash.
    setHighlightedMessageId(null);
    window.requestAnimationFrame(() => setHighlightedMessageId(message.id));
  };

  const handleScrollRequestMissed = () => {
    setHighlightedMessageId(null);
    setFeedback('That pinned message is older than the loaded history.');
  };

  const handleGroupComposerChange = (nextValue) => {
    if (isEditingGroupMessage) {
      updateEditingMessageText(nextValue);
      return;
    }
    setNewMessage(nextValue);
    handleTypingInput('group', selectedGroupIdRef.current, nextValue);
    if (selectedGroupIdRef.current) {
      updateGroupComposerDraft(selectedGroupIdRef.current, {
        text: nextValue,
        attachments: pendingAttachments,
        uploading: uploadingAttachment,
        uploadState: attachmentUploadState,
      });
    }
  };

  const handleDirectComposerChange = (nextValue) => {
    if (isEditingDirectMessage) {
      updateEditingMessageText(nextValue);
      return;
    }
    setDirectNewMessage(nextValue);
    handleTypingInput('direct', selectedDirectUserIdRef.current, nextValue);
    if (selectedDirectUserIdRef.current) {
      updateDirectComposerDraft(selectedDirectUserIdRef.current, {
        text: nextValue,
        attachments: directPendingAttachments,
        uploading: uploadingDirectAttachment,
        uploadState: directAttachmentUploadState,
      });
    }
  };

  const removeGroupPendingAttachment = (index) => {
    setPendingAttachments((prev) => {
      const nextAttachments = prev.filter((_, attachmentIndex) => attachmentIndex !== index);
      if (selectedGroupIdRef.current) {
        updateGroupComposerDraft(selectedGroupIdRef.current, {
          text: newMessage,
          attachments: nextAttachments,
          uploading: uploadingAttachment,
          uploadState: attachmentUploadState,
        });
      }
      return nextAttachments;
    });
  };

  const removeDirectPendingAttachment = (index) => {
    setDirectPendingAttachments((prev) => {
      const nextAttachments = prev.filter((_, attachmentIndex) => attachmentIndex !== index);
      if (selectedDirectUserIdRef.current) {
        updateDirectComposerDraft(selectedDirectUserIdRef.current, {
          text: directNewMessage,
          attachments: nextAttachments,
          uploading: uploadingDirectAttachment,
          uploadState: directAttachmentUploadState,
        });
      }
      return nextAttachments;
    });
  };

  const buildReplyContext = (mode) => (
    replyingMessage?.mode === mode
      ? {
          messageId: replyingMessage.messageId,
          senderName: replyingMessage.senderName,
          preview: replyingMessage.message || buildAttachmentCountLabel(replyingMessage.attachments),
        }
      : null
  );

  const isActiveListVisible = visibleListTab === activeTab;
  const deleteMessagePreview = deleteConfirmation.message
    ? buildConversationPreview(deleteConfirmation.message.message, deleteConfirmation.message.attachments) || 'Message'
    : 'Message';
  const deleteThreadLabel = deleteConfirmation.threadLabel || (
    deleteConfirmation.mode === 'group' ? 'this group' : 'this direct chat'
  );

  const activeCacheStatus = activeTab === 'groups' ? groupsCacheStatus : directCacheStatus;
  const isSyncing = activeTab === 'groups'
    ? isRefreshing || isMessagesRefreshing
    : directRefreshing || directMessagesRefreshing;
  const syncStatusLabel = isSyncing ? 'Syncing…' : activeCacheStatus.showingCached ? 'Saved copy' : '';
  const syncStatus = syncStatusLabel ? (
    <span className={`chat-sync-status ${isSyncing ? 'is-syncing' : ''}`} role="status">
      <span className="chat-sync-dot" aria-hidden="true" />
      {syncStatusLabel}
    </span>
  ) : null;

  const createGroupCandidates = useMemo(() => {
    const query = createGroupFilter.trim().toLowerCase();
    return allUsers
      .filter((groupUser) => groupUser.id !== currentUserId)
      .filter((groupUser) => !query || `${groupUser.name || ''} ${groupUser.department || ''} ${groupUser.email || ''}`.toLowerCase().includes(query));
  }, [allUsers, createGroupFilter, currentUserId]);

  const addableGroupMembers = useMemo(
    () => (selectedGroup
      ? allUsers.filter((groupUser) => !selectedGroup.members.some((member) => member.id === groupUser.id))
      : []),
    [allUsers, selectedGroup]
  );

  const renderPersonOption = (person, checked, onToggle) => (
    <label key={person.id} className={`chat-person-option ${checked ? 'is-checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="person-avatar person-avatar--xs" style={{ '--avatar-hue': `${buildAvatarHue(person.name)}deg` }} aria-hidden="true">
        {buildInitials(person.name)}
      </span>
      <span className="chat-person-copy">
        <strong>{person.name}</strong>
        <small>{person.department || person.position || 'Team member'}</small>
      </span>
    </label>
  );

  const renderSelectionBar = (count) => (
    <div className="chat-selection-bar" role="toolbar" aria-label="Selected messages">
      <span><strong>{count}</strong> {count === 1 ? 'message' : 'messages'} selected</span>
      <div className="chat-selection-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={cancelMessageSelection}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={openForwardModal} disabled={count === 0}>
          <IconForward size={14} />
          Forward
        </button>
      </div>
    </div>
  );

  const threadRowProps = (mode) => ({
    currentUserId,
    highlightedMessageId,
    isSelectionActive: mode === 'group' ? isGroupSelectionActive : isDirectSelectionActive,
    items: mode === 'group' ? messageItems : directMessageItems,
    mode,
    onCopyMessage: handleCopyMessage,
    onDeleteMessage: handleDeleteMessage,
    onDiscardFailedMessage: discardFailedMessage,
    onEditMessage: handleEditMessage,
    onOpenReceiptDetails: mode === 'group' ? openGroupReceiptDetails : undefined,
    onReactToMessage: handleMessageReaction,
    onReplyToMessage: handleReplyToMessage,
    onRetryFailedMessage: retryFailedMessage,
    onTogglePin: handleTogglePin,
    selectedIds: mode === 'group' ? selectedGroupMessageIds : selectedDirectMessageIds,
    toggleMessageSelection,
  });

  const groupListItems = filteredGroups.map((group) => {
    const unreadCount = groupUnreadCounts[group.id] || 0;
    const hasUnread = unreadCount > 0;
    const isMuted = mutedGroupIdSet.has(Number(group.id));
    const isSelected = selectedGroupId === group.id;
    const typingLabel = buildTypingLabel(Object.values(groupTypingByGroupId[group.id] || {}));
    const senderLabel = Number(group.lastMessageSenderId) === Number(currentUserId)
      ? 'You'
      : firstName(group.lastMessageSenderName || '');
    const draftText = isSelected ? '' : `${groupComposerDrafts[group.id]?.text || ''}`.trim();
    const preview = group.lastMessagePreview
      ? `${senderLabel ? `${senderLabel}: ` : ''}${group.lastMessagePreview}`
      : `${group.memberCount} members`;

    return (
      <button
        type="button"
        key={group.id}
        className={`chat-list-item ${isSelected ? 'is-active' : ''} ${hasUnread ? 'has-unread' : ''} ${isMuted ? 'is-muted' : ''}`}
        onClick={() => openGroupThread(group.id)}
        aria-current={isSelected ? 'true' : undefined}
      >
        <span className="person-avatar person-avatar--md person-avatar--group" style={{ '--avatar-hue': `${buildAvatarHue(group.name)}deg` }} aria-hidden="true">
          {buildInitials(group.name)}
        </span>
        <span className="chat-list-body">
          <span className="chat-list-top">
            <span className="chat-list-name">{group.name}</span>
            {isMuted && <IconBellOff size={12} className="chat-list-muted-icon" aria-label="Muted" />}
            <span className="chat-list-time">{formatListTimestamp(group.lastMessageAt)}</span>
          </span>
          <span className="chat-list-bottom">
            {typingLabel
              ? <span className="chat-list-preview is-typing">{typingLabel}</span>
              : draftText
                ? <span className="chat-list-preview is-draft"><strong>Draft:</strong> {draftText}</span>
                : <span className="chat-list-preview">{preview}</span>}
            {hasUnread && (
              <span className={`chat-badge ${isMuted ? 'is-muted' : ''}`} aria-label={`${unreadCount} unread`}>
                {formatUnreadCount(unreadCount)}
              </span>
            )}
          </span>
        </span>
      </button>
    );
  });

  const renderDirectListItem = (item) => {
    const unreadCount = directUnreadCounts[item.id] || 0;
    const hasUnread = unreadCount > 0;
    const isMuted = mutedUserIdSet.has(Number(item.id));
    const isSelected = selectedDirectUserId === item.id;
    const presenceClass = getPresenceClassName(item.presence);
    const typingLabel = Object.keys(directTypingByUserId[item.id] || {}).length ? 'typing…' : '';
    const conversation = item.conversation;
    const draftText = isSelected ? '' : `${directComposerDrafts[item.id]?.text || ''}`.trim();
    const preview = conversation?.lastMessagePreview
      ? `${Number(conversation.lastMessageSenderId) === Number(currentUserId) ? 'You: ' : ''}${conversation.lastMessagePreview}`
      : item.department || item.position || 'Start a conversation';

    return (
      <button
        type="button"
        key={item.id}
        className={`chat-list-item ${isSelected ? 'is-active' : ''} ${hasUnread ? 'has-unread' : ''} ${isMuted ? 'is-muted' : ''}`}
        onClick={() => openDirectThread(item.id)}
        aria-current={isSelected ? 'true' : undefined}
      >
        <span className="person-avatar person-avatar--md" style={{ '--avatar-hue': `${buildAvatarHue(item.name)}deg` }} aria-hidden="true">
          {buildInitials(item.name)}
          <span className={`chat-presence chat-presence--${presenceClass}`} />
        </span>
        <span className="chat-list-body">
          <span className="chat-list-top">
            <span className="chat-list-name">{item.name}</span>
            {isMuted && <IconBellOff size={12} className="chat-list-muted-icon" aria-label="Muted" />}
            <span className="chat-list-time">{formatListTimestamp(conversation?.lastMessageAt)}</span>
          </span>
          <span className="chat-list-bottom">
            {typingLabel
              ? <span className="chat-list-preview is-typing">{typingLabel}</span>
              : draftText
                ? <span className="chat-list-preview is-draft"><strong>Draft:</strong> {draftText}</span>
                : <span className={`chat-list-preview ${conversation ? '' : 'is-placeholder'}`}>{preview}</span>}
            {hasUnread && (
              <span className={`chat-badge ${isMuted ? 'is-muted' : ''}`} aria-label={`${unreadCount} unread`}>
                {formatUnreadCount(unreadCount)}
              </span>
            )}
          </span>
        </span>
      </button>
    );
  };

  const recentDirectItems = filteredDirectListItems.filter((item) => item.conversation);
  const otherDirectItems = filteredDirectListItems.filter((item) => !item.conversation);

  const sidebar = (
    <aside className="chat-sidebar" aria-label="Conversations">
      <div className="chat-sidebar-top">
        <div className="chat-tabs" role="tablist" aria-label="Conversation type">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'groups'}
            className={`chat-tab ${activeTab === 'groups' ? 'is-active' : ''}`}
            onClick={() => switchListTab('groups')}
          >
            <IconUsers size={15} />
            <span>Groups</span>
            {groupUnreadThreadCount > 0 && <span className="chat-tab-count">{formatUnreadCount(groupUnreadThreadCount)}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'direct'}
            className={`chat-tab ${activeTab === 'direct' ? 'is-active' : ''}`}
            onClick={() => switchListTab('direct')}
          >
            <IconUser size={15} />
            <span>Direct</span>
            {directUnreadThreadCount > 0 && <span className="chat-tab-count">{formatUnreadCount(directUnreadThreadCount)}</span>}
          </button>
        </div>
        <label className="chat-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={messageSearch}
            onChange={(event) => setMessageSearch(event.target.value)}
            placeholder={activeTab === 'groups' ? 'Search groups or members' : 'Search people or messages'}
            aria-label={activeTab === 'groups' ? 'Search groups' : 'Search direct messages'}
          />
        </label>
      </div>

      <div className="chat-sidebar-heading">
        <span>
          {activeTab === 'groups'
            ? `${filteredGroups.length} ${filteredGroups.length === 1 ? 'group' : 'groups'}`
            : `${filteredDirectListItems.length} ${filteredDirectListItems.length === 1 ? 'person' : 'people'}`}
        </span>
        <div className="chat-sidebar-actions">
          <button type="button" className={`icon-btn icon-btn--sm ${isSyncing ? 'is-spinning' : ''}`} onClick={refreshCurrentView} title="Refresh" aria-label="Refresh conversations">
            <IconRefresh size={14} />
          </button>
          {activeTab === 'groups' && (
            <button
              type="button"
              className={`icon-btn icon-btn--sm ${showGroupComposer ? 'is-active' : ''}`}
              onClick={() => setShowGroupComposer((prev) => !prev)}
              title="New group"
              aria-label="Create a new group"
              aria-expanded={showGroupComposer}
            >
              <IconPlus size={15} />
            </button>
          )}
        </div>
      </div>

      {activeTab === 'groups' && showGroupComposer && (
        <div className="chat-create-group">
          <div className="chat-create-group-head">
            <strong>New group</strong>
            <button type="button" className="icon-btn icon-btn--sm" onClick={() => setShowGroupComposer(false)} aria-label="Close new group form">
              <IconClose size={14} />
            </button>
          </div>
          <input
            className="chat-field"
            type="text"
            placeholder="Group name"
            maxLength={80}
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
          />
          <label className="chat-search chat-search--compact">
            <IconSearch size={13} />
            <input
              type="search"
              value={createGroupFilter}
              onChange={(event) => setCreateGroupFilter(event.target.value)}
              placeholder="Filter people"
              aria-label="Filter people to add"
            />
          </label>
          <div className="chat-people-picker">
            {loading && <div className="chat-muted-note">Loading people…</div>}
            {!loading && createGroupCandidates.length === 0 && <div className="chat-muted-note">No people match this filter.</div>}
            {!loading && createGroupCandidates.map((groupUser) =>
              renderPersonOption(groupUser, selectedIds.includes(groupUser.id), () => toggleSelected(groupUser.id))
            )}
          </div>
          <div className="chat-create-group-foot">
            <span>{selectedIds.length} selected</span>
            <button type="button" className="btn btn--primary btn--sm" onClick={createGroup} disabled={!groupName.trim() || selectedIds.length === 0}>
              Create group
            </button>
          </div>
        </div>
      )}

      <div className="chat-list">
        {activeTab === 'groups' && (
          <>
            {loading && !groups.length && <div className="chat-list-skeleton" aria-hidden="true"><span /><span /><span /></div>}
            {showEmptyGroupsState && <div className="chat-muted-note">No groups yet. Use + to create one.</div>}
            {showEmptyGroupSearchState && <div className="chat-muted-note">No groups match “{messageSearch.trim()}”.</div>}
            {groupListItems}
          </>
        )}
        {activeTab === 'direct' && (
          <>
            {directLoading && !directListItems.length && <div className="chat-list-skeleton" aria-hidden="true"><span /><span /><span /></div>}
            {showEmptyDirectState && <div className="chat-muted-note">No people available for direct chat yet.</div>}
            {showEmptyDirectSearchState && <div className="chat-muted-note">No people or chats match “{messageSearch.trim()}”.</div>}
            {recentDirectItems.length > 0 && <div className="chat-list-section">Recent</div>}
            {recentDirectItems.map(renderDirectListItem)}
            {otherDirectItems.length > 0 && <div className="chat-list-section">All people</div>}
            {otherDirectItems.map(renderDirectListItem)}
          </>
        )}
      </div>
    </aside>
  );

  const backButton = (
    <button
      type="button"
      className="icon-btn chat-back"
      onClick={() => setVisibleListTab(activeTab)}
      aria-label="Back to conversations"
    >
      <IconChevronLeft size={18} />
    </button>
  );

  const groupWindow = (
    <section className="chat-pane" aria-label={selectedGroup ? `${selectedGroup.name} conversation` : 'Group conversation'}>
      {!selectedGroup ? (
        <ChatEmptyState icon={IconUsers} title="Select a group" text="Pick a group from the list to read and reply to the conversation." />
      ) : (
        <>
          <header className="chat-pane-header">
            {backButton}
            <span className="person-avatar person-avatar--lg person-avatar--group" style={{ '--avatar-hue': `${buildAvatarHue(selectedGroup.name)}deg` }} aria-hidden="true">
              {buildInitials(selectedGroup.name)}
            </span>
            <div className="chat-pane-header-copy">
              <div className="chat-pane-header-title">
                <h3>{selectedGroup.name}</h3>
                {isSelectedGroupAdmin && <span className="chat-pill">Admin</span>}
                {isSelectedGroupMuted && <span className="chat-pill chat-pill--muted"><IconBellOff size={11} />Muted</span>}
              </div>
              <p className="chat-pane-header-sub">
                {selectedGroup.memberCount} members
                {selectedGroupOnlineCount > 0 && (
                  <>
                    <span className="chat-dot-sep" aria-hidden="true">·</span>
                    <span className="chat-online">{selectedGroupOnlineCount} online</span>
                  </>
                )}
              </p>
            </div>
            <div className="chat-pane-header-actions">
              <button
                type="button"
                className={`icon-btn ${isSelectedGroupMuted ? 'is-active' : ''}`}
                onClick={() => toggleThreadMute('group', selectedGroup.id)}
                title={isSelectedGroupMuted ? 'Unmute notifications' : 'Mute notifications'}
                aria-label={isSelectedGroupMuted ? 'Unmute notifications' : 'Mute notifications'}
                aria-pressed={isSelectedGroupMuted}
              >
                {isSelectedGroupMuted ? <IconBellOff size={17} /> : <IconBell size={17} />}
              </button>
              <button
                type="button"
                className={`icon-btn ${isGroupSelectionActive ? 'is-active' : ''}`}
                onClick={() => (isGroupSelectionActive ? cancelMessageSelection() : startMessageSelection('group'))}
                title={isGroupSelectionActive ? 'Cancel selection' : 'Select messages to forward'}
                aria-label={isGroupSelectionActive ? 'Cancel selection' : 'Select messages to forward'}
                aria-pressed={isGroupSelectionActive}
              >
                <IconSelect size={17} />
              </button>
              <div className="chat-menu-wrap" ref={groupMenuRef}>
                <button
                  type="button"
                  className={`icon-btn ${showGroupMenu ? 'is-active' : ''}`}
                  onClick={() => setShowGroupMenu((prev) => !prev)}
                  title="Members"
                  aria-label="Show group members"
                  aria-expanded={showGroupMenu}
                >
                  <IconUsers size={17} />
                </button>

                {showGroupMenu && (
                  <div className="chat-popover chat-members-popover" role="dialog" aria-label="Group members">
                    <div className="chat-popover-head">
                      <div>
                        <strong>Members</strong>
                        <span>{selectedGroup.memberCount} people</span>
                      </div>
                      {isSelectedGroupAdmin && (
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAddMemberPanel((prev) => !prev)}>
                          {showAddMemberPanel ? 'Done' : (<><IconPlus size={13} />Add people</>)}
                        </button>
                      )}
                    </div>

                    {showAddMemberPanel && isSelectedGroupAdmin && (
                      <div className="chat-add-members">
                        <div className="chat-people-picker chat-people-picker--short">
                          {addableGroupMembers.length === 0 && <div className="chat-muted-note">Everyone is already in this group.</div>}
                          {addableGroupMembers.map((groupUser) =>
                            renderPersonOption(
                              groupUser,
                              addMemberSelection.includes(groupUser.id),
                              () => setAddMemberSelection((prev) => (
                                prev.includes(groupUser.id) ? prev.filter((value) => value !== groupUser.id) : [...prev, groupUser.id]
                              ))
                            )
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm btn--block"
                          onClick={() => saveAddMembers(selectedGroup.id)}
                          disabled={addMemberSelection.length === 0}
                        >
                          Add {addMemberSelection.length || ''} {addMemberSelection.length === 1 ? 'person' : 'people'}
                        </button>
                      </div>
                    )}

                    <ul className="chat-member-list">
                      {selectedGroup.members.map((member) => {
                        const presenceClass = getPresenceClassName(member.presence);
                        const canManage = isSelectedGroupAdmin && member.id !== currentUserId && selectedGroup.createdBy !== member.id;
                        const canLeave = member.id === currentUserId && selectedGroup.createdBy !== currentUserId;
                        return (
                          <li key={member.id} className="chat-member">
                            <span className="person-avatar person-avatar--sm" style={{ '--avatar-hue': `${buildAvatarHue(member.name)}deg` }} aria-hidden="true">
                              {buildInitials(member.name)}
                              <span className={`chat-presence chat-presence--${presenceClass}`} />
                            </span>
                            <span className="chat-member-copy">
                              <strong>
                                {member.name}
                                {member.id === currentUserId && <span className="chat-member-you"> (you)</span>}
                              </strong>
                              <small>
                                <span className={`chat-presence-text is-${presenceClass}`}>{getPresenceLabel(member.presence)}</span>
                                {member.role === 'admin' && <span className="chat-member-role">Admin</span>}
                              </small>
                            </span>
                            {(canManage || canLeave) && (
                              <span className="chat-member-actions">
                                {canManage && (
                                  <>
                                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => updateMemberRole(member.id, member.role === 'admin' ? 'member' : 'admin')}>
                                      {member.role === 'admin' ? 'Remove admin' : 'Make admin'}
                                    </button>
                                    <button
                                      type="button"
                                      className={`btn btn--xs ${pendingMemberRemovalId === member.id ? 'btn--danger' : 'btn--danger-ghost'}`}
                                      onClick={() => confirmMemberRemoval(member.id)}
                                    >
                                      {pendingMemberRemovalId === member.id ? 'Confirm' : 'Remove'}
                                    </button>
                                  </>
                                )}
                                {canLeave && (
                                  <button
                                    type="button"
                                    className={`btn btn--xs ${pendingMemberRemovalId === member.id ? 'btn--danger' : 'btn--danger-ghost'}`}
                                    onClick={() => confirmMemberRemoval(member.id)}
                                  >
                                    {pendingMemberRemovalId === member.id ? 'Confirm leave' : 'Leave group'}
                                  </button>
                                )}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </header>

          <PinnedMessagesBar
            pinned={groupPinned}
            threadKey={`group-${selectedGroupId}`}
            onJump={(message) => jumpToMessage('group', message)}
            onUnpin={(message) => handleTogglePin('group', message)}
          />

          {isGroupSelectionActive && renderSelectionBar(selectedGroupMessageIds.length)}

          <ChatThread
            currentUserId={currentUserId}
            dropLabel={`Files will be added to your message in ${selectedGroup.name}`}
            emptyState={groupThreadLoading
              ? <ThreadLoadingState />
              : <ChatEmptyState icon={IconChat} title="No messages yet" text={`Start the conversation in ${selectedGroup.name}.`} />}
            items={messageItems}
            onDropFiles={isEditingGroupMessage ? undefined : handleAttachmentSelect}
            onScrollRequestMissed={handleScrollRequestMissed}
            rowHeight={groupRowHeight}
            rowProps={threadRowProps('group')}
            scrollRequest={scrollRequest?.mode === 'group' ? scrollRequest : null}
            threadKey={`group-${selectedGroupId}`}
            typingLabel={selectedGroupTypingLabel}
          />

          <ChatComposer
            attachments={pendingAttachments}
            canSend={isEditingGroupMessage
              ? !editingMessage.saving && !!editingMessage.text.trim()
              : !sendingMessage && !uploadingAttachment && (!!newMessage.trim() || pendingAttachments.length > 0)}
            editing={isEditingGroupMessage ? editingMessage : null}
            focusKey={`group-${selectedGroupId}`}
            getAttachmentLabel={getAttachmentLabel}
            onCancelEdit={cancelEditMessage}
            onCancelReply={cancelReplyToMessage}
            onCancelUpload={cancelGroupAttachmentUpload}
            onChange={handleGroupComposerChange}
            onPasteFiles={handleAttachmentSelect}
            onPickFiles={() => openAttachmentPicker('files')}
            onPickFolder={() => openAttachmentPicker('folder')}
            onRemoveAttachment={removeGroupPendingAttachment}
            onSubmit={isEditingGroupMessage ? submitEditMessage : sendMessage}
            placeholder={isEditingGroupMessage ? 'Edit your message' : `Message ${selectedGroup.name}`}
            replyingTo={buildReplyContext('group')}
            sending={sendingMessage}
            uploadState={attachmentUploadState}
            uploading={uploadingAttachment}
            value={isEditingGroupMessage ? editingMessage.text : newMessage}
          />
        </>
      )}
    </section>
  );

  const directWindow = (
    <section className="chat-pane" aria-label={selectedDirectUser ? `Conversation with ${selectedDirectUser.name}` : 'Direct conversation'}>
      {!selectedDirectUser ? (
        <ChatEmptyState icon={IconUser} title="Select a conversation" text="Pick a teammate from the list to start or continue a direct conversation." />
      ) : (
        <>
          <header className="chat-pane-header">
            {backButton}
            <span className="person-avatar person-avatar--lg" style={{ '--avatar-hue': `${buildAvatarHue(selectedDirectUser.name)}deg` }} aria-hidden="true">
              {buildInitials(selectedDirectUser.name)}
              <span className={`chat-presence chat-presence--${getPresenceClassName(selectedDirectUser.presence)}`} />
            </span>
            <div className="chat-pane-header-copy">
              <div className="chat-pane-header-title">
                <h3>{selectedDirectUser.name}</h3>
                {isSelectedDirectMuted && <span className="chat-pill chat-pill--muted"><IconBellOff size={11} />Muted</span>}
              </div>
              <p className="chat-pane-header-sub">
                <span className={`chat-presence-text is-${getPresenceClassName(selectedDirectUser.presence)}`}>
                  {getPresenceLabel(selectedDirectUser.presence)}
                </span>
                {(selectedDirectUser.department || selectedDirectUser.position) && (
                  <>
                    <span className="chat-dot-sep" aria-hidden="true">·</span>
                    <span>{[selectedDirectUser.department, selectedDirectUser.position].filter(Boolean).join(', ')}</span>
                  </>
                )}
              </p>
            </div>
            <div className="chat-pane-header-actions">
              <button
                type="button"
                className={`icon-btn ${isSelectedDirectMuted ? 'is-active' : ''}`}
                onClick={() => toggleThreadMute('direct', selectedDirectUser.id)}
                title={isSelectedDirectMuted ? 'Unmute notifications' : 'Mute notifications'}
                aria-label={isSelectedDirectMuted ? 'Unmute notifications' : 'Mute notifications'}
                aria-pressed={isSelectedDirectMuted}
              >
                {isSelectedDirectMuted ? <IconBellOff size={17} /> : <IconBell size={17} />}
              </button>
              <button
                type="button"
                className={`icon-btn ${isDirectSelectionActive ? 'is-active' : ''}`}
                onClick={() => (isDirectSelectionActive ? cancelMessageSelection() : startMessageSelection('direct'))}
                title={isDirectSelectionActive ? 'Cancel selection' : 'Select messages to forward'}
                aria-label={isDirectSelectionActive ? 'Cancel selection' : 'Select messages to forward'}
                aria-pressed={isDirectSelectionActive}
              >
                <IconSelect size={17} />
              </button>
            </div>
          </header>

          <PinnedMessagesBar
            pinned={directPinned}
            threadKey={`direct-${selectedDirectUserId}`}
            onJump={(message) => jumpToMessage('direct', message)}
            onUnpin={(message) => handleTogglePin('direct', message)}
          />

          {isDirectSelectionActive && renderSelectionBar(selectedDirectMessageIds.length)}

          <ChatThread
            currentUserId={currentUserId}
            dropLabel={`Files will be added to your message to ${firstName(selectedDirectUser.name)}`}
            emptyState={directThreadLoading
              ? <ThreadLoadingState />
              : <ChatEmptyState icon={IconChat} title="No messages yet" text={`Say hello to ${firstName(selectedDirectUser.name)}.`} />}
            items={directMessageItems}
            onDropFiles={isEditingDirectMessage ? undefined : handleDirectAttachmentSelect}
            onScrollRequestMissed={handleScrollRequestMissed}
            rowHeight={directRowHeight}
            rowProps={threadRowProps('direct')}
            scrollRequest={scrollRequest?.mode === 'direct' ? scrollRequest : null}
            threadKey={`direct-${selectedDirectUserId}`}
            typingLabel={selectedDirectTypingLabel}
          />

          <ChatComposer
            attachments={directPendingAttachments}
            canSend={isEditingDirectMessage
              ? !editingMessage.saving && !!editingMessage.text.trim()
              : !sendingDirectMessage && !uploadingDirectAttachment && (!!directNewMessage.trim() || directPendingAttachments.length > 0)}
            editing={isEditingDirectMessage ? editingMessage : null}
            focusKey={`direct-${selectedDirectUserId}`}
            getAttachmentLabel={getAttachmentLabel}
            onCancelEdit={cancelEditMessage}
            onCancelReply={cancelReplyToMessage}
            onCancelUpload={cancelDirectAttachmentUpload}
            onChange={handleDirectComposerChange}
            onPasteFiles={handleDirectAttachmentSelect}
            onPickFiles={() => openAttachmentPicker('files', handleDirectAttachmentSelect)}
            onPickFolder={() => openAttachmentPicker('folder', handleDirectAttachmentSelect)}
            onRemoveAttachment={removeDirectPendingAttachment}
            onSubmit={isEditingDirectMessage ? submitEditMessage : sendDirectMessage}
            placeholder={isEditingDirectMessage ? 'Edit your message' : `Message ${firstName(selectedDirectUser.name)}`}
            replyingTo={buildReplyContext('direct')}
            sending={sendingDirectMessage}
            uploadState={directAttachmentUploadState}
            uploading={uploadingDirectAttachment}
            value={isEditingDirectMessage ? editingMessage.text : directNewMessage}
          />
        </>
      )}
    </section>
  );

  const content = (
    <div className={`group-message-root group-message-root--${variant}`}>
      {variant !== 'overlay' && (
        <div className="chat-embedded-header">
          <span className="chat-title-icon"><IconChat size={16} /></span>
          <h3>Messages</h3>
          {syncStatus}
        </div>
      )}

      <div className={`chat-shell ${isActiveListVisible ? '' : 'is-list-hidden'}`}>
        {isActiveListVisible && sidebar}
        {activeTab === 'groups' ? groupWindow : directWindow}
      </div>

      {feedback && (
        <div className={`chat-toast ${isErrorFeedback ? 'is-error' : ''}`} role={isErrorFeedback ? 'alert' : 'status'}>
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback('')} aria-label="Dismiss">
            <IconClose size={13} />
          </button>
        </div>
      )}

      {receiptDetailsMessage && (
        <MessageReceiptDetailsModal
          deliveredItems={receiptDetailsData.deliveredItems}
          message={receiptDetailsMessage}
          onClose={closeReceiptDetails}
          pendingItems={receiptDetailsData.pendingItems}
          readItems={receiptDetailsData.readItems}
        />
      )}
      {deleteConfirmation.open && (
        <div className="chat-modal-overlay" onClick={closeDeleteConfirmation}>
          <div
            className="chat-modal message-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="message-delete-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
                <path
                  d="M4.5 7h15M9.5 7V5h5v2m-8 0 .8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10.5 11v5m3-5v5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="message-delete-copy">
              <h4 id="message-delete-title">Delete this message?</h4>
              <p>
                It will be removed for everyone in {deleteThreadLabel}, along with its attachments and reactions.
                A “message deleted” placeholder stays in the chat.
              </p>
            </div>
            <div className="message-delete-preview">
              <span>{deleteMessagePreview}</span>
            </div>
            <div className="chat-modal-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={closeDeleteConfirmation}
                disabled={deleteConfirmation.deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={confirmDeleteMessage}
                disabled={deleteConfirmation.deleting}
              >
                {deleteConfirmation.deleting ? 'Deleting…' : 'Delete for everyone'}
              </button>
            </div>
          </div>
        </div>
      )}
      {forwardState.open && (
        <div className="chat-modal-overlay" onClick={closeForwardModal}>
          <div className="chat-modal message-forward-modal" role="dialog" aria-modal="true" aria-labelledby="message-forward-title" onClick={(event) => event.stopPropagation()}>
            <div className="chat-modal-header">
              <div>
                <h4 id="message-forward-title">Forward messages</h4>
                <p>
                  {selectedForwardCount} {selectedForwardCount === 1 ? 'message' : 'messages'} from{' '}
                  {selectionMode === 'group' ? selectedGroup?.name || 'group chat' : selectedDirectUser?.name || 'direct chat'}
                </p>
              </div>
              <button type="button" className="icon-btn" onClick={closeForwardModal} aria-label="Close forward dialog">
                <IconClose size={16} />
              </button>
            </div>

            <div className="message-forward-body">
              <div className="message-forward-summary">
                {selectedForwardMessages.map((message) => (
                  <div key={message.id} className="message-forward-summary-item">
                    <strong>{message.senderName || 'Unknown'}</strong>
                    <span>{message.message || 'Attachment'}</span>
                    <small>{formatForwardTimestamp(message.createdAt)}</small>
                  </div>
                ))}
              </div>

              <label className="message-forward-note">
                <span>Add a note (optional)</span>
                <textarea
                  className="chat-field"
                  value={forwardState.note}
                  onChange={(event) => setForwardState((prev) => ({ ...prev, note: event.target.value }))}
                  placeholder="Add context for the people you're forwarding to"
                  rows={2}
                />
              </label>

              <div className="message-forward-target-columns">
                <div className="message-forward-target-card">
                  <div className="message-forward-target-title">Groups</div>
                  <div className="message-forward-target-list">
                    {forwardableGroups.length === 0 && <div className="chat-muted-note">No other groups available.</div>}
                    {forwardableGroups.map((group) => (
                      <label key={group.id} className={`chat-person-option ${forwardState.groupIds.includes(group.id) ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={forwardState.groupIds.includes(group.id)}
                          onChange={() => toggleForwardGroupTarget(group.id)}
                        />
                        <span className="person-avatar person-avatar--xs person-avatar--group" style={{ '--avatar-hue': `${buildAvatarHue(group.name)}deg` }} aria-hidden="true">
                          {buildInitials(group.name)}
                        </span>
                        <span className="chat-person-copy">
                          <strong>{group.name}</strong>
                          <small>{group.memberCount} members</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="message-forward-target-card">
                  <div className="message-forward-target-title">People</div>
                  <div className="message-forward-target-list">
                    {forwardableUsers.length === 0 && <div className="chat-muted-note">No people available.</div>}
                    {forwardableUsers.map((groupUser) =>
                      renderPersonOption(groupUser, forwardState.userIds.includes(groupUser.id), () => toggleForwardUserTarget(groupUser.id))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="chat-modal-actions">
              <button type="button" className="btn btn--ghost" onClick={closeForwardModal}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={submitForwardMessages}
                disabled={forwardState.sending || (forwardState.groupIds.length + forwardState.userIds.length === 0)}
              >
                <IconForward size={15} />
                {forwardState.sending
                  ? 'Forwarding…'
                  : `Forward${forwardState.groupIds.length + forwardState.userIds.length > 0 ? ` to ${forwardState.groupIds.length + forwardState.userIds.length}` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const handleToggleMinimize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    if (panelRef.current) {
      panelFlipRectRef.current = panelRef.current.getBoundingClientRect();
    }
    setIsMaximized((prev) => !prev);
  };

  if (variant === 'overlay') {
    if (!isOpen) return null;
    const totalUnreadThreads = groupUnreadThreadCount + directUnreadThreadCount;
    return (
      <div
        className={`group-message-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      >
        <div
          className={`group-message-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
          ref={panelRef}
          style={minimizedWindowStyle || undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="group-message-modal-header"
            onClick={isMinimized ? () => { onActivate?.(); setIsMinimized(false); } : undefined}
          >
            <div className="chat-window-title">
              <span className="chat-title-icon"><IconChat size={16} /></span>
              <span className="chat-window-title-text">Messages</span>
              {isMinimized && totalUnreadThreads > 0 && <span className="chat-badge">{formatUnreadCount(totalUnreadThreads)}</span>}
              {!isMinimized && syncStatus}
            </div>
            <WindowControls
              isMinimized={isMinimized}
              isMaximized={isMaximized}
              onMinimize={handleToggleMinimize}
              onMaximize={handleToggleMaximize}
              onClose={onClose}
            />
          </div>
          {!isMinimized && <div className="group-message-panel-body">{content}</div>}
        </div>
      </div>
    );
  }

  return content;
};

export default GroupMessagePanel;
