import React, { useState, useMemo } from 'react';
import "./Tools.css"
// Inline SVG Icons
const Icons = {
  Search: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  Zap: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 14.71 13.5 3l-2.25 9H20L10.5 21l2.25-9H4Z" />
    </svg>
  ),
  Image: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  ),
  Cpu: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
    </svg>
  ),
  Edit: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  Shield: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  ),
  Globe: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
    </svg>
  ),
};

const AI_TOOLS = [
  { id: 1, name: "ChatGPT", category: "Generative AI", status: "Active", icon: <Icons.Zap /> },
  { id: 2, name: "Midjourney", category: "Image Generation", status: "Active", icon: <Icons.Image /> },
  { id: 3, name: "Copilot", category: "Coding Assistant", status: "Active", icon: <Icons.Cpu /> },
  { id: 4, name: "Jasper", category: "Content Writing", status: "Active", icon: <Icons.Edit /> },
  { id: 5, name: "DALL-E 3", category: "Image Generation", status: "Active", icon: <Icons.Image /> },
  { id: 6, name: "Claude", category: "Generative AI", status: "Active", icon: <Icons.Shield /> },
  { id: 7, name: "Perplexity", category: "Search/Research", status: "Active", icon: <Icons.Globe /> },
  { id: 8, name: "Stable Diffusion", category: "Image Generation", status: "Active", icon: <Icons.Image /> },
  { id: 9, name: "GitHub Copilot", category: "Coding Assistant", status: "Maintenance", icon: <Icons.Cpu /> },
  { id: 10, name: "Gemini", category: "Generative AI", status: "Active", icon: <Icons.Zap /> },
];

export default function Tools() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");

  const categories = useMemo(() => {
    return ["All", ...new Set(AI_TOOLS.map(tool => tool.category))];
  }, []);

  const filteredTools = useMemo(() => {
    return AI_TOOLS.filter(tool => {
      const matchesSearch =
        tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tool.category.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesCategory =
        selectedCategory === "All" || tool.category === selectedCategory;

      return matchesSearch && matchesCategory;
    });
  }, [searchQuery, selectedCategory]);

  return (
    <div className="app-container">

      {/* HEADER */}
      <header className="app-header">
        <div className="header-wrapper">

          <div>
            <h1 className="app-title">AI Tool Hub</h1>
            <p className="app-subtitle">
              Directory of modern artificial intelligence services
            </p>
          </div>

          <div className="search-wrapper">
            <div className="search-icon">
              <Icons.Search />
            </div>
            <input
              type="text"
              placeholder="Search tools..."
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

        </div>
      </header>

      {/* MAIN */}
      <main className="app-main">

        {/* CATEGORY FILTER */}
        <div className="category-container">
          {categories.map(category => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`category-btn ${
                selectedCategory === category ? "active" : ""
              }`}
            >
              {category}
            </button>
          ))}
        </div>

        {/* TOOL GRID */}
        <div className="tool-grid">
          {filteredTools.length > 0 ? (
            filteredTools.map(tool => (
              <div key={tool.id} className="tool-card">

                <div className="tool-header">
                  <div className="tool-icon">{tool.icon}</div>

                  <div className="status-badge">
                    <span
                      className={`status-dot ${
                        tool.status === "Active"
                          ? "status-active"
                          : "status-maintenance"
                      }`}
                    ></span>
                    <span>{tool.status}</span>
                  </div>
                </div>

                <h3 className="tool-name">{tool.name}</h3>

                <div className="tool-info">
                  <p><strong>Category:</strong> {tool.category}</p>
                  <p><strong>Status:</strong> {tool.status}</p>
                </div>

              </div>
            ))
          ) : (
            <div className="empty-state">
              <h3>No tools found</h3>
              <button
                className="reset-btn"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedCategory("All");
                }}
              >
                Reset filters
              </button>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}
