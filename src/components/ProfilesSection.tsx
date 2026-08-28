import { useState } from "react";
import { confirmAsk } from "./Confirm";
import {
  describeError,
  errorText,
  type ErrorDescription,
} from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "./state/ErrorState";
import { PROFILES_SECTION_ID } from "./settingsSections";
import { useProfiles } from "./useProfiles";
import {
  profileRemove,
  profileSet,
  upsertProfile,
  type ConfigProfile,
} from "../state/config";

const P = STR.settings.profiles;

/** Whether there is a desktop core behind this page. Asked at render rather
 *  than at import, the way state/config.ts asks it: this module can be
 *  imported before the runtime is in place. */
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Draft {
  /**
   * The entry this draft is written over — the name it had when editing
   * started, which is not `name` once somebody renames it. A draft for a new
   * profile carries its own name here, which no entry has, and appending is
   * what `profileSet` then does.
   */
  target: string;
  /**
   * The profile as it was, kept whole so that saving CANNOT DROP A FIELD
   * THIS EDITOR DOES NOT OFFER.
   *
   * A profile is an entity with a growing set of fields — `font` arrived
   * with the per-profile font override, `ligatures` with the renderer
   * ruling — and an editor that rebuilt one from its own boxes would erase
   * every field added since it was written, silently, on the first edit of
   * an unrelated setting. The boxes below overwrite what they own; the rest
   * of the entry travels through untouched.
   */
  original: ConfigProfile | null;
  name: string;
  shell: string;
  cwd: string;
  env: string;
  badge: string;
  font: string;
  /** Empty follows the global setting; the other two are explicit overrides. */
  ligatures: "" | "on" | "off";
  runOnStart: string;
}

/** A draft holding what one profile currently says. */
function draftOf(profile: ConfigProfile): Draft {
  return {
    target: profile.name,
    original: profile,
    name: profile.name,
    shell: profile.shell ?? "",
    cwd: profile.cwd ?? "",
    env: Object.entries(profile.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    badge: profile.badge ?? "",
    font: profile.font ?? "",
    ligatures:
      profile.ligatures === true
        ? "on"
        : profile.ligatures === false
          ? "off"
          : "",
    runOnStart: profile.run_on_start ?? "",
  };
}

/** An empty draft — a profile that does not exist yet. */
function blankDraft(): Draft {
  return {
    target: "",
    original: null,
    name: "",
    shell: "",
    cwd: "",
    env: "",
    badge: "",
    font: "",
    ligatures: "",
    runOnStart: "",
  };
}

/**
 * The environment box, parsed — or the number of the line that is not a
 * `name=value` pair.
 *
 * Blank lines are skipped rather than refused: they are how people space a
 * list out, and rejecting them would make the box hostile to edit. The rule
 * itself (a name, an `=`, then anything including nothing) is this editor's
 * own, because the text form is this editor's own: the file holds a table,
 * and these lines exist only between the keyboard and that table.
 *
 * Both sides are trimmed, so `A = 1` and `A=1` are one pair. The one thing
 * that costs is an environment value with a deliberate space at its end,
 * which is not something a line-per-pair box can express at all — the file
 * itself is where that is written.
 */
export function parseEnv(
  text: string
): { env: Record<string, string> } | { badLine: number } {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const at = line.indexOf("=");
    if (at <= 0) return { badLine: i + 1 };
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { env };
}

/**
 * A draft as the file would hold it: blank boxes become absent fields, and
 * an empty environment becomes no environment at all.
 */
export function profileOf(draft: Draft, env: Record<string, string>): ConfigProfile {
  const set = (value: string) =>
    value.trim() === "" ? undefined : value.trim();
  return {
    // Everything the entry already said, then the boxes over the top of it:
    // see `Draft.original` for why the spread is the whole point.
    ...(draft.original ?? {}),
    name: draft.name.trim(),
    shell: set(draft.shell),
    cwd: set(draft.cwd),
    env: Object.keys(env).length === 0 ? undefined : env,
    badge: set(draft.badge),
    font: set(draft.font),
    // Three states, deliberately: absent follows `terminal.ligatures`; true
    // and false let this profile differ in either direction.
    ligatures:
      draft.ligatures === "" ? undefined : draft.ligatures === "on",
    // Not trimmed at the ends by `set`'s rule alone: a start command is
    // typed into a shell verbatim, so only the "nothing here" case is
    // special. Leading spaces a user typed on purpose survive.
    run_on_start: draft.runOnStart.trim() === "" ? undefined : draft.runOnStart,
  };
}

export function ProfilesSection() {
  const { list, reload } = useProfiles();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorDescription | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (profile: ConfigProfile) => {
    setRefusal(null);
    setFailure(null);
    setDraft(draftOf(profile));
  };

  const field = (key: keyof Draft, value: string) =>
    setDraft((d) => (d === null ? d : { ...d, [key]: value }));

  const save = async () => {
    if (draft === null) return;
    const parsed = parseEnv(draft.env);
    if ("badLine" in parsed) {
      setRefusal(P.envRefusal({ line: parsed.badLine }));
      return;
    }
    const next = profileOf(draft, parsed.env);
    // The verdict of the rule itself: blank names and clashing names come
    // back as the sentence the file format uses for them.
    try {
      upsertProfile(list, draft.target, next);
    } catch (e) {
      // `upsertProfile` throws the file format's own sentence, so a string
      // is shown as it stands; anything else goes through the one sanctioned
      // stringification rather than a `String(e)` of this component's own.
      setRefusal(typeof e === "string" ? e : errorText(e));
      return;
    }
    setRefusal(null);
    setBusy(true);
    try {
      // A new profile's target is its own name, which no entry has — so the
      // write appends. An edited one's target is the name it had, so a
      // rename moves nothing and loses no comment.
      await profileSet(draft.target === "" ? next.name : draft.target, next);
      setDraft(null);
      setFailure(null);
      reload();
    } catch (e) {
      setFailure(describeError(e, STR.errors.actions.saveProfile));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: ConfigProfile) => {
    if (
      !(await confirmAsk(P.removeQuestion({ name: profile.name }), {
        confirmLabel: P.remove,
      }))
    )
      return;
    try {
      await profileRemove(profile.name);
      if (draft?.target === profile.name) setDraft(null);
      setFailure(null);
      reload();
    } catch (e) {
      setFailure(describeError(e, STR.errors.actions.removeProfile));
    }
  };

  /** What a profile says, in one line — or that it says nothing but its name. */
  const summary = (profile: ConfigProfile): string => {
    const parts = [profile.shell, profile.cwd, profile.run_on_start].filter(
      (part): part is string => typeof part === "string" && part.trim() !== ""
    );
    const count = Object.keys(profile.env ?? {}).length;
    if (count > 0) parts.push(`${count}×env`);
    if (profile.ligatures === true) parts.push(P.summaryLigaturesOn);
    if (profile.ligatures === false) parts.push(P.summaryLigaturesOff);
    return parts.length === 0 ? P.summaryPlain : parts.join(" · ");
  };

  return (
    // The anchor id comes from the section list rather than a literal, on the
    // same terms as the user scripts section next to it.
    <section id={PROFILES_SECTION_ID}>
      <h3>{P.heading}</h3>
      <p>{P.blurb}</p>
      {!isTauri() && <p className="pw-empty">{P.demoNote}</p>}

      <div className="btn-row">
        <button
          className="btn"
          onClick={() => {
            setRefusal(null);
            setFailure(null);
            setDraft(blankDraft());
          }}
        >
          {P.add}
        </button>
      </div>

      {failure && <ErrorState inline error={failure} />}

      {list.length === 0 ? (
        <p className="pw-empty">{P.none}</p>
      ) : (
        <table className="pw-table">
          <tbody>
            {list.map((profile) => (
              <tr key={profile.name} data-profile={profile.name}>
                <td>
                  <strong>{profile.name}</strong>
                  <div className="pw-empty">{summary(profile)}</div>
                </td>
                <td>
                  <div className="btn-row">
                    <button className="btn" onClick={() => edit(profile)}>
                      {P.edit}
                    </button>
                    <button className="btn" onClick={() => void remove(profile)}>
                      {P.remove}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft !== null && (
        <div data-profile-editor="">
          <label htmlFor="profile-name">{P.name}</label>
          <input
            id="profile-name"
            className="settings-input"
            spellCheck={false}
            value={draft.name}
            onChange={(e) => field("name", e.target.value)}
          />

          <label htmlFor="profile-shell">{P.shell}</label>
          <input
            id="profile-shell"
            className="settings-input"
            spellCheck={false}
            placeholder={P.shellPlaceholder}
            value={draft.shell}
            onChange={(e) => field("shell", e.target.value)}
          />

          <label htmlFor="profile-cwd">{P.cwd}</label>
          <input
            id="profile-cwd"
            className="settings-input"
            spellCheck={false}
            placeholder={P.cwdPlaceholder}
            value={draft.cwd}
            onChange={(e) => field("cwd", e.target.value)}
          />

          <label htmlFor="profile-env">{P.env}</label>
          {/* The one control on this page that is several lines tall, so it
              takes the shared input's border, background and type and
              overrides only the height a one-line box fixes. */}
          <textarea
            id="profile-env"
            className="settings-input"
            style={{ height: "auto" }}
            spellCheck={false}
            rows={3}
            value={draft.env}
            onChange={(e) => field("env", e.target.value)}
          />
          <p className="pw-empty">{P.envHint}</p>

          <label htmlFor="profile-badge">{P.badge}</label>
          <input
            id="profile-badge"
            className="settings-input"
            spellCheck={false}
            value={draft.badge}
            onChange={(e) => field("badge", e.target.value)}
          />
          <p className="pw-empty">{P.badgeHint}</p>

          <label htmlFor="profile-font">{P.font}</label>
          <input
            id="profile-font"
            className="settings-input"
            spellCheck={false}
            value={draft.font}
            onChange={(e) => field("font", e.target.value)}
          />
          <p className="pw-empty">{P.fontHint}</p>

          <label htmlFor="profile-ligatures">{P.ligatures}</label>
          <select
            id="profile-ligatures"
            className="settings-input"
            value={draft.ligatures}
            onChange={(e) => field("ligatures", e.target.value)}
          >
            <option value="">{P.ligaturesFollow}</option>
            <option value="on">{P.ligaturesOn}</option>
            <option value="off">{P.ligaturesOff}</option>
          </select>
          <p className="pw-empty">{P.ligaturesHint}</p>

          <label htmlFor="profile-run">{P.runOnStart}</label>
          <input
            id="profile-run"
            className="settings-input"
            spellCheck={false}
            value={draft.runOnStart}
            onChange={(e) => field("runOnStart", e.target.value)}
          />
          <p className="pw-empty">{P.runOnStartHint}</p>

          {/* Said here, next to the boxes, and said before anything is
              written: a name that is blank or already taken never reaches
              the file, so there is nothing to undo when it is refused. */}
          {refusal !== null && (
            <div
              className="settings-banner danger"
              role="alert"
              data-profile-refusal=""
            >
              <p>{refusal}</p>
            </div>
          )}

          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => void save()}>
              {P.save}
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              {STR.common.cancel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
