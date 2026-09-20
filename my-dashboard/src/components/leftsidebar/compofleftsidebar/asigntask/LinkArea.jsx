import React, { useState, useEffect } from "react";
import { useCustomDialogs } from "../../../common/CustomDialogs";

// Accepts a bare domain ("example.com") as well as a full URL - prepends
// https:// before validating so pasting a bare domain isn't a dead end, the
// way it used to be (it required http(s):// verbatim and rejected everything
// else outright, including a domain copied straight from an address bar).
const normalizeUrlCandidate = (raw) => {
  const trimmed = `${raw || ""}`.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const getLinkHostname = (link) => {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return link;
  }
};

export default function TaskForm({ links = [], onChange, disabled = false }) {
  const { showAlert } = useCustomDialogs();
  const [linkInput, setLinkInput] = useState("");
  const [localLinks, setLocalLinks] = useState(links);

  // Sync with parent when links prop changes
  useEffect(() => {
    setLocalLinks(links);
  }, [links]);

  // Notify parent of changes
  const notifyParent = (updatedLinks) => {
    if (onChange) {
      onChange(updatedLinks);
    }
  };

  // Handles one or several links at once - the placeholder says "paste
  // link(s)" for a reason: a brief's reference links usually arrive as a
  // newline- or comma-separated block, and forcing one-at-a-time entry was
  // needless friction. Invalid entries and repeats are reported, not
  // silently dropped, so a typo doesn't just vanish with no feedback.
  const addLinks = () => {
    if (disabled) return;
    const raw = linkInput.trim();
    if (!raw) {
      void showAlert("Please paste at least one link.", { title: "Invalid Link" });
      return;
    }

    const candidates = raw.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    const existingLower = new Set(localLinks.map((link) => link.toLowerCase()));
    const added = [];
    let invalidCount = 0;
    let duplicateCount = 0;

    for (const candidate of candidates) {
      const normalized = normalizeUrlCandidate(candidate);
      if (!normalized) {
        invalidCount += 1;
        continue;
      }
      const key = normalized.toLowerCase();
      if (existingLower.has(key)) {
        duplicateCount += 1;
        continue;
      }
      existingLower.add(key);
      added.push(normalized);
    }

    if (added.length === 0) {
      void showAlert(
        invalidCount > 0
          ? "Please enter a valid URL (e.g., example.com or https://example.com)."
          : "That link has already been added.",
        { title: "Invalid Link" }
      );
      return;
    }

    const updatedLinks = [...localLinks, ...added];
    setLocalLinks(updatedLinks);
    notifyParent(updatedLinks);
    setLinkInput("");

    if (invalidCount > 0 || duplicateCount > 0) {
      const notes = [`${added.length} link${added.length > 1 ? "s" : ""} added`];
      if (duplicateCount > 0) notes.push(`${duplicateCount} already added`);
      if (invalidCount > 0) notes.push(`${invalidCount} skipped (not a valid URL)`);
      void showAlert(notes.join(", ") + ".", { title: "Links added" });
    }
  };

  const removeLink = (index) => {
    if (disabled) return;
    const updated = localLinks.filter((_, i) => i !== index);
    setLocalLinks(updated);
    notifyParent(updated);
  };

  const clearAllLinks = () => {
    if (disabled || localLinks.length === 0) return;
    setLocalLinks([]);
    notifyParent([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (disabled) return;
      addLinks();
    }
  };

  return (
    <div className="assign-card link-area-card">
      <div className="assign-card-header">
        <h3>Related Links</h3>
        <p>
          Attach reference links, briefs, or source files. Paste one or more URLs
          (comma or newline separated) and click Add.
        </p>
      </div>

      <div className="link-section">
        <span className="link-input-icon" aria-hidden="true">🔗</span>
        <input
          type="text"
          placeholder="Paste link(s) here... e.g. https://example.com"
          value={linkInput}
          disabled={disabled}
          onChange={(e) => setLinkInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="link-input"
        />
        <button
          type="button"
          onClick={addLinks}
          className="add-link-btn"
          disabled={disabled || !linkInput.trim()}
        >
          Add
        </button>
      </div>

      {localLinks.length > 0 && (
        <div className="link-container">
          <div className="link-container-header">
            <p className="link-count">
              {localLinks.length} link{localLinks.length > 1 ? 's' : ''} added
            </p>
            {!disabled && localLinks.length > 1 && (
              <button type="button" className="link-clear-btn" onClick={clearAllLinks}>
                Clear all
              </button>
            )}
          </div>
          {localLinks.map((link, index) => (
            <div key={`${link}-${index}`} className="link-item">
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                title={link}
                className="link-item-link"
              >
                <span className="link-item-icon" aria-hidden="true">🔗</span>
                <span className="link-item-text">
                  <strong>{getLinkHostname(link)}</strong>
                  <small>{link}</small>
                </span>
              </a>
              <button
                type="button"
                className="remove-btn"
                disabled={disabled}
                onClick={() => removeLink(index)}
                aria-label={`Remove link ${link}`}
                title="Remove link"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
