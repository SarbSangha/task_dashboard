import { forwardRef } from 'react';
import './Button.css';

/**
 * Button — the shared button hierarchy.
 *
 *   primary   → the one main action on a screen
 *   secondary → alternative actions
 *   ghost     → low-priority / inline actions
 *   danger    → destructive actions
 *   icon      → square icon-only button (pair with `aria-label`)
 *
 * Variants map onto the existing --color-button-* token families in index.css,
 * so themes are handled for free. `sizes`: sm | md. Renders a real <button>;
 * all native props (type, onClick, disabled, aria-*) pass straight through.
 */
const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', className = '', leadingIcon, trailingIcon, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      className={`ui-btn ui-btn-${variant} ui-btn-${size} ${className}`.trim()}
      {...rest}
    >
      {leadingIcon != null && <span className="ui-btn-glyph" aria-hidden="true">{leadingIcon}</span>}
      {children != null && <span className="ui-btn-label">{children}</span>}
      {trailingIcon != null && <span className="ui-btn-glyph" aria-hidden="true">{trailingIcon}</span>}
    </button>
  );
});

export default Button;
