import type { ComponentType, ReactNode } from "react";

type TabIcon = ComponentType<{ className?: string; size?: number }>;

/**
 * The renderer-owned portion of one New Tab type row. Entry adapters own
 * permissions, desktop profiles/templates, URL input and the actual command;
 * this component keeps a tab type's icon, label and hint structurally shared.
 */
export function TabKindOptionPresentation({
  label,
  hint,
  Icon,
  iconSize,
  onSelect,
  className,
  labelClassName,
  hintClassName,
  leading,
  trailing,
  role,
  dataDirectKey,
}: {
  label: string;
  hint: string;
  Icon: TabIcon;
  iconSize?: number;
  onSelect: () => void;
  className: string;
  labelClassName: string;
  hintClassName: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  role?: "menuitem";
  dataDirectKey?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      className={`workbench-new-tab-option ${className}`}
      aria-label={label}
      data-direct-key={dataDirectKey}
      onClick={onSelect}
    >
      {leading}
      <Icon size={iconSize} />
      <span className={`workbench-new-tab-label ${labelClassName}`}>
        {label}
        <span className={`workbench-new-tab-hint ${hintClassName}`}>{hint}</span>
      </span>
      {trailing}
    </button>
  );
}
