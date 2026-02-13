import React, { useState, useEffect } from "react";

export default function TaskForm({ links = [], onChange }) {
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

  const addLink = () => {
    if (linkInput.trim() === "") {
      alert("Please enter a valid link");
      return;
    }

    // Basic URL validation
    try {
      new URL(linkInput.trim());
    } catch {
      // If not a full URL, add https://
      if (!linkInput.startsWith('http')) {
        alert("Please enter a valid URL starting with http:// or https://");
        return;
      }
    }

    const updatedLinks = [...localLinks, linkInput.trim()];
    setLocalLinks(updatedLinks);
    notifyParent(updatedLinks);
    setLinkInput("");
  };

  const removeLink = (index) => {
    const updated = localLinks.filter((_, i) => i !== index);
    setLocalLinks(updated);
    notifyParent(updated);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addLink();
    }
  };

  return (
    <div className="assign-row assign-card">
      <h3>Related Links</h3>

      {/* Link Input Section */}
      <div className="link-section">
        <input
          type="text"
          placeholder="🔗 Paste link here... (e.g., https://example.com)"
          value={linkInput}
          onChange={(e) => setLinkInput(e.target.value)}
          onKeyPress={handleKeyPress}
          className="link-input"
        />
        <button 
          onClick={addLink} 
          className="add-link-btn"
          disabled={!linkInput.trim()}
        >
          ➕ Add
        </button>
      </div>

      {/* Stored Links */}
      {localLinks.length > 0 && (
        <div className="link-container">
          <p className="link-count">
            {localLinks.length} link{localLinks.length > 1 ? 's' : ''} added
          </p>
          {localLinks.map((link, index) => (
            <div key={index} className="link-item">
              <a 
                href={link} 
                target="_blank" 
                rel="noopener noreferrer"
                title={link}
              >
                🔗 {link.length > 50 ? link.substring(0, 47) + '...' : link}
              </a>
              <button
                className="remove-btn"
                onClick={() => removeLink(index)}
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
