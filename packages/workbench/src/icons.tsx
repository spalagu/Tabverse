interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function CloseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function TerminalIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 5l3 3-3 3" />
      <path d="M8.5 11h4" />
    </svg>
  );
}

export function FilesIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1v-7.5z"
        fill="currentColor"
        fillOpacity={0.14}
      />
    </svg>
  );
}

export function GlobeIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.8 2.5 3.8 2.5 6S9.8 12.2 8 14c-1.8-1.8-2.5-3.8-2.5-6S6.2 3.8 8 2z" />
    </svg>
  );
}

export function GearIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="4.6" />
      <circle cx="8" cy="8" r="1.7" />
      <path d="M8 1.9v1.9M8 12.2v1.9M1.9 8h1.9M12.2 8h1.9M3.75 3.75l1.35 1.35M10.9 10.9l1.35 1.35M12.25 3.75L10.9 5.1M5.1 10.9l-1.35 1.35" />
    </svg>
  );
}

export function LinkIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 9.5l3-3" />
      <path d="M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1" />
      <path d="M8.5 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" />
    </svg>
  );
}

/** A triangle with a mark in it: something went wrong here. */
export function AlertIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.8L14 12.8H2L8 2.8z" />
      <path d="M8 6.8v2.8" />
      <circle cx="8" cy="11.3" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

const BUILTIN_TAB_ICONS: Readonly<Record<string, typeof TerminalIcon>> = {
  terminal: TerminalIcon,
  files: FilesIcon,
  browser: GlobeIcon,
  settings: GearIcon,
  remote: LinkIcon,
};

/** Unknown plugin kinds retain a visible warning glyph instead of crashing. */
export const TAB_ICONS: Readonly<Record<string, typeof TerminalIcon>> = new Proxy(
  BUILTIN_TAB_ICONS,
  { get: (icons, kind: string) => icons[kind] ?? AlertIcon },
);

export function FolderIcon({
  size = 14,
  className,
  open = false,
}: IconProps & { open?: boolean }) {
  return (
    <svg {...base(size)} className={className}>
      {open ? (
        <>
          <path
            d="M13.5 6.8V6c0-.6-.4-1-1-1H7.2L5.7 3.5H3.5c-.6 0-1 .4-1 1v8"
            fill="currentColor"
            fillOpacity={0.14}
          />
          <path d="M2.5 12.5l1.8-4.3c.2-.4.5-.7.9-.7h9.3l-2 4.4c-.2.4-.5.6-.9.6H2.5z" />
        </>
      ) : (
        <path
          d="M2.5 4.5c0-.6.4-1 1-1h2.2L7.2 5h5.3c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V4.5z"
          fill="currentColor"
          fillOpacity={0.14}
        />
      )}
    </svg>
  );
}
