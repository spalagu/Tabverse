import { type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { layout, splitRects, type PaneRect } from "../paneTree";
import { useStore, type Tab } from "../state/store";
import { STR } from "../strings";
import { TerminalView } from "./TerminalView";

const SEAM = 3;
const EDGE_EPS = 1e-6;

function paneRectStyle(rect: PaneRect): CSSProperties {
  const padL = rect.x > EDGE_EPS ? SEAM : 0;
  const padT = rect.y > EDGE_EPS ? SEAM : 0;
  const padR = rect.x + rect.w < 1 - EDGE_EPS ? SEAM : 0;
  const padB = rect.y + rect.h < 1 - EDGE_EPS ? SEAM : 0;
  return {
    position: "absolute",
    left: `calc(${rect.x * 100}% + ${padL}px)`,
    top: `calc(${rect.y * 100}% + ${padT}px)`,
    width: `calc(${rect.w * 100}% - ${padL + padR}px)`,
    height: `calc(${rect.h * 100}% - ${padT + padB}px)`,
  };
}

function TerminalDivider({
  vertical,
  style,
  onMove,
  onDrop,
}: {
  readonly vertical: boolean;
  readonly style: CSSProperties;
  readonly onMove: (position: number) => void;
  readonly onDrop: (position: number) => void;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const strip = event.currentTarget;
    const surface = strip.parentElement;
    if (surface === null) return;
    strip.setPointerCapture(event.pointerId);
    let frame = 0;
    let pending: number | null = null;
    const positionAt = (pointer: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      return vertical
        ? (pointer.clientY - rect.top) / Math.max(1, rect.height)
        : (pointer.clientX - rect.left) / Math.max(1, rect.width);
    };
    const move = (pointer: PointerEvent) => {
      pending = positionAt(pointer);
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (pending !== null) onMove(pending);
        });
      }
    };
    const finish = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cancelAnimationFrame(frame);
      onDrop(positionAt(pointer));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  return (
    <div
      className={`split-divider${vertical ? " vertical" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      title={STR.common.dragResizeSplit}
    />
  );
}

export function TerminalPanes({
  tab,
  active,
  residentRuntimeId,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly residentRuntimeId?: string;
}) {
  const rects: PaneRect[] = tab.panes
    ? layout(tab.panes)
    : [{ id: tab.id, x: 0, y: 0, w: 1, h: 1 }];
  const zoomed =
    tab.zoomedPaneId !== undefined && rects.some((rect) => rect.id === tab.zoomedPaneId)
      ? tab.zoomedPaneId
      : null;
  const focusId = tab.activePaneId ?? rects[0]?.id;
  const seams = tab.panes && zoomed === null ? splitRects(tab.panes) : [];
  const setPaneRatio = useStore((state) => state.setPaneRatio);
  return (
    <div className="term-panes" style={{ position: "absolute", inset: 0 }}>
      {rects.map((rect) => {
        const shown = zoomed === null || zoomed === rect.id;
        const box = zoomed === rect.id ? { ...rect, x: 0, y: 0, w: 1, h: 1 } : rect;
        return (
          <div
            key={rect.id}
            className={`term-pane-slot${shown ? "" : " pane-hidden"}`}
            style={paneRectStyle(box)}
            data-pane-id={rect.id}
          >
            <TerminalView
              tab={tab}
              active={active}
              paneId={tab.panes ? rect.id : undefined}
              residentRuntimeId={residentRuntimeId}
            />
          </div>
        );
      })}
      {rects.length > 1 && focusId !== undefined && (
        <div
          className="split-focus-ring"
          style={paneRectStyle(
            zoomed !== null
              ? { id: focusId, x: 0, y: 0, w: 1, h: 1 }
              : (rects.find((rect) => rect.id === focusId) ?? rects[0]),
          )}
          aria-hidden
        />
      )}
      {seams.flatMap(({ node, rect }) =>
        node.children.slice(0, -1).map((_, index) => {
          const share =
            node.ratios.slice(0, index + 1).reduce((sum, value) => sum + value, 0) /
            node.ratios.reduce((sum, value) => sum + value, 0);
          const at = node.vertical ? rect.y + share * rect.h : rect.x + share * rect.w;
          const style: CSSProperties = node.vertical
            ? {
                top: `calc(${at * 100}% - ${SEAM}px)`,
                left: `${rect.x * 100}%`,
                right: "auto",
                width: `${rect.w * 100}%`,
              }
            : {
                left: `calc(${at * 100}% - ${SEAM}px)`,
                top: `${rect.y * 100}%`,
                bottom: "auto",
                height: `${rect.h * 100}%`,
              };
          const within = (position: number) =>
            node.vertical
              ? (position - rect.y) / Math.max(rect.h, EDGE_EPS)
              : (position - rect.x) / Math.max(rect.w, EDGE_EPS);
          return (
            <TerminalDivider
              key={`${node.id}-${index}`}
              vertical={node.vertical}
              style={style}
              onMove={(position) => setPaneRatio(tab.id, node.id, index, within(position))}
              onDrop={(position) => setPaneRatio(tab.id, node.id, index, within(position), true)}
            />
          );
        }),
      )}
    </div>
  );
}
