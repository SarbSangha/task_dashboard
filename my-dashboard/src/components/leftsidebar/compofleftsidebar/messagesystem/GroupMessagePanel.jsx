import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import './GroupMessagePanel.css';
import { directMessageAPI, fileAPI, groupAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
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
import { GROUP_MESSAGES_KEY, useSendGroupMessage } from '../../../../hooks/useMessages';
import ChatAttachmentGallery from '../../../common/chat/ChatAttachmentGallery';
import {
  formatMonthDayTimeIndia,
  formatRelativeDayIndia,
  formatTimeIndiaShort,
} from '../../../../utils/dateTime';

const GROUP_PANEL_CACHE_TTL_MS = 2 * 60 * 1000;
const GROUP_MESSAGES_CACHE_TTL_MS = 90 * 1000;
const createInitialForwardState = () => ({
  open: false,
  groupIds: [],
  userIds: [],
  note: '',
  sending: false,
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

const formatUploadSize = (bytes = 0) => {
  const safeBytes = Number.isFinite(bytes) ? Math.max(bytes, 0) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
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

const createInitialComposerDraft = () => ({
  text: '',
  attachments: [],
  uploading: false,
  uploadState: createInitialAttachmentUploadState(),
});

function AttachmentUploadStatus({ uploadState }) {
  if (!uploadState?.active) return null;

  const uploadLabel = uploadState.fileCount === 1 ? 'file' : 'items';
  const currentFileLine = [
    uploadState.currentFileIndex > 0
      ? `File ${uploadState.currentFileIndex} of ${uploadState.fileCount}`
      : '',
    `${formatUploadSize(uploadState.currentFileUploadedBytes)} of ${formatUploadSize(uploadState.currentFileTotalBytes)}`,
    uploadState.currentFileTotalBytes ? `${uploadState.currentFilePercent}%` : '',
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div className="group-chat-upload-status" role="status" aria-live="polite">
      <div className="group-chat-upload-status-header">
        <div className="group-chat-upload-status-copy">
          <strong>Uploading {uploadState.fileCount} {uploadLabel}</strong>
          <span>
            {formatUploadSize(uploadState.uploadedBytes)} of {formatUploadSize(uploadState.totalBytes)} uploaded
          </span>
        </div>
        <div className="group-chat-upload-status-percent">{uploadState.percent}%</div>
      </div>
      <div className="group-chat-upload-status-bar" aria-hidden="true">
        <span style={{ width: `${uploadState.percent}%` }} />
      </div>
      <div className="group-chat-upload-status-file">
        <span>{uploadState.currentFileName || 'Preparing upload...'}</span>
        <small>{currentFileLine}</small>
      </div>
    </div>
  );
}

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

const buildAttachmentCountLabel = (attachments = []) => {
  const count = Array.isArray(attachments) ? attachments.filter(Boolean).length : 0;
  if (!count) return '';
  return `${count} attachment${count === 1 ? '' : 's'}`;
};

const buildConversationPreview = (message, attachments = []) =>
  `${message || ''}`.trim() || buildAttachmentCountLabel(attachments);

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

const scrollThreadEndIntoView = (threadEndRef) => {
  let firstFrameId = 0;
  let secondFrameId = 0;
  let timeoutId = 0;

  firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ block: 'end' });
      timeoutId = window.setTimeout(() => {
        threadEndRef.current?.scrollIntoView({ block: 'end' });
      }, 120);
    });
  });

  return () => {
    if (firstFrameId) window.cancelAnimationFrame(firstFrameId);
    if (secondFrameId) window.cancelAnimationFrame(secondFrameId);
    if (timeoutId) window.clearTimeout(timeoutId);
  };
};

const GroupMessagePanel = ({ isOpen = true, onClose, variant = 'embedded', onMinimizedChange, onActivate }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const isActive = variant === 'embedded' || isOpen;
  const isActiveRef = useRef(isActive);
  const [activeTab, setActiveTab] = useState('groups');
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
  const messageThreadRef = useRef(null);
  const messageThreadEndRef = useRef(null);
  const directThreadRef = useRef(null);
  const directThreadEndRef = useRef(null);
  const selectedGroupIdRef = useRef(null);
  const groupMenuRef = useRef(null);
  const [directUsers, setDirectUsers] = useState([]);
  const [directConversations, setDirectConversations] = useState([]);
  const [selectedDirectUserId, setSelectedDirectUserId] = useState(null);
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
  const [directPendingAttachments, setDirectPendingAttachments] = useState([]);
  const [directComposerDrafts, setDirectComposerDrafts] = useState({});
  const selectedDirectUserIdRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const currentUserIdRef = useRef(currentUserId);
  const directUsersRef = useRef(directUsers);
  const directConversationsRef = useRef(directConversations);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const realtimeRefreshTimersRef = useRef({
    groupIndex: null,
    groupMessages: null,
    directIndex: null,
    directMessages: null,
  });
  const syncGroupsPromiseRef = useRef(null);
  const syncDirectDataPromiseRef = useRef(null);
  const groupMessagesRequestRef = useRef({ groupId: null, promise: null });
  const directMessagesRequestRef = useRef({ userId: null, promise: null });
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

  useEffect(() => {
    if (variant !== 'overlay') return;
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange, variant]);

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
  const selectedGroupPreviewNames = (selectedGroup?.members || [])
    .slice(0, 3)
    .map((member) => member.name)
    .join(', ');
  const selectedDirectUser = useMemo(
    () =>
      directUsers.find((directUser) => directUser.id === selectedDirectUserId) ||
      directConversations.find((conversation) => conversation.user?.id === selectedDirectUserId)?.user ||
      null,
    [directConversations, directUsers, selectedDirectUserId]
  );
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
  const isDirectTabActive = activeTab === 'direct';
  const routeTab = `${searchParams.get('tab') || ''}`.trim().toLowerCase();
  const routeGroupId = Number(searchParams.get('groupId') || 0);
  const routeDirectUserId = Number(searchParams.get('userId') || 0);
  const selectedForwardMessages = useMemo(() => {
    if (selectionMode === 'group') {
      const selectedIds = new Set(selectedGroupMessageIds);
      return messages.filter((message) => selectedIds.has(message.id));
    }

    if (selectionMode === 'direct') {
      const selectedIds = new Set(selectedDirectMessageIds);
      return directMessages.filter((message) => selectedIds.has(message.id));
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

  const buildDayLabel = (value) => {
    return formatRelativeDayIndia(value);
  };

  const formatMessageTime = (value) => {
    const formatted = formatTimeIndiaShort(value);
    return formatted === 'N/A' ? '' : formatted;
  };

  const buildInitials = (value) =>
    (value || '')
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'G';

  const buildAvatarHue = (value) =>
    Array.from(value || 'group').reduce((total, char) => total + char.charCodeAt(0), 0) % 360;

  const getAttachmentLabel = (attachment) => getAttachmentDisplayName(attachment);
  const formatForwardTimestamp = (value) => {
    const formatted = formatMonthDayTimeIndia(value);
    return formatted === 'N/A' ? 'Unknown time' : formatted;
  };

  const messageItems = useMemo(() => {
    const items = [];
    let lastLabel = null;

    messages.forEach((message) => {
      const label = buildDayLabel(message.createdAt);
      if (label !== lastLabel) {
        items.push({ type: 'separator', id: `separator-${label}-${message.id}`, label });
        lastLabel = label;
      }
      items.push({ type: 'message', id: `message-${message.id}`, message });
    });

    return items;
  }, [messages]);
  const directMessageItems = useMemo(() => {
    const items = [];
    let lastLabel = null;

    directMessages.forEach((message) => {
      const label = buildDayLabel(message.createdAt);
      if (label !== lastLabel) {
        items.push({ type: 'separator', id: `direct-separator-${label}-${message.id}`, label });
        lastLabel = label;
      }
      items.push({ type: 'message', id: `direct-message-${message.id}`, message });
    });

    return items;
  }, [directMessages]);

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
    });
    queryClient.setQueryData(GROUP_MESSAGES_KEY(selectedGroupId), messages);
  }, [cacheKeys, isActive, messages, queryClient, selectedGroupId]);

  useEffect(() => {
    if (!isActive) return;
    if (routeTab === 'direct' && activeTab !== 'direct') {
      setActiveTab('direct');
      return;
    }
    if (routeTab === 'groups' && activeTab !== 'groups') {
      setActiveTab('groups');
    }
  }, [activeTab, isActive, routeTab]);

  useEffect(() => {
    if (!isActive) return;

    if (routeTab === 'groups' && routeGroupId > 0) {
      const matchingGroup = groups.find((group) => Number(group.id) === routeGroupId);
      if (matchingGroup && selectedGroupId !== matchingGroup.id) {
        setSelectedGroupId(matchingGroup.id);
      }
      return;
    }

    if (routeTab === 'direct' && routeDirectUserId > 0) {
      const matchingDirectUser =
        directUsers.find((directUser) => Number(directUser.id) === routeDirectUserId)
        || directConversations.find((conversation) => Number(conversation.user?.id) === routeDirectUserId)?.user;

      if (matchingDirectUser && selectedDirectUserId !== matchingDirectUser.id) {
        setSelectedDirectUserId(matchingDirectUser.id);
      }
    }
  }, [
    directConversations,
    directUsers,
    groups,
    isActive,
    routeDirectUserId,
    routeGroupId,
    routeTab,
    selectedDirectUserId,
    selectedGroupId,
  ]);

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
      setMessages((prev) => replaceMessageById(prev, tempId, message));
      setMessageCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    },
    onRollbackMessage: ({ context }) => {
      if (!context?.tempId) return;
      setMessages((prev) => removeMessageById(prev, context.tempId));
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
        setMessages(response?.data || []);
        setMessageCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
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
        setDirectMessages(response?.data || []);
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

  useEffect(() => {
    if (!isActive || !cacheKeys) return;

    const cachedGroupsEntry = getTaskPanelCacheEntry(cacheKeys.groupIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedGroups = cachedGroupsEntry?.value || null;

    if (cachedGroups) {
      setAllUsers(cachedGroups.allUsers || []);
      setCurrentUserId(cachedGroups.currentUserId || null);
      setGroups(cachedGroups.groups || []);
      setSelectedGroupId(cachedGroups.selectedGroupId || null);
      setLoading(false);
      setGroupsCacheStatus({
        showingCached: true,
        cachedAt: cachedGroupsEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      if (cachedGroups.selectedGroupId) {
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
          syncGroups({ keepSelected: false, silent: !!cachedGroups }),
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
  }, [cacheKeys, isActive, user]);

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

    if (cachedMessages?.messages) {
      setMessages(cachedMessages.messages);
      setMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    loadMessages(selectedGroupId, { silent: !!cachedMessages }).catch((error) => {
      console.error('Failed to load messages:', error);
      if (!cachedMessages) {
        setMessages([]);
      }
      setIsMessagesRefreshing(false);
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
      setIsMaximized(false);
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

        if (payload.eventType === 'group_message') {
          const groupId = Number(payload?.metadata?.groupId);
          if (!groupId) return;

          scheduleGroupIndexRefresh();

          if (selectedGroupIdRef.current === groupId) {
            const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
            const incomingMessage = {
              id: payload?.metadata?.messageId,
              senderId: payload?.metadata?.senderId || null,
              senderName: payload?.metadata?.senderName || 'Unknown',
              message: payload?.metadata?.messageText ?? payload?.message ?? '',
              attachments,
              createdAt: payload?.metadata?.createdAt || new Date().toISOString(),
            };

            setMessages((prev) => appendMessageById(prev, incomingMessage));
            setMessageCacheStatus((prev) => ({
              showingCached: false,
              cachedAt: prev.cachedAt,
              liveUpdatedAt: Date.now(),
            }));
            scheduleGroupMessagesRefresh(groupId, 120);
          }

          return;
        }

        if (payload.eventType === 'direct_message') {
          const senderId = Number(payload?.metadata?.senderId);
          if (!senderId) return;
          const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
          const incomingMessage = {
            id: payload?.metadata?.messageId,
            senderId,
            senderName: payload?.metadata?.senderName || 'Unknown',
            recipientId: currentUserIdRef.current || user?.id || null,
            message: payload?.metadata?.messageText ?? payload?.message ?? '',
            attachments,
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

          if (hasBootstrappedDirectRef.current || activeTabRef.current === 'direct') {
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
          }
          if (selectedDirectUserIdRef.current === senderId) {
            setDirectMessages((prev) => appendMessageById(prev, incomingMessage));
            setDirectMessageCacheStatus((prev) => ({
              showingCached: false,
              cachedAt: prev.cachedAt,
              liveUpdatedAt: Date.now(),
            }));
            scheduleDirectMessagesRefresh(senderId, 120);
          }
        }
      },
      onOpen: () => {
        scheduleGroupIndexRefresh(120);
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
    if (!isActive || !selectedGroupId) return undefined;

    return scrollThreadEndIntoView(messageThreadEndRef);
  }, [isActive, selectedGroupId, messageItems.length]);

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
    });
  }, [cacheKeys, directMessages, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !isDirectTabActive) return;

    const cachedDirectEntry = getTaskPanelCacheEntry(cacheKeys.directIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedDirectData = cachedDirectEntry?.value || null;
    if (cachedDirectData) {
      setDirectUsers(cachedDirectData.directUsers || []);
      setDirectConversations(cachedDirectData.directConversations || []);
      setSelectedDirectUserId(cachedDirectData.selectedDirectUserId || null);
      setDirectLoading(false);
      setDirectCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      if (cachedDirectData.selectedDirectUserId) {
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
        await syncDirectData({ keepSelected: false, silent: !!cachedDirectData });
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
    if (cachedDirectMessages?.messages) {
      setDirectMessages(cachedDirectMessages.messages);
      setDirectMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    loadDirectMessages(selectedDirectUserId, { silent: !!cachedDirectMessages }).catch((error) => {
      console.error('Failed to load direct messages:', error);
      if (!cachedDirectMessages) {
        setDirectMessages([]);
      }
      setDirectMessagesRefreshing(false);
    });
  }, [cacheKeys, isActive, isDirectTabActive, selectedDirectUserId]);

  useEffect(() => {
    setSelectionMode(null);
    setSelectedGroupMessageIds([]);
    setSelectedDirectMessageIds([]);
    setForwardState(createInitialForwardState());
  }, [activeTab, selectedDirectUserId, selectedGroupId]);

  useEffect(() => {
    if (!isActive || !selectedDirectUserId) return undefined;

    return scrollThreadEndIntoView(directThreadEndRef);
  }, [directMessageItems.length, isActive, selectedDirectUserId]);

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
    const draftAttachments = pendingAttachments;
    setSendingMessage(true);
    setNewMessage('');
    setPendingAttachments([]);
    updateGroupComposerDraft(selectedGroupId, createInitialComposerDraft());

    try {
      await sendGroupMessage({
        message: draftMessage,
        attachments: draftAttachments,
      });
      setFeedback('');
    } catch (error) {
      setNewMessage(draftMessage);
      setPendingAttachments(draftAttachments);
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
      setFeedback(error?.response?.data?.detail || 'Failed to upload attachment.');
    } finally {
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
      setFeedback(error?.response?.data?.detail || 'Failed to upload attachment.');
    } finally {
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
    setSendingDirectMessage(true);

    try {
      const response = await directMessageAPI.sendMessage(selectedDirectUserId, {
        message: trimmedMessage,
        attachments: directPendingAttachments,
      });
      const sent = response?.data;
      setDirectMessages((prev) => (sent ? [...prev, sent] : prev));
      if (sent && selectedDirectUser) {
        setDirectConversations((prev) => upsertDirectConversation(prev, {
          user: selectedDirectUser,
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
      setDirectNewMessage('');
      setDirectPendingAttachments([]);
      updateDirectComposerDraft(selectedDirectUserId, createInitialComposerDraft());
      await syncDirectData({ silent: true });
    } catch (error) {
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
      await Promise.all([
        ...forwardState.groupIds.map((groupId) => groupAPI.sendMessage(groupId, payload)),
        ...forwardState.userIds.map((userId) => directMessageAPI.sendMessage(userId, payload)),
      ]);
      setFeedback(
        `Forwarded ${selectedForwardMessages.length} ${selectedForwardMessages.length === 1 ? 'message' : 'messages'} to ${targetCount} ${targetCount === 1 ? 'destination' : 'destinations'}.`
      );
      resetMessageForwarding();
      syncGroups({ silent: true }).catch(() => {});
      syncDirectData({ silent: true }).catch(() => {});
    } catch (error) {
      setForwardState((prev) => ({ ...prev, sending: false }));
      setFeedback(error?.response?.data?.detail || 'Failed to forward selected messages.');
    }
  };

  const isGroupSelectionActive = selectionMode === 'group';
  const isDirectSelectionActive = selectionMode === 'direct';
  const showEmptyGroupsState = !loading && !isRefreshing && hasResolvedGroupIndex && groups.length === 0;
  const showEmptyDirectState = !directLoading && !directRefreshing && hasResolvedDirectIndex && directListItems.length === 0;

  const content = (
    <div className={`group-message-root group-message-root--${variant}`}>
      <div className="message-system-tabs">
        <button
          type="button"
          className={activeTab === 'groups' ? 'active' : ''}
          onClick={() => setActiveTab('groups')}
        >
          Group Chat
        </button>
        <button
          type="button"
          className={activeTab === 'direct' ? 'active' : ''}
          onClick={() => setActiveTab('direct')}
        >
          Individual Chat
        </button>
      </div>
      <div className="content-header">
        <h3>{activeTab === 'groups' ? 'Groups' : 'Individual Chat'}</h3>
        <button
          className="add-btn"
          onClick={() =>
            (activeTab === 'groups' ? syncGroups({ silent: true }) : syncDirectData({ silent: true })).catch(() => {})
          }
        >
          Refresh
        </button>
      </div>

      {feedback && <div className="group-message-feedback">{feedback}</div>}
      <CacheStatusBanner
        showingCached={activeTab === 'groups' ? groupsCacheStatus.showingCached : directCacheStatus.showingCached}
        isRefreshing={activeTab === 'groups' ? isRefreshing : directRefreshing}
        cachedAt={activeTab === 'groups' ? groupsCacheStatus.cachedAt : directCacheStatus.cachedAt}
        liveUpdatedAt={activeTab === 'groups' ? groupsCacheStatus.liveUpdatedAt : directCacheStatus.liveUpdatedAt}
        refreshingLabel={activeTab === 'groups' ? 'Refreshing latest groups...' : 'Refreshing latest direct chats...'}
        liveLabel={activeTab === 'groups' ? 'Groups list is up to date' : 'Direct chats are up to date'}
        cachedLabel={activeTab === 'groups' ? 'Showing cached groups' : 'Showing cached direct chats'}
      />

      {activeTab === 'groups' && (
      <div className="groups-shell">
        <div className="groups-sidebar">
          <div className="groups-create-card">
            <div className="groups-create-title">Create Group</div>
            <input
              className="groups-input"
              type="text"
              placeholder="Group name..."
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
            <div className="groups-user-picker">
              {loading && <div>Loading employees...</div>}
              {!loading &&
                allUsers.map((groupUser) => (
                  <label key={groupUser.id} className="groups-user-option">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(groupUser.id)}
                      onChange={() => toggleSelected(groupUser.id)}
                    />
                    <span>
                      {groupUser.name} ({groupUser.department || 'N/A'})
                    </span>
                  </label>
                ))}
            </div>
            <button className="add-btn" onClick={createGroup} disabled={!groupName.trim() || selectedIds.length === 0}>
              + Create Group
            </button>
          </div>

          <div className="groups-list">
            {showEmptyGroupsState && <div className="group-message-info-card">No groups created yet.</div>}
            {groups.map((group) => (
              <button
                type="button"
                className={`group-thread-card ${selectedGroupId === group.id ? 'active' : ''}`}
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <div
                  className="group-thread-avatar"
                  style={{ '--group-avatar-hue': `${buildAvatarHue(group.name)}deg` }}
                >
                  {buildInitials(group.name)}
                </div>
                <div className="group-thread-copy">
                  <div className="group-thread-topline">
                    <div className="group-thread-name">{group.name}</div>
                    <div className="group-thread-meta">{group.memberCount} members</div>
                  </div>
                  <div className="group-thread-subline">
                    <span>Your role: {group.myRole}</span>
                    <span>{group.members?.slice(0, 2).map((member) => member.name).join(', ')}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="groups-chat-window">
          {!selectedGroup && (
            <div className="group-chat-empty">
              <div className="group-chat-empty-icon">#</div>
              <h4>Select a group to start chatting</h4>
              <p>Your group conversations will appear here in a WhatsApp-style layout.</p>
            </div>
          )}

          {selectedGroup && (
            <>
              <div className="group-chat-header">
                <div className="group-chat-summary">
                  <div
                    className="group-chat-header-avatar"
                    style={{ '--group-avatar-hue': `${buildAvatarHue(selectedGroup.name)}deg` }}
                  >
                    {buildInitials(selectedGroup.name)}
                  </div>
                  <div>
                    <div className="group-chat-title">{selectedGroup.name}</div>
                    <div className="group-chat-subtitle">
                      {selectedGroup.memberCount} members
                      {selectedGroupPreviewNames ? `, ${selectedGroupPreviewNames}` : ''}
                    </div>
                  </div>
                </div>
                <div className="group-chat-actions">
                  <span className="group-chat-badge">{selectedGroup.myRole}</span>
                  <button
                    type="button"
                    className={`group-chat-selection-toggle ${isGroupSelectionActive ? 'active' : ''}`}
                    onClick={() => (isGroupSelectionActive ? cancelMessageSelection() : startMessageSelection('group'))}
                  >
                    {isGroupSelectionActive ? 'Cancel Select' : 'Select Messages'}
                  </button>
                  <div className="group-chat-menu-wrap" ref={groupMenuRef}>
                    <button
                      type="button"
                      className="group-chat-menu-trigger"
                      onClick={() => setShowGroupMenu((prev) => !prev)}
                    >
                      ...
                    </button>

                    {showGroupMenu && (
                      <div className="group-chat-menu">
                        {isSelectedGroupAdmin && (
                          <button
                            type="button"
                            className="group-chat-menu-action"
                            onClick={() => setShowAddMemberPanel((prev) => !prev)}
                          >
                            {showAddMemberPanel ? 'Close Add Members' : '+ Add Members'}
                          </button>
                        )}

                        {showAddMemberPanel && isSelectedGroupAdmin && (
                          <div className="group-add-members-panel group-add-members-panel-menu">
                            <div className="group-chat-menu-title">Add Members</div>
                            <div className="group-add-members-list">
                              {allUsers
                                .filter((groupUser) => !selectedGroup.members.some((member) => member.id === groupUser.id))
                                .map((groupUser) => (
                                  <label key={groupUser.id} className="groups-user-option">
                                    <input
                                      type="checkbox"
                                      checked={addMemberSelection.includes(groupUser.id)}
                                      onChange={() =>
                                        setAddMemberSelection((prev) =>
                                          prev.includes(groupUser.id)
                                            ? prev.filter((value) => value !== groupUser.id)
                                            : [...prev, groupUser.id]
                                        )
                                      }
                                    />
                                    <span>
                                      {groupUser.name} ({groupUser.department || 'N/A'})
                                    </span>
                                  </label>
                                ))}
                            </div>
                            <button className="add-btn" style={{ marginTop: '8px' }} onClick={() => saveAddMembers(selectedGroup.id)}>
                              Save Members
                            </button>
                          </div>
                        )}

                        <div className="group-chat-menu-section">
                          <div className="group-chat-menu-title">Members</div>
                          <div className="group-chat-menu-members">
                            {selectedGroup.members.map((member) => (
                              <div key={member.id} className="group-member-row group-member-row-menu">
                                <div className="group-member-main">
                                  <div
                                    className="group-member-avatar"
                                    style={{ '--group-avatar-hue': `${buildAvatarHue(member.name)}deg` }}
                                  >
                                    {buildInitials(member.name)}
                                  </div>
                                  <div>
                                    <div className="group-member-name">{member.name}</div>
                                    <div className="group-member-role-line">{member.role}</div>
                                  </div>
                                </div>
                                <div className="group-member-actions">
                                  {isSelectedGroupAdmin && member.id !== currentUserId && selectedGroup.createdBy !== member.id && (
                                    <>
                                      <button
                                        className="add-btn"
                                        onClick={() => updateMemberRole(member.id, member.role === 'admin' ? 'member' : 'admin')}
                                      >
                                        {member.role === 'admin' ? 'Demote' : 'Make Admin'}
                                      </button>
                                      <button className="add-btn" onClick={() => removeMember(member.id)}>
                                        Remove
                                      </button>
                                    </>
                                  )}
                                  {member.id === currentUserId && selectedGroup.createdBy !== currentUserId && (
                                    <button className="add-btn" onClick={() => removeMember(member.id)}>
                                      Leave
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {isGroupSelectionActive && (
                <div className="group-chat-selection-bar">
                  <div className="group-chat-selection-copy">
                    <strong>{selectedGroupMessageIds.length}</strong>
                    <span>{selectedGroupMessageIds.length === 1 ? 'message selected' : 'messages selected'}</span>
                  </div>
                  <div className="group-chat-selection-actions">
                    <button
                      type="button"
                      className="group-chat-selection-btn"
                      onClick={openForwardModal}
                      disabled={selectedGroupMessageIds.length === 0}
                    >
                      Forward Selected
                    </button>
                    <button
                      type="button"
                      className="group-chat-selection-btn secondary"
                      onClick={cancelMessageSelection}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              <div className="group-chat-body">
                <div className="group-chat-thread" ref={messageThreadRef}>
                  <CacheStatusBanner
                    showingCached={messageCacheStatus.showingCached}
                    isRefreshing={isMessagesRefreshing}
                    cachedAt={messageCacheStatus.cachedAt}
                    liveUpdatedAt={messageCacheStatus.liveUpdatedAt}
                    refreshingLabel="Refreshing latest conversation..."
                    liveLabel="Conversation is up to date"
                    cachedLabel="Showing cached conversation"
                  />
                  {messages.length === 0 && <div className="group-chat-empty-thread">No messages yet. Say hello to the group.</div>}
                  {messageItems.map((item) => {
                    if (item.type === 'separator') {
                      return (
                        <div key={item.id} className="group-chat-day-separator">
                          <span>{item.label}</span>
                        </div>
                      );
                    }

                    const message = item.message;
                    const mine = message.senderId === currentUserId;
                    const isSelected = selectedGroupMessageIds.includes(message.id);

                    return (
                      <div
                        key={item.id}
                        className={`group-chat-row ${mine ? 'mine' : 'theirs'} ${isGroupSelectionActive ? 'selecting' : ''} ${isSelected ? 'selected' : ''}`}
                        onClick={isGroupSelectionActive ? () => toggleMessageSelection('group', message.id) : undefined}
                      >
                        {isGroupSelectionActive && (
                          <button
                            type="button"
                            className={`group-message-select-toggle ${isSelected ? 'selected' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleMessageSelection('group', message.id);
                            }}
                            aria-label={isSelected ? 'Deselect message' : 'Select message'}
                          >
                            {isSelected ? '✓' : ''}
                          </button>
                        )}
                        {!mine && (
                          <div
                            className="group-message-avatar"
                            style={{ '--group-avatar-hue': `${buildAvatarHue(message.senderName)}deg` }}
                          >
                            {buildInitials(message.senderName)}
                          </div>
                        )}
                        <div className={`group-message-bubble ${mine ? 'mine' : 'theirs'} ${message.isOptimistic ? 'optimistic' : ''}`}>
                          {!mine && <div className="group-message-sender">{message.senderName}</div>}
                          {message.message && <div className="group-message-text">{message.message}</div>}
                          {!!message.attachments?.length && (
                            <div className="group-message-attachments">
                              <ChatAttachmentGallery attachments={message.attachments} />
                            </div>
                          )}
                          <div className="group-message-meta">
                            <span>{formatMessageTime(message.createdAt)}</span>
                            {message.isOptimistic && <span className="group-message-status">Sending...</span>}
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  <div ref={messageThreadEndRef} className="group-chat-thread-end" aria-hidden="true" />
                </div>
              </div>

              <div className="group-chat-composer">
                <AttachmentUploadStatus uploadState={attachmentUploadState} />
                {!!pendingAttachments.length && (
                  <div className="group-chat-attachment-strip">
                    {pendingAttachments.map((attachment, index) => (
                      <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="group-chat-attachment-pill">
                        <span>{getAttachmentLabel(attachment)}</span>
                        <button
                          type="button"
                          onClick={() =>
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
                            })
                          }
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="group-chat-composer-shell">
                  <button
                    type="button"
                    className="group-chat-tool-btn"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAttachmentPicker('files');
                    }}
                    title="Attach files"
                    disabled={uploadingAttachment}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="group-chat-tool-btn"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAttachmentPicker('folder');
                    }}
                    title="Attach folder"
                    disabled={uploadingAttachment}
                  >
                    <svg
                      className="group-chat-tool-icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.12a2.25 2.25 0 0 1 1.59.66l1.35 1.34H18A2.25 2.25 0 0 1 20.25 8.75v7.5A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25v-9.5Z"
                        fill="currentColor"
                        opacity="0.22"
                      />
                      <path
                        d="M3.75 8.5A2 2 0 0 1 5.75 6.5h5.38l1.32 1.3c.23.24.55.37.88.37h5.42a1.5 1.5 0 0 1 1.45 1.89l-1.16 4.32a2 2 0 0 1-1.93 1.48H5.95a2 2 0 0 1-1.98-1.74L3.75 8.5Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <input
                    className="groups-input group-chat-input"
                    type="text"
                    placeholder="Type a message"
                    value={newMessage}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setNewMessage(nextValue);
                      if (selectedGroupIdRef.current) {
                        updateGroupComposerDraft(selectedGroupIdRef.current, {
                          text: nextValue,
                          attachments: pendingAttachments,
                          uploading: uploadingAttachment,
                          uploadState: attachmentUploadState,
                        });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        sendMessage();
                      }
                    }}
                  />
                  <button
                    className="group-chat-send-btn"
                    onClick={sendMessage}
                    disabled={sendingMessage || uploadingAttachment || (!newMessage.trim() && pendingAttachments.length === 0)}
                    aria-label="Send message"
                  >
                    <svg
                      className={`group-chat-send-icon ${sendingMessage ? 'sending' : ''}`}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M4.5 11.5 18.95 5.48c.93-.39 1.88.55 1.49 1.48L14.4 21.47c-.38.92-1.71.89-2.04-.05l-1.7-4.86-4.83-1.73c-.93-.33-.96-1.65-.05-2.03Z"
                        fill="currentColor"
                      />
                      <path
                        d="M10.66 16.56 20.18 6.75"
                        fill="none"
                        stroke="#0b1a14"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      )}
      {activeTab === 'direct' && (
        <div className="groups-shell">
          <div className="groups-sidebar">
            <div className="groups-create-card">
              <div className="groups-create-title">Start Individual Chat</div>
              <div className="group-message-info-card direct-helper-card">
                Choose a teammate from the list below to start or continue a one-to-one conversation.
              </div>
            </div>

            <div className="groups-list">
              {directLoading && <div className="group-message-info-card">Loading people...</div>}
              {showEmptyDirectState && (
                <div className="group-message-info-card">No people available for direct chat yet.</div>
              )}
              {!directLoading && directListItems.map((item) => (
                <button
                  type="button"
                  className={`group-thread-card ${selectedDirectUserId === item.id ? 'active' : ''}`}
                  key={item.id}
                  onClick={() => setSelectedDirectUserId(item.id)}
                >
                  <div
                    className="group-thread-avatar"
                    style={{ '--group-avatar-hue': `${buildAvatarHue(item.name)}deg` }}
                  >
                    {buildInitials(item.name)}
                  </div>
                  <div className="group-thread-copy">
                    <div className="group-thread-topline">
                      <div className="group-thread-name">{item.name}</div>
                      <div className="group-thread-meta">{item.department || item.position || 'User'}</div>
                    </div>
                    <div className="group-thread-subline">
                      <span>{item.position || 'Member'}</span>
                      <span>{item.conversation?.lastMessagePreview || 'Start a conversation'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="groups-chat-window">
            {!selectedDirectUser && (
              <div className="group-chat-empty">
                <div className="group-chat-empty-icon">@</div>
                <h4>Select a person to start chatting</h4>
                <p>Your individual one-to-one conversations will appear here.</p>
              </div>
            )}

            {selectedDirectUser && (
              <>
                <div className="group-chat-header">
                  <div className="group-chat-summary">
                    <div
                      className="group-chat-header-avatar"
                      style={{ '--group-avatar-hue': `${buildAvatarHue(selectedDirectUser.name)}deg` }}
                    >
                      {buildInitials(selectedDirectUser.name)}
                    </div>
                    <div>
                      <div className="group-chat-title">{selectedDirectUser.name}</div>
                      <div className="group-chat-subtitle">
                        {selectedDirectUser.department || 'No department'}{selectedDirectUser.position ? `, ${selectedDirectUser.position}` : ''}
                      </div>
                    </div>
                </div>
                <div className="group-chat-actions">
                  <span className="group-chat-badge">Direct</span>
                  <button
                    type="button"
                    className={`group-chat-selection-toggle ${isDirectSelectionActive ? 'active' : ''}`}
                    onClick={() => (isDirectSelectionActive ? cancelMessageSelection() : startMessageSelection('direct'))}
                  >
                    {isDirectSelectionActive ? 'Cancel Select' : 'Select Messages'}
                  </button>
                </div>
              </div>

              {isDirectSelectionActive && (
                <div className="group-chat-selection-bar">
                  <div className="group-chat-selection-copy">
                    <strong>{selectedDirectMessageIds.length}</strong>
                    <span>{selectedDirectMessageIds.length === 1 ? 'message selected' : 'messages selected'}</span>
                  </div>
                  <div className="group-chat-selection-actions">
                    <button
                      type="button"
                      className="group-chat-selection-btn"
                      onClick={openForwardModal}
                      disabled={selectedDirectMessageIds.length === 0}
                    >
                      Forward Selected
                    </button>
                    <button
                      type="button"
                      className="group-chat-selection-btn secondary"
                      onClick={cancelMessageSelection}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              <div className="group-chat-body">
                  <div className="group-chat-thread" ref={directThreadRef}>
                    <CacheStatusBanner
                      showingCached={directMessageCacheStatus.showingCached}
                      isRefreshing={directMessagesRefreshing}
                      cachedAt={directMessageCacheStatus.cachedAt}
                      liveUpdatedAt={directMessageCacheStatus.liveUpdatedAt}
                      refreshingLabel="Refreshing latest direct messages..."
                      liveLabel="Conversation is up to date"
                      cachedLabel="Showing cached conversation"
                    />
                    {directMessages.length === 0 && (
                      <div className="group-chat-empty-thread">No direct messages yet. Start the conversation.</div>
                    )}
                    {directMessageItems.map((item) => {
                      if (item.type === 'separator') {
                        return (
                          <div key={item.id} className="group-chat-day-separator">
                            <span>{item.label}</span>
                          </div>
                        );
                      }

                      const message = item.message;
                      const mine = message.senderId === currentUserId;
                      const isSelected = selectedDirectMessageIds.includes(message.id);

                      return (
                        <div
                          key={item.id}
                          className={`group-chat-row ${mine ? 'mine' : 'theirs'} ${isDirectSelectionActive ? 'selecting' : ''} ${isSelected ? 'selected' : ''}`}
                          onClick={isDirectSelectionActive ? () => toggleMessageSelection('direct', message.id) : undefined}
                        >
                          {isDirectSelectionActive && (
                            <button
                              type="button"
                              className={`group-message-select-toggle ${isSelected ? 'selected' : ''}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleMessageSelection('direct', message.id);
                              }}
                              aria-label={isSelected ? 'Deselect message' : 'Select message'}
                            >
                              {isSelected ? '✓' : ''}
                            </button>
                          )}
                          {!mine && (
                            <div
                              className="group-message-avatar"
                              style={{ '--group-avatar-hue': `${buildAvatarHue(message.senderName)}deg` }}
                            >
                              {buildInitials(message.senderName)}
                            </div>
                          )}
                          <div className={`group-message-bubble ${mine ? 'mine' : 'theirs'}`}>
                            {!mine && <div className="group-message-sender">{message.senderName}</div>}
                            {message.message && <div className="group-message-text">{message.message}</div>}
                            {!!message.attachments?.length && (
                              <div className="group-message-attachments">
                                <ChatAttachmentGallery attachments={message.attachments} />
                              </div>
                            )}
                            <div className="group-message-meta">
                              <span>{formatMessageTime(message.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={directThreadEndRef} className="group-chat-thread-end" aria-hidden="true" />
                  </div>
                </div>

                <div className="group-chat-composer">
                  <AttachmentUploadStatus uploadState={directAttachmentUploadState} />
                  {!!directPendingAttachments.length && (
                    <div className="group-chat-attachment-strip">
                      {directPendingAttachments.map((attachment, index) => (
                        <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="group-chat-attachment-pill">
                          <span>{getAttachmentLabel(attachment)}</span>
                          <button
                            type="button"
                            onClick={() =>
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
                              })
                            }
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="group-chat-composer-shell">
                    <button
                      type="button"
                      className="group-chat-tool-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openAttachmentPicker('files', handleDirectAttachmentSelect);
                      }}
                      title="Attach files"
                      disabled={uploadingDirectAttachment}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="group-chat-tool-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openAttachmentPicker('folder', handleDirectAttachmentSelect);
                      }}
                      title="Attach folder"
                      disabled={uploadingDirectAttachment}
                    >
                      <svg
                        className="group-chat-tool-icon"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path
                          d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.12a2.25 2.25 0 0 1 1.59.66l1.35 1.34H18A2.25 2.25 0 0 1 20.25 8.75v7.5A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25v-9.5Z"
                          fill="currentColor"
                          opacity="0.22"
                        />
                        <path
                          d="M3.75 8.5A2 2 0 0 1 5.75 6.5h5.38l1.32 1.3c.23.24.55.37.88.37h5.42a1.5 1.5 0 0 1 1.45 1.89l-1.16 4.32a2 2 0 0 1-1.93 1.48H5.95a2 2 0 0 1-1.98-1.74L3.75 8.5Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <input
                      className="groups-input group-chat-input"
                      type="text"
                      placeholder="Type a direct message"
                      value={directNewMessage}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDirectNewMessage(nextValue);
                        if (selectedDirectUserIdRef.current) {
                          updateDirectComposerDraft(selectedDirectUserIdRef.current, {
                            text: nextValue,
                            attachments: directPendingAttachments,
                            uploading: uploadingDirectAttachment,
                            uploadState: directAttachmentUploadState,
                          });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          sendDirectMessage();
                        }
                      }}
                    />
                    <button
                      className="group-chat-send-btn"
                      onClick={sendDirectMessage}
                      disabled={
                        sendingDirectMessage ||
                        uploadingDirectAttachment ||
                        (!directNewMessage.trim() && directPendingAttachments.length === 0)
                      }
                      aria-label="Send direct message"
                    >
                      <svg
                        className={`group-chat-send-icon ${sendingDirectMessage ? 'sending' : ''}`}
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path
                          d="M4.5 11.5 18.95 5.48c.93-.39 1.88.55 1.49 1.48L14.4 21.47c-.38.92-1.71.89-2.04-.05l-1.7-4.86-4.83-1.73c-.93-.33-.96-1.65-.05-2.03Z"
                          fill="currentColor"
                        />
                        <path
                          d="M10.66 16.56 20.18 6.75"
                          fill="none"
                          stroke="#0b1a14"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {forwardState.open && (
        <div className="message-forward-overlay" onClick={closeForwardModal}>
          <div className="message-forward-modal" onClick={(event) => event.stopPropagation()}>
            <div className="message-forward-header">
              <div>
                <h4>Forward Messages</h4>
                <p>
                  {selectedForwardCount} {selectedForwardCount === 1 ? 'message' : 'messages'} selected from{' '}
                  {selectionMode === 'group' ? selectedGroup?.name || 'group chat' : selectedDirectUser?.name || 'direct chat'}.
                </p>
              </div>
              <button type="button" className="message-forward-close" onClick={closeForwardModal}>
                ✕
              </button>
            </div>

            <div className="message-forward-body">
              <div className="message-forward-summary">
                {selectedForwardMessages.map((message) => (
                  <div key={message.id} className="message-forward-summary-item">
                    <strong>{message.senderName || 'Unknown'}</strong>
                    <span>{message.message || 'Forwarded attachment message'}</span>
                    <small>{formatForwardTimestamp(message.createdAt)}</small>
                  </div>
                ))}
              </div>

              <label className="message-forward-note">
                <span>Add note (optional)</span>
                <textarea
                  value={forwardState.note}
                  onChange={(event) => setForwardState((prev) => ({ ...prev, note: event.target.value }))}
                  placeholder="Add context for the forwarded messages"
                  rows={3}
                />
              </label>

              <div className="message-forward-target-columns">
                <div className="message-forward-target-card">
                  <div className="message-forward-target-title">Forward To Group</div>
                  <div className="message-forward-target-list">
                    {forwardableGroups.length === 0 && (
                      <div className="message-forward-empty">No other groups available.</div>
                    )}
                    {forwardableGroups.map((group) => (
                      <label key={group.id} className="message-forward-target-option">
                        <input
                          type="checkbox"
                          checked={forwardState.groupIds.includes(group.id)}
                          onChange={() => toggleForwardGroupTarget(group.id)}
                        />
                        <span>{group.name}</span>
                        <small>{group.memberCount} members</small>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="message-forward-target-card">
                  <div className="message-forward-target-title">Forward To Individual</div>
                  <div className="message-forward-target-list">
                    {forwardableUsers.length === 0 && (
                      <div className="message-forward-empty">No users available.</div>
                    )}
                    {forwardableUsers.map((groupUser) => (
                      <label key={groupUser.id} className="message-forward-target-option">
                        <input
                          type="checkbox"
                          checked={forwardState.userIds.includes(groupUser.id)}
                          onChange={() => toggleForwardUserTarget(groupUser.id)}
                        />
                        <span>{groupUser.name}</span>
                        <small>{groupUser.department || groupUser.position || 'User'}</small>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="message-forward-footer">
              <button type="button" className="group-chat-selection-btn secondary" onClick={closeForwardModal}>
                Cancel
              </button>
              <button
                type="button"
                className="group-chat-selection-btn"
                onClick={submitForwardMessages}
                disabled={forwardState.sending}
              >
                {forwardState.sending ? 'Forwarding...' : 'Forward Now'}
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

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  if (variant === 'overlay') {
    if (!isOpen) return null;
    return (
      <div
        className={`group-message-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      >
        <div
          className={`group-message-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
          style={minimizedWindowStyle || undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="group-message-modal-header"
            onClick={isMinimized ? () => { onActivate?.(); setIsMinimized(false); } : undefined}
          >
            <div className="group-message-modal-copy">
              <h3>Message System</h3>
              <p>Groups, conversations, and shared attachments</p>
            </div>
            <div className="group-message-window-controls">
              {!isMinimized && (
                <button
                  type="button"
                  className="group-message-window-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleMinimize();
                  }}
                  title="Minimize"
                >
                  ─
                </button>
              )}
              <button
                type="button"
                className="group-message-window-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleMaximize();
                }}
                title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
              >
                {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
              </button>
              <button
                type="button"
                className="group-message-modal-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose();
                }}
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {!isMinimized && <div className="group-message-panel-body">{content}</div>}
        </div>
      </div>
    );
  }

  return content;
};

export default GroupMessagePanel;
