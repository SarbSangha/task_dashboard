import React from 'react';
import GenerationPricesAdmin from '../../../reports/sections/GenerationPricesAdmin';
import FlowPricingAdmin from '../../../reports/sections/FlowPricingAdmin';
import '../../../reports/ReportsPanel.css';

/**
 * Credit prices for tools that never report a cost of their own, editable by
 * admins: Suno's fixed credits per song, and Flow's rate table + each Flow
 * account's plan. Both are dated - a change starts on its date, earlier
 * generations keep their price - so a future price change is just a new
 * entry here. The same editors also sit in Reports -> Credit Usage.
 */
const AdminCreditPricingTab = () => (
  <div className="act-root">
    <p className="art-hint">
      Prices for tools that show no cost per generation. A change applies from the date you pick;
      generations before it keep their old price.
    </p>
    <GenerationPricesAdmin />
    <FlowPricingAdmin />
  </div>
);

export default AdminCreditPricingTab;
