import React from 'react';
import Tools from '../Tools';

export default function ToolsTab({ searchQuery, onSearchChange }) {
  return <Tools view="tools" searchQuery={searchQuery} onSearchChange={onSearchChange} />;
}
