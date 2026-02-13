// src/components/hero/RMWHero.jsx
import React from 'react';
import './RMWHero.css';

const RMWHero = ({ onStartTrack }) => {
  return (
    <section className="rmw-hero">
      <div className="rmw-hero-inner">
        {/* Eye icon */}
        <div className="rmw-hero-eye">
          <svg viewBox="0 0 24 24">
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 11c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6.5c-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5 2.5-1.12 2.5-2.5S13.38 9 12 9z" />
          </svg>
        </div>

        {/* Big title */}
        <div className="rmw-hero-title">
          <span className="rmw-main">RMW</span>
          <span className="rmw-sub">eye</span>
        </div>

        {/* Subtitle */}
        <p className="rmw-hero-subline">INTELLIGENCE CORE</p>

        {/* Description */}
        <p className="rmw-hero-description">
          ASSIGN TASKS WITH RICH MEDIA RESOURCES. TRACK DEPARTMENTAL NODES AND PROCESS PROJECT
          DIRECTIVES VIA THE RMW EYE INTERFACE.
        </p>

        {/* Button */}
        <button className="rmw-hero-button" onClick={onStartTrack}>
          <span>INITIALIZE TRACK</span>
          <div className="rmw-hero-button-icon">
            <svg viewBox="0 0 24 24">
              <path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 2c3.86 0 7 3.14 7 7 0 3.87-3.14 7-7 7-3.87 0-7-3.13-7-7 0-3.86 3.13-7 7-7zm-1 3v8l5-4-5-4z" />
            </svg>
          </div>
        </button>
      </div>
    </section>
  );
};

export default RMWHero;
