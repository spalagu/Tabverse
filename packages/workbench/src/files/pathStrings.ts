/** Remove trailing separators without applying a regular expression to user input. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Collapse repeated separators in one linear pass. */
export function collapseRepeatedSlashes(value: string): string {
  let result = "";
  let previousWasSlash = false;
  for (const character of value) {
    const isSlash = character === "/";
    if (!isSlash || !previousWasSlash) result += character;
    previousWasSlash = isSlash;
  }
  return result;
}
