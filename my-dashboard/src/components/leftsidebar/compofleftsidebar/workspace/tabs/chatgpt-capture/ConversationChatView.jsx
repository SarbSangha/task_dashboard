import { useMemo } from 'react';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ChatMessageCard from './ChatMessageCard';
import { formatDayLabel } from './chatgptCaptureUtils';

export default function ConversationChatView({
  messages,
  eventsById,
  storedAttachments,
  media,
  ownerName,
  conversationModel,
  onOpenWorkspace,
  loading,
  error,
  truncated,
  totalEvents,
}) {
  // Group consecutive messages by day for subtle time separators (Today /
  // Yesterday / date), so the timestamp context isn't repeated on every line.
  const groups = useMemo(() => {
    const result = [];
    let current = null;
    for (const message of messages || []) {
      const label = formatDayLabel(message.timestamp);
      if (!current || current.label !== label) {
        current = { label, messages: [] };
        result.push(current);
      }
      current.messages.push(message);
    }
    return result;
  }, [messages]);

  // Pair captured media assets (the generated images the Generation Workspace
  // shows) to the assistant message that should render them inline, so the
  // transcript isn't stuck on "not yet uploaded" while the picture sits up in
  // the workspace panel.
  //
  // The hard part: the two capture paths disagree on ownership. A response's
  // `contentParts` (authoritative reconstruction) is where the `image` part
  // with its `assetPointer` lives, but `conversation_media_assets.assistant_
  // message_id` (DOM/network capture) frequently points at a *different*
  // response in the same turn (e.g. the empty "thinking" message that came
  // first). Confirmed in live data: asset 169's assistantMessageId is the
  // turn's first, text-empty response; the image contentPart is on the
  // second. So this pairs to the CONTENT PARTS themselves:
  //   1. every unresolved `image` contentPart, in document order
  //   2. every url-bearing media asset, in display order
  //   3. match by assetPointer<->providerAssetId when both are known,
  //      otherwise fill remaining parts with remaining assets positionally
  //   4. any asset still unclaimed -> nearest assistant message by time, so a
  //      media-only turn (no contentParts image) still shows it via
  //      ChatMessageCard's own media branches
  // Keyed by the message's synthetic row id.
  const mediaByMessageId = useMemo(() => {
    const map = new Map();
    const assistantMessages = (messages || []).filter((m) => m.role === 'assistant');
    const assets = (media || []).filter((asset) => asset && asset.url);
    if (!assistantMessages.length || !assets.length) return map;

    const stripPointer = (value) => `${value || ''}`.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').trim();

    const orderedAssets = [...assets].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
        || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    // Every `image` contentPart across assistant messages, in document order.
    const slots = [];
    for (const message of assistantMessages) {
      for (const part of message.contentParts || []) {
        if (part && part.type === 'image') {
          slots.push({
            messageId: message.id,
            providerMessageId: message.providerMessageId,
            pointerKey: stripPointer(part.assetPointer),
          });
        }
      }
    }

    const claimed = new Set();
    const assign = (messageId, asset) => {
      const existing = map.get(messageId) || [];
      existing.push(asset);
      map.set(messageId, existing);
      claimed.add(asset);
    };

    // 1. slot <- asset by exact message id. asset.assistantMessageId is the
    //    real ChatGPT message id; when it equals the slot's own response id
    //    this is an unambiguous pairing (this is what fixes an edit turn
    //    picking up the pre-edit image just because it was created earlier).
    for (const slot of slots) {
      if (!slot.providerMessageId) continue;
      const hit = orderedAssets.find(
        (a) => !claimed.has(a) && a.assistantMessageId && a.assistantMessageId === slot.providerMessageId
      );
      if (hit) {
        assign(slot.messageId, hit);
        slot.filled = true;
      }
    }

    // 2. slot <- asset by assetPointer / providerAssetId
    for (const slot of slots) {
      if (slot.filled || !slot.pointerKey) continue;
      const hit = orderedAssets.find((a) => !claimed.has(a) && stripPointer(a.providerAssetId) === slot.pointerKey);
      if (hit) {
        assign(slot.messageId, hit);
        slot.filled = true;
      }
    }

    // 3. still-empty slots <- leftover assets, positionally (oldest first)
    let cursor = 0;
    const leftover = orderedAssets.filter((a) => !claimed.has(a));
    for (const slot of slots) {
      if (slot.filled) continue;
      if (cursor >= leftover.length) break;
      assign(slot.messageId, leftover[cursor]);
      cursor += 1;
    }

    // 4. assets with no image contentPart slot -> the nearest assistant
    //    message by time. Covers a turn that produced an image but whose
    //    response carries no image contentPart (a text-only reply the DOM
    //    capture still attached an asset to, or a turn whose text capture
    //    failed entirely). Deliberately NOT keyed on asset.assistantMessageId
    //    here: that id is populated by a separate DOM/network capture path
    //    and has been observed pointing at the wrong response (an earlier
    //    turn in the same conversation) often enough that the asset's own
    //    creation time is the more trustworthy signal. The id IS still used
    //    in step 1, but only to corroborate a message that already has a
    //    matching image contentPart.
    for (const asset of orderedAssets) {
      if (claimed.has(asset)) continue;
      const assetMs = new Date(asset.createdAt || 0).getTime();
      let target = null;
      let bestDiff = Infinity;
      for (const message of assistantMessages) {
        const diff = Math.abs(new Date(message.timestamp || 0).getTime() - assetMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          target = message;
        }
      }
      if (target) assign(target.id, asset);
    }

    return map;
  }, [messages, media]);

  if (loading) {
    return (
      <div className="chatgpt-capture-chat-view" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="chatgpt-capture-chat-turn-skeleton">
            <SkeletonBlock width={28} height={28} rounded />
            <div style={{ flex: 1 }}>
              <SkeletonBlock width="30%" height={12} />
              <SkeletonBlock width="80%" height={14} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="chatgpt-capture-alert">{error}</div>;
  }

  return (
    <div className="chatgpt-capture-chat-view cgpt-chat-view">
      {truncated && (
        <p className="chatgpt-capture-inline-note">
          Showing the most recent messages from {totalEvents} captured events for this conversation.
        </p>
      )}

      {(!messages || messages.length === 0) ? (
        <div className="chatgpt-capture-empty-state compact">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">💬</span>
          <strong>No messages captured</strong>
          {totalEvents > 0 ? (
            // The conversation has events, just no prompt/response ones - it
            // was opened or renamed while capture was running and nothing was
            // ever sent in it. Saying "data will appear once captured" here
            // reads like a pending failure and is what made this state look
            // broken; nothing is missing.
            <p>
              Only activity like opening or renaming was recorded for this chat
              ({totalEvents} {totalEvents === 1 ? 'event' : 'events'}) — no prompt
              or response was sent in it while capture was running.
            </p>
          ) : (
            <p>Conversation data will appear here once prompts and responses are captured.</p>
          )}
        </div>
      ) : (
        <div className="cgpt-chat-column">
          {groups.map((group) => (
            <section key={`${group.label}-${group.messages[0]?.id}`} className="cgpt-chat-daygroup">
              <div className="cgpt-chat-daydivider"><span>{group.label}</span></div>
              {group.messages.map((message) => (
                <ChatMessageCard
                  key={message.id}
                  message={message}
                  ownerName={ownerName}
                  eventsById={eventsById}
                  storedAttachments={storedAttachments}
                  media={media}
                  inlineMedia={mediaByMessageId.get(message.id)}
                  conversationModel={conversationModel}
                  onOpenWorkspace={onOpenWorkspace}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
