import { useCallback, useEffect, useMemo, useState } from 'react';
import ConversationChatView from './ConversationChatView';
import ConversationHeaderCard from './ConversationHeaderCard';
import DeveloperConsole from './DeveloperConsole';
import GenerationWorkspace from './GenerationWorkspace';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { normalizeApiError } from './chatgptCaptureUtils';

const VIEW_TABS = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'developer', label: 'Developer Console' },
];

export default function ConversationDetailPanel({ conversationId, onClose, emptyStateMode = 'conversation' }) {
  const [viewTab, setViewTab] = useState('conversation');

  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');

  const [conversationDetail, setConversationDetail] = useState(null);
  const [conversationDetailLoading, setConversationDetailLoading] = useState(false);
  const [conversationDetailError, setConversationDetailError] = useState('');

  const [conversationMessages, setConversationMessages] = useState(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState('');

  const [conversationAttachments, setConversationAttachments] = useState([]);
  const [conversationMedia, setConversationMedia] = useState([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  // Conversation-context toggle: OFF by default (clean generation workspace).
  // When ON, the full conversation chat is shown beneath the workspace.
  const [contextOn, setContextOn] = useState(false);

  const loadTimeline = useCallback(async (id) => {
    if (!id) return;
    setTimelineLoading(true);
    setTimelineError('');
    try {
      const response = await chatgptCaptureAPI.listEvents({ conversation_id: id, limit: 200 });
      // API returns newest-first; a timeline/chat view reads naturally oldest-first.
      setTimelineEvents([...response.data].reverse());
    } catch (error) {
      setTimelineError(normalizeApiError(error, 'Unable to load this conversation’s events.'));
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const loadConversationDetail = useCallback(async (id) => {
    if (!id) return;
    setConversationDetailLoading(true);
    setConversationDetailError('');
    try {
      const response = await chatgptCaptureAPI.getConversation(id);
      setConversationDetail(response.data);
    } catch (error) {
      setConversationDetailError(normalizeApiError(error, 'Unable to load this conversation.'));
    } finally {
      setConversationDetailLoading(false);
    }
  }, []);

  const loadConversationMessages = useCallback(async (id) => {
    if (!id) return;
    setMessagesLoading(true);
    setMessagesError('');
    try {
      const response = await chatgptCaptureAPI.getConversationMessages(id, { limit: 200 });
      setConversationMessages(response.data);
    } catch (error) {
      setMessagesError(normalizeApiError(error, 'Unable to load this conversation’s messages.'));
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  const loadConversationAttachments = useCallback(async (id) => {
    if (!id) return;
    try {
      const response = await chatgptCaptureAPI.getConversationAttachments(id);
      setConversationAttachments(response.data || []);
    } catch {
      // Supplementary media, not core capture data - a failed fetch here just
      // means no image previews for this conversation, never an error banner
      // over the conversation itself.
      setConversationAttachments([]);
    }
  }, []);

  const loadConversationMedia = useCallback(async (id) => {
    if (!id) return;
    setMediaLoading(true);
    try {
      const response = await chatgptCaptureAPI.getConversationMedia(id);
      setConversationMedia(response.data || []);
    } catch {
      // Generated/response images - same best-effort posture as attachments:
      // a failed fetch just means no gallery, never an error over the chat.
      setConversationMedia([]);
    } finally {
      setMediaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    setViewTab('conversation');
    setContextOn(false);
    loadTimeline(conversationId);
    loadConversationDetail(conversationId);
    loadConversationMessages(conversationId);
    loadConversationAttachments(conversationId);
    loadConversationMedia(conversationId);
  }, [conversationId, loadTimeline, loadConversationDetail, loadConversationMessages, loadConversationAttachments, loadConversationMedia]);

  const galleryMedia = useMemo(
    () => (conversationMedia || []).filter((item) => item.url),
    [conversationMedia]
  );

  const handleRefresh = useCallback(() => {
    if (!conversationId) return;
    loadTimeline(conversationId);
    loadConversationDetail(conversationId);
    loadConversationMessages(conversationId);
    loadConversationAttachments(conversationId);
    loadConversationMedia(conversationId);
  }, [conversationId, loadTimeline, loadConversationDetail, loadConversationMessages, loadConversationAttachments, loadConversationMedia]);

  const handleViewMedia = useCallback(() => {
    setViewTab('conversation');
    setContextOn(false);
  }, []);

  const handleExport = useCallback(() => {
    if (!conversationId) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      conversation: conversationDetail,
      messages: conversationMessages?.messages || [],
      media: conversationMedia,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `chatgpt-conversation-${conversationId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch {
      // best-effort client-side export - nothing to surface if the browser blocks it
    }
  }, [conversationId, conversationDetail, conversationMessages, conversationMedia]);

  const eventsById = useMemo(() => new Map(timelineEvents.map((event) => [event.id, event])), [timelineEvents]);
  const isTimelineTruncated = Boolean(
    conversationDetail && conversationDetail.eventCount > timelineEvents.length
  );

  if (!conversationId) {
    return (
      <div className="chatgpt-capture-panel chatgpt-capture-detail-panel">
        <div className="chatgpt-capture-empty-state">
          {emptyStateMode === 'user' ? (
            <>
              <span className="chatgpt-capture-empty-icon" aria-hidden="true">👥</span>
              <strong>Select a user</strong>
              <p>Choose a person on the left to explore their ChatGPT activity.</p>
            </>
          ) : (
            <>
              <span className="chatgpt-capture-empty-icon" aria-hidden="true">💬</span>
              <strong>Select a conversation</strong>
              <p>View prompts, responses, and generated assets here.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chatgpt-capture-panel chatgpt-capture-detail-panel">
      <div className="chatgpt-capture-detail-sticky-head">
        <div className="chatgpt-capture-panel-subhead">
          <button type="button" className="chatgpt-capture-back-btn" onClick={onClose}>
            ← Back to conversations
          </button>
          <div className="chatgpt-capture-view-tabs" role="tablist" aria-label="Conversation view">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={viewTab === tab.key}
                className={`chatgpt-capture-view-tab${viewTab === tab.key ? ' active' : ''}`}
                onClick={() => setViewTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <ConversationHeaderCard
          detail={conversationDetail}
          loading={conversationDetailLoading}
          error={conversationDetailError}
          hasMedia={galleryMedia.length > 0}
          onRefresh={handleRefresh}
          onViewMedia={handleViewMedia}
          onViewRaw={() => setViewTab('developer')}
          onExport={handleExport}
        />
      </div>

      {!timelineLoading && !timelineError && isTimelineTruncated && (
        <p className="chatgpt-capture-inline-note">
          Showing the most recent {timelineEvents.length} of {conversationDetail.eventCount} events for this conversation.
        </p>
      )}

      {viewTab === 'conversation' && (() => {
        const hasWorkspace = mediaLoading || galleryMedia.length > 0;
        // Full conversation shows when there's no generation workspace (a
        // text-only conversation - unchanged behavior) OR when the user turns
        // the Conversation-context toggle on.
        const showChat = !hasWorkspace || contextOn;
        return (
          <>
            {hasWorkspace && (
              <GenerationWorkspace
                media={galleryMedia}
                messages={conversationMessages?.messages || []}
                loading={mediaLoading}
                contextOn={contextOn}
                onContextChange={setContextOn}
              />
            )}
            {showChat && hasWorkspace && (
              <div className="cgpt-context-heading">💬 Full conversation</div>
            )}
            {showChat && (
              <ConversationChatView
                messages={conversationMessages?.messages}
                truncated={conversationMessages?.truncated}
                totalEvents={conversationMessages?.totalEvents}
                eventsById={eventsById}
                storedAttachments={conversationAttachments}
                ownerName={conversationDetail?.ownerName}
                conversationModel={conversationDetail?.model}
                onOpenWorkspace={galleryMedia.length > 0 ? handleViewMedia : undefined}
                loading={messagesLoading}
                error={messagesError}
              />
            )}
          </>
        );
      })()}

      {viewTab === 'developer' && (
        <DeveloperConsole
          events={timelineEvents}
          media={conversationMedia}
          detail={conversationDetail}
          loading={timelineLoading}
          error={timelineError}
        />
      )}
    </div>
  );
}
