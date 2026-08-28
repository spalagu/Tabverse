import type React from "react";

export interface CompletionInputProps {
  readonly value: string;
  readonly ghost: string;
  readonly className: string;
  readonly placeholder?: string;
  readonly inputRef?: React.RefObject<HTMLInputElement>;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** A text input with a non-interactive inline completion suffix. */
export function CompletionInput({
  value,
  ghost,
  className,
  placeholder,
  inputRef,
  onChange,
  onKeyDown,
}: CompletionInputProps) {
  return (
    <div className="ghost-wrap">
      <input
        ref={inputRef}
        className={className}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        {...{ writingsuggestions: "false" }}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {ghost && (
        <div className={`${className} ghost-line`} aria-hidden="true">
          <span className="ghost-typed">{value}</span>
          <span className="ghost-rest">{ghost}</span>
        </div>
      )}
    </div>
  );
}
