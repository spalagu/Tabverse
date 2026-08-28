interface IconProps {
  size?: number;
  className?: string;
}

export {
  AgentIcon,
  AlertIcon,
  CloseIcon,
  FilesIcon,
  FolderIcon,
  GearIcon,
  GlobeIcon,
  LinkIcon,
  TAB_ICONS,
  TerminalIcon,
} from "@tabverse/workbench/icons";

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  // Round-three refresh: a touch more weight than the old 1.5 so glyphs
  // hold their shape on retina at 14-15px next to the heavier type.
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});


export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function ArchiveIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="3" width="11" height="3" rx="0.8" />
      <path d="M3.5 6v6c0 .6.4 1 1 1h7c.6 0 1-.4 1-1V6M6.5 8.5h3" />
    </svg>
  );
}

/** A lidded can with ribs: delete, where an ✕ would read as "close". */
export function TrashIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1" />
      <path d="M4.2 4.5l.7 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8" />
      <path d="M6.7 7v3.6M9.3 7v3.6" />
    </svg>
  );
}
export function ShareIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7" />
      <path d="M2.5 2.5a8 8 0 0 0 0 11M13.5 2.5a8 8 0 0 1 0 11" opacity="0.5" />
    </svg>
  );
}

export function SpeakerIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6.5h2l2.5-2v7l-2.5-2H3z" />
      <path d="M9.5 6a3 3 0 0 1 0 4" />
      <path d="M11.3 4.7a5.5 5.5 0 0 1 0 6.6" opacity="0.6" />
    </svg>
  );
}

export function SpeakerMutedIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6.5h2l2.5-2v7l-2.5-2H3z" />
      <path d="M9.5 6.5l3 3M12.5 6.5l-3 3" />
    </svg>
  );
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3.3 3.3" />
    </svg>
  );
}


export function DownloadIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.5v7M5 6.5l3 3 3-3" />
      <path d="M2.5 10.5v2c0 .6.4 1 1 1h9c.6 0 1-.4 1-1v-2" />
    </svg>
  );
}

export function PeekCloseIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </svg>
  );
}

export function PeekPromoteIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6 10l4-4M7 6h3v3" />
    </svg>
  );
}

export function PeekSplitIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="1.6" y="3.2" width="4.6" height="9.6" rx="1.2" />
      <rect x="7.8" y="3.2" width="6.6" height="9.6" rx="1.2" />
    </svg>
  );
}

export function MoreIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="4" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Buzz-compatible left-panel glyph: the frame and divider keep their shape;
 * only the divider weight reflects whether the sidebar is visible.
 */
export function SidebarIcon({
  size = 18,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size)} className={className}>
      {/* Buzz's two mode glyphs share the same window frame. The persistent
          mode uses a heavier sidebar rail; the auto-collapse mode uses the
          same rail at a lighter weight and keeps it close to the left edge. */}
      <rect
        x="1.25"
        y="1.4"
        width="13.5"
        height="13.2"
        rx="3"
        strokeWidth={filled ? 1.8 : 1.4}
      />
      <rect
        x="3.5"
        y="3.5"
        width={filled ? 3.3 : 1.45}
        height="9"
        rx={filled ? 1.65 : 0.72}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
