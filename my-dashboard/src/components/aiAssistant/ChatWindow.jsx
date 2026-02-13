import React, { useState, useRef, useEffect } from 'react';
import './ChatWindow.css';

const ChatWindow = ({ onClose, avatarPosition }) => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      type: 'bot',
      text: 'Hello! I\'m your AI Copilot. How can I assist you today?',
      timestamp: new Date()
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Handle send message
  const handleSendMessage = () => {
    if (inputValue.trim() === '') return;

    // Add user message
    const userMessage = {
      id: messages.length + 1,
      type: 'user',
      text: inputValue,
      timestamp: new Date()
    };

    setMessages([...messages, userMessage]);
    setInputValue('');
    setIsTyping(true);

    // Simulate AI response
    setTimeout(() => {
      const botMessage = {
        id: messages.length + 2,
        type: 'bot',
        text: 'I received your message: "' + inputValue + '". This is a demo response. In production, this would connect to your AI service.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, botMessage]);
      setIsTyping(false);
    }, 1500);
  };

  // Handle key press
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Quick suggestions
  const quickSuggestions = [
    'How do I track my tasks?',
    'Show me my inbox',
    'What are my pending assignments?'
  ];

  const handleSuggestionClick = (suggestion) => {
    setInputValue(suggestion);
  };

  return (
    <div className="chat-window-overlay">
      <div 
        className="chat-window"
        style={{
          bottom: `${window.innerHeight - avatarPosition.y + 10}px`,
          left: `${avatarPosition.x}px`
        }}
      >
        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-info">
            <div className="chat-avatar">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </div>
            <div>
              <h3>AI Copilot</h3>
              <span className="status">Online</span>
            </div>
          </div>
          <button className="close-chat-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`chat-message ${message.type === 'user' ? 'user-message' : 'bot-message'}`}
            >
              <div className="message-content">
                <p>{message.text}</p>
                <span className="message-time">
                  {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="chat-message bot-message">
              <div className="message-content typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Suggestions */}
        {messages.length === 1 && (
          <div className="quick-suggestions">
            {quickSuggestions.map((suggestion, index) => (
              <button
                key={index}
                className="suggestion-chip"
                onClick={() => handleSuggestionClick(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="chat-input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Type your message..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
          />
          <button
            className="send-btn"
            onClick={handleSendMessage}
            disabled={inputValue.trim() === ''}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatWindow;
