// content-grammarly-new-doc-gate.js — Client Mapping gate on doc creation
// (app.grammarly.com Docs list).
//
// Confirmed real button DOM (2026-08-27 live DOM capture, app.grammarly.com/
// ?source=doc-title-bar):
//   <button class="gds-button gds-button-primary gds-button-medium
//     buttonNew_f1628a0" type="button" tabindex="0"
//     data-name="new-ai-doc-add-btn">
//     <svg data-icon="InterfaceNew" ...></svg>
//     <span class="gds-typography gds-text gds-text-small">New doc</span>
//   </button>
// data-name="new-ai-doc-add-btn" is the primary (and only) selector used
// here - the "buttonNew_f1628a0" class looks like a CSS-modules build hash
// and cannot be trusted to survive a redeploy, same posture every other
// provider's gate takes toward its own confirmed real selector.
//
// ---- Why this blocks pointerdown/pointerup, not just click (confirmed
// real incident, 2026-08-27) ----
// The first version of this file only blocked the "click" event, the same
// technique content-splice-capture.js/content-envato-capture.js use for
// their own gates - and it did NOT work: the doc was created immediately,
// before the user ever got to pick a client in the modal that was still
// opening. Root cause: this button is a "gds-" (Grammarly Design System)
// component - the dropdown control right next to it exposes a real
// aria-controls="react-aria...:r1:" id, confirming this app is built on
// React Aria's usePress, which fires its press action on pointerdown/
// pointerup, resolving BEFORE the native "click" event ever fires (click
// only fires after mouseup, which itself only fires after pointerup) - by
// the time a "click" listener runs, React Aria's own handler already ran.
// content-envato-capture.js's own dispatchRealisticClick comment already
// flagged this exact class of framework behavior ("element.click() only
// ever fires a click event, never the pointerdown/mousedown a real user
// interaction produces first") for its REPLAY side; this file needed the
// same realization applied to its BLOCKING side too. Fix: intercept
// pointerdown (capture phase, earliest possible) as the primary trigger,
// and ALSO block the pointerup/mousedown/mouseup/click that follow the same
// physical interaction (matching what dispatchRealisticClick's own replay
// sequence has to reproduce below) so nothing slips through on whichever
// event the framework actually reacts to.
//
// A second control sits right next to it - a dropdown arrow
// (data-name="new-doc-add-btn-dropdown", aria-haspopup="true") that opens a
// menu with presumably more creation options (blank/import/template/etc).
// NOT intercepted here - no confirmed selector exists yet for whatever its
// menu items render as, so clicking through that menu currently creates a
// doc with NO client gate. Known gap.
//
// ---- The unconfirmed part, and why the design below is deliberately
// resilient to it ----
// Unlike every generation/download provider in this codebase, there is no
// captured network response confirming what happens after this click (does
// it POST to an API and get a docId back, or does the page's own client
// router just navigate once local state updates?). This gate therefore does
// NOT try to correlate the interaction to a specific doc the way e.g.
// content-splice-capture.js arms a pending capture against a specific
// graphql relay. Instead: once a client is picked, the selection is stashed
// in chrome.storage.local (NOT sessionStorage - the resulting doc opens at a
// DIFFERENT origin, coda.grammarly.com, which cannot read
// app.grammarly.com's sessionStorage) with a short TTL, and
// content-grammarly-docs.js's own doc_open handler picks up and attaches
// whatever pending selection is still fresh when the very next doc session
// starts. This works whether the new doc opens in the same tab or a new one.

const GRAMMARLY_NEW_DOC_BUTTON_SELECTOR = '[data-name="new-ai-doc-add-btn"]';
const GRAMMARLY_PENDING_CLIENT_STORAGE_KEY = 'grammarlyDocsPendingClientSelection';
// Generous but bounded - covers a slow click-to-navigate gap without letting
// a stale, abandoned selection attach itself to a LATER, unrelated doc open
// (e.g. the user picked a client, then got distracted and opened a
// completely different existing doc ten minutes later).
const GRAMMARLY_PENDING_CLIENT_TTL_MS = 2 * 60 * 1000;
// How long after arming a bypass the replayed pointerdown/mousedown/
// pointerup/mouseup/click sequence (dispatched synchronously, back to back)
// is allowed through unblocked. Generous relative to how fast those five
// synthetic dispatches actually fire, deliberately not razor-thin.
const GRAMMARLY_NEW_DOC_GATE_GRACE_MS = 4000;

function grammarlyNewDocIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function grammarlyNewDocIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

function grammarlyFindNewDocButton(eventTarget) {
  const startFromElement = () => (eventTarget?.nodeType === Node.ELEMENT_NODE ? eventTarget : eventTarget?.parentElement);

  let current = startFromElement();
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      current.matches?.(GRAMMARLY_NEW_DOC_BUTTON_SELECTOR)
      && grammarlyNewDocIsVisible(current) && !grammarlyNewDocIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

// Stashes the picked client for content-grammarly-docs.js's doc_open handler
// to pick up. Uses chrome.storage.local directly (the "storage" permission
// is already granted extension-wide - see manifest.json) rather than
// relaying through the background service worker - there is no ownership/
// ticket resolution needed for a plain local write, unlike every message
// this extension routes through background-*-capture.js.
async function stashGrammarlyPendingClientSelection(selection) {
  try {
    await chrome.storage.local.set({
      [GRAMMARLY_PENDING_CLIENT_STORAGE_KEY]: {
        clientId: selection.clientId,
        clientName: selection.clientName,
        storedAt: Date.now(),
      },
    });
  } catch (error) {
    console.warn('[RMW Grammarly New Doc Gate] failed to stash pending client selection', error);
  }
}

// Replays the full physical interaction sequence, not a bare target.click() -
// see this file's own header comment on why a synthetic "click" alone is
// not enough for a React Aria usePress-driven button. Own local copy per
// this codebase's stated convention (content-envato-capture.js's identical
// dispatchRealisticClick carries the same "no helper sharing between
// provider files" note) rather than a shared helper.
function dispatchRealisticClick(target) {
  if (!target) return;
  const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
  const point = rect
    ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    : { clientX: 0, clientY: 0 };
  const base = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, isPrimary: true, ...point };
  let dispatchedAny = false;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
    try {
      const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventCtor(type, base));
      dispatchedAny = true;
    } catch {
      // Construction failed for this event type - the rest of the sequence
      // still fires, and the plain target.click() fallback below covers a
      // total failure.
    }
  });
  if (!dispatchedAny) {
    try { target.click(); } catch {}
  }
}

let grammarlyNewDocGateModalOpen = false;
let grammarlyNewDocGateClearedUntil = 0; // Date.now()-comparable - see GRAMMARLY_NEW_DOC_GATE_GRACE_MS
let grammarlyNewDocGateArmedForTarget = null; // which element the current bypass window applies to

async function runGrammarlyNewDocClientGate(target) {
  if (grammarlyNewDocGateModalOpen) return; // double-trigger while the modal is already open - no-op
  grammarlyNewDocGateModalOpen = true;
  try {
    const selection = await openGrammarlyDocsClientSelectionModal();
    if (!selection) return; // cancelled/ESC/no clients available - interaction stays blocked, no doc created
    await stashGrammarlyPendingClientSelection(selection);
    grammarlyNewDocGateArmedForTarget = target;
    grammarlyNewDocGateClearedUntil = Date.now() + GRAMMARLY_NEW_DOC_GATE_GRACE_MS;
    dispatchRealisticClick(target);
  } finally {
    grammarlyNewDocGateModalOpen = false;
  }
}

// One shared handler bound to every event type in the physical
// pointerdown -> mousedown -> pointerup -> mouseup -> click sequence (both
// the real interaction AND dispatchRealisticClick's replay produce exactly
// these five, in this order) - capturing phase, so it fires before the
// page's own listeners regardless of which of the five they actually react
// to. pointerdown is treated as the trigger for a NEW gate (the earliest
// event a real mouse/touch interaction produces); the other four are only
// ever blocked-or-passed-through relative to whatever pointerdown already
// decided, never a second independent trigger for the same click.
function handleGrammarlyNewDocGateEvent(event) {
  try {
    const target = grammarlyFindNewDocButton(event.target);
    if (!target) return;

    const withinBypassWindow = grammarlyNewDocGateArmedForTarget === target && Date.now() < grammarlyNewDocGateClearedUntil;
    if (withinBypassWindow) {
      if (event.type === 'click') {
        // Last event of the replayed sequence - the bypass window has done
        // its job for this interaction, close it out so a genuinely new
        // click on the same (still-visible) button gates again.
        grammarlyNewDocGateArmedForTarget = null;
        grammarlyNewDocGateClearedUntil = 0;
      }
      return; // let it through to Grammarly's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Keyboard activation (Enter/Space on a focused button) fires "click"
    // directly with no preceding pointerdown - so pointerdown is the
    // primary trigger for real pointer interactions, and click is a
    // fallback trigger ONLY when no gate is already in flight (covers the
    // keyboard path without double-triggering the mouse path, since a real
    // mouse click's own "click" arrives after pointerdown already opened
    // the modal and grammarlyNewDocGateModalOpen is true by then).
    if (event.type === 'pointerdown' || (event.type === 'click' && !grammarlyNewDocGateModalOpen)) {
      runGrammarlyNewDocClientGate(target);
    }
  } catch {}
}

['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
  document.addEventListener(type, handleGrammarlyNewDocGateEvent, true); // capturing phase
});
