
/**
 * The least this needs from a canvas: set a font, measure some text.
 *
 * A `CanvasRenderingContext2D` satisfies it, and so does a handful of lines
 * in a test — which is the point. The discrimination this module exists for
 * (a family that resolves against one that does not) is exactly what cannot
 * be exercised through a real canvas in a headless test run.
 */
export interface InkMeasurer {
  font: string;
  measureText(text: string): { width: number };
}

/**
 * The text every measurement is taken on.
 *
 * Chosen for width disagreement rather than for meaning: repeated narrow and
 * wide letters, the ligature-forming operator pairs, and the digit-zero
 * family that monospaced faces draw so differently from serif ones.
 */
export const PROBE_TEXT = "mmmiiillWW==>!=@#0Oo";

/** The size the comparison is drawn at — large, so a small per-glyph
 * difference adds up to something no rounding can swallow. */
const PROBE_PX = 48;

/**
 * Half a pixel. Advance widths are fractional, and two genuinely different
 * faces differ by whole pixels many times over at 48px; nothing legitimate
 * lands inside this band.
 */
const INK_EPSILON = 0.5;

/**
 * The fallbacks a candidate is measured against, in the order they are
 * tried. `serif` is first because it is the one that is never the same face
 * as a monospaced candidate — see the note above about `monospace` being
 * Menlo.
 */
export const PROBE_GENERICS: readonly string[] = ["serif", "sans-serif", "monospace"];

/** A family name no machine has — the baseline every candidate is compared
 * against. */
export const ABSENT_FAMILY = "NoSuchFamily_qX7_ShouldNeverExist";

/**
 * A second name no machine has, used on nothing but the probe itself: if
 * THIS measures as present, the measurements are noise and every other
 * answer this probe gives is worthless.
 */
export const CONTROL_ABSENT_FAMILY = "AlsoNotReal_zzz_9x_family";

/**
 * What a family is. `unmeasurable` is not a hedge between the other two: it
 * says the machine could not be asked, which is a different fact from "the
 * font is not there" and must not be shown to anyone as if it were.
 */
export type FontVerdict = "available" | "missing" | "unmeasurable";

export interface FontProbe {
  /** Whether `family` really drew the text. Meaningless while
   * [`blindness`] is non-null — [`verdict`] is the guarded form. */
  resolves(family: string): boolean;
  /** Why this probe cannot be believed, in a few words, or null. */
  blindness(): string | null;
  /** [`resolves`] as a verdict, `unmeasurable` whenever the probe is
   * blind. */
  verdict(family: string): FontVerdict;
}

/**
 * A family name as it goes into a CSS font shorthand.
 *
 * Quoted always, and stripped of the two characters that would end the
 * quoted name early: a family cannot contain them, and a value that does is
 * either a mistake or an attempt to write more than a family name into a
 * place that takes one.
 */
function quoted(family: string): string {
  return `"${family.replace(/["\\]/g, "")}"`;
}

/** A probe over any measurer, or a blind one when there is none. */
export function createFontProbe(ctx: InkMeasurer | null | undefined): FontProbe {
  const widthOf = (font: string): number => {
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(PROBE_TEXT).width;
  };
  const inFamily = (family: string, generic: string): number =>
    widthOf(`${PROBE_PX}px ${quoted(family)}, ${generic}`);

  const resolves = (family: string): boolean => {
    if (!ctx || family.trim() === "") return false;
    return PROBE_GENERICS.some(
      (generic) =>
        Math.abs(inFamily(family, generic) - inFamily(ABSENT_FAMILY, generic)) >
        INK_EPSILON
    );
  };

  const blindness = (): string | null => {
    if (!ctx) return "there is no canvas to measure with";
    // The generics are the platform's own faces and are never the same one
    // as each other. Measuring them alike is what a stub does, and it is
    // caught before the sentinel below, which such a stub would pass.
    const serif = widthOf(`${PROBE_PX}px serif`);
    const mono = widthOf(`${PROBE_PX}px monospace`);
    if (Math.abs(serif - mono) <= INK_EPSILON) {
      return "the generic families all measure the same width here";
    }
    if (resolves(CONTROL_ABSENT_FAMILY)) {
      return "a family name that cannot exist measured as present";
    }
    return null;
  };

  return {
    resolves,
    blindness,
    verdict: (family) => {
      if (blindness() !== null) return "unmeasurable";
      return resolves(family) ? "available" : "missing";
    },
  };
}

/**
 * The probe over a canvas of this document, built once per call.
 *
 * Cheap — an offscreen 2d context and a few `measureText` calls — and built
 * fresh rather than kept, so a page that was hidden (WKWebView can drop a
 * canvas backing store) does not go on answering from a dead context.
 */
export function documentFontProbe(): FontProbe {
  if (typeof document === "undefined") return createFontProbe(null);
  try {
    return createFontProbe(document.createElement("canvas").getContext("2d"));
  } catch {
    return createFontProbe(null);
  }
}

/** One family's verdict, through [`documentFontProbe`]. */
export function fontVerdict(family: string): FontVerdict {
  return documentFontProbe().verdict(family);
}

/**
 * The families in `list` this machine cannot draw with, in the order they
 * were written — or null when the machine could not be asked.
 *
 * Three answers and not two, because there are three states and the caller
 * has something different to say in each: some are missing, none are
 * missing, and "I could not tell", which must never be shown to anyone as
 * either of the first two.
 */
export function missingFamilies(list: readonly string[]): string[] | null {
  const probe = documentFontProbe();
  if (probe.blindness() !== null) return null;
  return list.filter((family) => !probe.resolves(family));
}
