import React from 'react';
import SectionHeader from '../primitives/SectionHeader';

/**
 * Designed empty-state for report sections planned in the next iteration.
 * Lists the real business questions (from the question bank) each section will
 * answer, so the module reads as intentional rather than unfinished.
 */
const ComingSoon = ({ title, subtitle, questions = [] }) => (
  <div>
    <SectionHeader title={title} subtitle={subtitle} />
    <div className="rpt-empty">
      <div className="rpt-empty-card">
        <span className="rpt-empty-eyebrow">On the roadmap</span>
        <h3>Wired next — data model &amp; layout defined</h3>
        <p>
          This report is part of the intelligence blueprint and is scheduled in the next delivery slice.
          It will answer the questions below, each mapped to a metric, a visualization and a decision.
        </p>
        <ul className="rpt-empty-q">
          {questions.map((q, i) => <li key={i}>{q}</li>)}
        </ul>
      </div>
    </div>
  </div>
);

export default ComingSoon;
