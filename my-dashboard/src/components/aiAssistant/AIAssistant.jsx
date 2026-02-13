import React, { useState, useRef, useEffect } from 'react';
import './AIAssistant.css';
import ChatWindow from './ChatWindow';

const AIAssistant = () => {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: window.innerHeight - 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const avatarRef = useRef(null);

  // Toggle chat window
  const toggleChat = () => {
    if (!isDragging) {
      setIsChatOpen(!isChatOpen);
    }
  };

  // Handle mouse down - start dragging
  const handleMouseDown = (e) => {
    setIsDragging(true);
    const rect = avatarRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  };

  // Handle mouse move - dragging
  const handleMouseMove = (e) => {
    if (isDragging) {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;

      // Constrain to viewport
      const maxX = window.innerWidth - 70;
      const maxY = window.innerHeight - 70;

      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY))
      });
    }
  };

  // Handle mouse up - stop dragging
  const handleMouseUp = () => {
    setTimeout(() => setIsDragging(false), 100);
  };

  // Add global event listeners
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  return (
    <>
      {/* Draggable AI Avatar */}
      <div
        ref={avatarRef}
        className={`ai-assistant-avatar ${isDragging ? 'dragging' : ''}`}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`
        }}
        onMouseDown={handleMouseDown}
        onClick={toggleChat}
      >
        {/* AI Brain Icon */}
        <div className="avatar-icon">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
          </svg>
        </div>

        {/* Pulse Animation Rings */}
        <div className="pulse-ring"></div>
        <div className="pulse-ring-delayed"></div>

        {/* Tooltip */}
        <div className="avatar-tooltip">AI Copilot</div>
      </div>

      {/* Chat Window */}
      {isChatOpen && (
        <ChatWindow 
          onClose={() => setIsChatOpen(false)}
          avatarPosition={position}
        />
      )}
    </>
  );
};

export default AIAssistant;
