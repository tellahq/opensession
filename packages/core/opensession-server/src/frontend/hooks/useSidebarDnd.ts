import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ASK_BAND } from "../lib/sidebar-workspaces";
import type {
  MineStatus,
  PersonalBandPinnedEntry,
  Props,
  WsRow,
} from "../lib/sidebar-types";
import type { UnifiedSession } from "../lib/types";
import {
  getPins,
  onPinsChanged,
  reorderPins,
  togglePin,
  unpin,
} from "../lib/pins";
import {
  getRepoOrder,
  onRepoOrderChanged,
  replaceVisibleRepoOrder,
  setRepoOrder,
} from "../lib/repo-order";

type PinDragMeta = {
  repo: string | null;
  sessions: UnifiedSession[];
  pinKeys: string[];
};

type LaneDropTarget = { gkey: string; lane: MineStatus };
type LaneDropRect = LaneDropTarget & { repo: string; rect: DOMRect };

type PinState = {
  pinned: boolean;
  toggle: () => void;
};

type UseSidebarDndOptions = {
  onSetStatus: Props["onSetStatus"];
};

export function useSidebarDnd({ onSetStatus }: UseSidebarDndOptions) {
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [savedRepoOrder, setSavedRepoOrder] = useState(getRepoOrder);
  useEffect(
    () => onRepoOrderChanged(() => setSavedRepoOrder(getRepoOrder())),
    [],
  );

  const [repoOrderDraft, setRepoOrderDraft] = useState<string[] | null>(null);
  const repoOrderAtDragStart = useRef<string[] | null>(null);
  const repoOrderPending = useRef<string[] | null>(null);
  const repoVisualOrder = useRef<string[] | null>(null);
  const repoDragging = useRef<string | null>(null);
  const [repoDragKey, setRepoDragKey] = useState<string | null>(null);
  const repoAutoScrollFrame = useRef<number | null>(null);
  const repoAutoScrollSpeed = useRef(0);
  const repoAutoScrollContainer = useRef<HTMLElement | null>(null);
  const repoJustDragged = useRef(false);

  const stopRepoAutoScroll = () => {
    if (repoAutoScrollFrame.current !== null)
      cancelAnimationFrame(repoAutoScrollFrame.current);
    repoAutoScrollFrame.current = null;
    repoAutoScrollSpeed.current = 0;
    repoAutoScrollContainer.current = null;
  };

  const tickRepoAutoScroll = () => {
    const container = repoAutoScrollContainer.current;
    if (!container || repoAutoScrollSpeed.current === 0) {
      repoAutoScrollFrame.current = null;
      return;
    }
    container.scrollTop += repoAutoScrollSpeed.current;
    repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
  };

  const handleRepoAutoScroll = (event: React.DragEvent<HTMLDivElement>) => {
    if (!repoDragging.current) return;
    event.preventDefault();
    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const edge = Math.min(96, rect.height * 0.18);
    const fromTop = event.clientY - rect.top;
    const fromBottom = rect.bottom - event.clientY;
    const maxSpeed = 18;
    let speed = 0;
    if (fromTop < edge)
      speed = -Math.ceil(maxSpeed * (1 - Math.max(0, fromTop) / edge));
    else if (fromBottom < edge)
      speed = Math.ceil(maxSpeed * (1 - Math.max(0, fromBottom) / edge));
    if (speed === 0) {
      stopRepoAutoScroll();
      return;
    }
    repoAutoScrollContainer.current = container;
    repoAutoScrollSpeed.current = speed;
    if (repoAutoScrollFrame.current === null)
      repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
  };

  useEffect(
    () => () => {
      if (repoAutoScrollFrame.current !== null)
        cancelAnimationFrame(repoAutoScrollFrame.current);
    },
    [],
  );

  const moveDraggedRepo = (
    targetRepo: string,
    order: string[],
    fullOrder: string[],
    event: React.DragEvent<HTMLDivElement>,
  ) => {
    const draggedRepo = repoDragging.current;
    if (!draggedRepo || targetRepo === ASK_BAND) return;
    event.preventDefault();
    if (draggedRepo === targetRepo) return;
    const visibleOrder = [
      ...(repoVisualOrder.current ?? order.filter((repo) => repo !== ASK_BAND)),
    ];
    const from = visibleOrder.indexOf(draggedRepo);
    if (from < 0) return;
    visibleOrder.splice(from, 1);
    let target = visibleOrder.indexOf(targetRepo);
    if (target < 0) return;
    const header = event.currentTarget.querySelector<HTMLElement>(
      ":scope > [data-sticky-head]",
    );
    const rect = (header ?? event.currentTarget).getBoundingClientRect();
    if (event.clientY > rect.top + rect.height / 2) target++;
    visibleOrder.splice(target, 0, draggedRepo);
    if (
      JSON.stringify(visibleOrder) === JSON.stringify(repoVisualOrder.current)
    )
      return;
    repoVisualOrder.current = visibleOrder;
    const baseline = repoOrderAtDragStart.current ?? fullOrder;
    const next = replaceVisibleRepoOrder(baseline, visibleOrder);
    repoOrderPending.current = next;
    setRepoOrderDraft(next);
  };

  const finishRepoDrag = (commit: boolean) => {
    stopRepoAutoScroll();
    repoJustDragged.current = true;
    setTimeout(() => {
      repoJustDragged.current = false;
    }, 0);
    repoOrderAtDragStart.current = null;
    repoVisualOrder.current = null;
    repoDragging.current = null;
    setRepoDragKey(null);
    const pending = repoOrderPending.current;
    repoOrderPending.current = null;
    setRepoOrderDraft(null);
    if (commit && pending) setRepoOrder(pending);
  };

  const startRepoDrag = (
    repo: string,
    fullOrder: string[],
    order: string[],
    event: React.DragEvent<HTMLButtonElement>,
  ) => {
    repoDragging.current = repo;
    setRepoDragKey(repo);
    repoOrderAtDragStart.current = [...fullOrder];
    repoOrderPending.current = null;
    repoVisualOrder.current = order.filter((item) => item !== ASK_BAND);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", repo);
  };

  const swallowRepoDragClick = (event: React.MouseEvent) => {
    if (!repoJustDragged.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const [pins, setPins] = useState<string[]>(getPins);

  const togglePinKey = (pinKey: string) => setPins(togglePin(pinKey));
  const togglePinnedKeys = (keys: string[]) => {
    let next = pins;
    for (const key of keys) next = togglePin(key);
    setPins(next);
  };

  const sessionPinState = (session: UnifiedSession): PinState => {
    const keys = [session.id, ...(session.aliasIds || [])].filter(
      (key, index, all) => pins.includes(key) && all.indexOf(key) === index,
    );
    const pinned = keys.length > 0;
    const toggle = () => {
      if (pinned) togglePinnedKeys(keys);
      else togglePinKey(session.id);
    };
    return { pinned, toggle };
  };

  const workspacePinState = (row: WsRow): PinState => {
    const pinKey = row.workspace ? `workspace:${row.workspace.id}` : row.key;
    const keys = [
      pinKey,
      row.key,
      ...row.sessions.flatMap((session) => [
        session.id,
        ...(session.aliasIds || []),
      ]),
    ].filter(
      (key, index, all) => pins.includes(key) && all.indexOf(key) === index,
    );
    const pinned = keys.length > 0;
    const toggle = () => {
      if (pinned) togglePinnedKeys(keys);
      else togglePinKey(pinKey);
    };
    return { pinned, toggle };
  };

  // Drag-to-reorder in the Pinned band. onReorder fires continuously during a
  // drag, so the in-flight order lives in local state and only commits to the
  // pins store on drop. pinDragKey marks the floating row; pinJustDragged
  // swallows the click that lands on the row right after a drop.
  const [pinOrderDraft, setPinOrderDraft] = useState<string[] | null>(null);
  const pinOrderPending = useRef<string[] | null>(null);
  const [pinDragKey, setPinDragKey] = useState<string | null>(null);
  const pinJustDragged = useRef(false);
  // While a Pinned row is mid-drag, the status lanes below double as drop
  // targets. The ref twins keep drag-end from reading a stale closure
  // mid-batch; per-repo targets accept only rows from their own repo.
  const [pinDragMeta, setPinDragMeta] = useState<PinDragMeta | null>(null);
  const pinDragMetaRef = useRef<PinDragMeta | null>(null);
  const [laneDropHover, setLaneDropHover] = useState<LaneDropTarget | null>(
    null,
  );
  const laneDropHoverRef = useRef<LaneDropTarget | null>(null);
  // Cache lane geometry for each stable layout. Motion transforms the dragged
  // row on every pointer frame, so measuring every target in the move handler
  // would force repeated layout. Geometric hit-testing is necessary because
  // the dragged row sits under the pointer and defeats elementFromPoint.
  const laneDropRectsRef = useRef<LaneDropRect[] | null>(null);

  const measureLaneDropTargets = () => {
    const targets =
      sidebarScrollRef.current?.querySelectorAll<HTMLElement>(
        "[data-lane-drop]",
      ) ?? [];
    const rects: LaneDropRect[] = [];
    for (const element of targets)
      rects.push({
        gkey: element.dataset.laneDrop!,
        lane: element.dataset.laneStatus as MineStatus,
        repo: element.dataset.laneRepo || "",
        rect: element.getBoundingClientRect(),
      });
    laneDropRectsRef.current = rects;
  };

  const updateLaneDropHover = (clientX: number, clientY: number) => {
    const meta = pinDragMetaRef.current;
    let next: LaneDropTarget | null = null;
    if (meta && meta.sessions.length > 0) {
      // Null only when a pointer move beats the snapshot effect below or the
      // rail changed after its previous measurement.
      if (!laneDropRectsRef.current) measureLaneDropTargets();
      for (const target of laneDropRectsRef.current ?? []) {
        const rect = target.rect;
        const inside =
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom;
        if (!inside) continue;
        if (target.repo && target.repo !== meta.repo) continue;
        next = { gkey: target.gkey, lane: target.lane };
        break;
      }
    }
    if (laneDropHoverRef.current?.gkey !== next?.gkey) {
      laneDropHoverRef.current = next;
      setLaneDropHover(next);
    }
  };

  // Empty lane targets materialize only after pinDragMeta renders, so take the
  // first geometry snapshot after that commit. Scrolling, resizing, or a row
  // update can move targets under a live drag and invalidates the cache.
  useEffect(() => {
    if (!pinDragMeta || pinDragMeta.sessions.length === 0) {
      laneDropRectsRef.current = null;
      return;
    }
    measureLaneDropTargets();
    const root = sidebarScrollRef.current;
    // Drop the snapshot instead of rebuilding it for every observer event. The
    // next pointer move pays for one measurement after a burst of changes.
    const invalidate = () => {
      laneDropRectsRef.current = null;
    };
    root?.addEventListener("scroll", invalidate, { passive: true });
    window.addEventListener("resize", invalidate);
    const rowObserver = new MutationObserver(invalidate);
    if (root) rowObserver.observe(root, { childList: true, subtree: true });
    return () => {
      root?.removeEventListener("scroll", invalidate);
      window.removeEventListener("resize", invalidate);
      rowObserver.disconnect();
      laneDropRectsRef.current = null;
    };
  }, [pinDragMeta]);

  useEffect(() => onPinsChanged(() => setPins(getPins())), []);

  const createPinnedDrag = (
    entries: PersonalBandPinnedEntry[],
    isPhone: boolean,
  ) => {
    const entryMap = new Map(
      entries.map((entry) => [entry.key, entry] as const),
    );
    const commitPinReorder = () => {
      setPinDragKey(null);
      pinJustDragged.current = true;
      // The drop's click fires synchronously after pointerup. Clear the flag
      // right after so it swallows only that click, not the next real one.
      setTimeout(() => {
        pinJustDragged.current = false;
      }, 0);
      const laneDrop = laneDropHoverRef.current;
      const dragMeta = pinDragMetaRef.current;
      pinDragMetaRef.current = null;
      setPinDragMeta(null);
      laneDropHoverRef.current = null;
      setLaneDropHover(null);
      // A lane drop wins over list reorder. Moving out of Pinned clears every
      // represented key before assigning the row's sessions to the lane; this
      // is deliberately a move, unlike Set status, which keeps the pin.
      if (laneDrop && dragMeta && dragMeta.sessions.length > 0) {
        pinOrderPending.current = null;
        setPinOrderDraft(null);
        setPins(unpin(dragMeta.pinKeys));
        onSetStatus(dragMeta.sessions, laneDrop.lane);
        return;
      }
      const orderKeys = pinOrderPending.current;
      pinOrderPending.current = null;
      setPinOrderDraft(null);
      if (!orderKeys) return;
      // Rewrite only slots occupied by visible entries. Pins filtered from
      // the band by archive, repo, or review state keep their exact positions
      // instead of being moved to the end.
      const flat = orderKeys.flatMap((key) => entryMap.get(key)?.pinKeys ?? []);
      const visible = new Set(flat);
      const queue = [...flat];
      setPins(
        reorderPins(
          pins.map((pin) => (visible.has(pin) ? (queue.shift() ?? pin) : pin)),
        ),
      );
    };

    return {
      // Whole-row y-drag fights touch scrolling and swipe gestures, so reorder
      // is desktop-only. Keep one row draggable because it can move to a lane.
      canDrag: !isPhone && entries.length > 0,
      dragKey: pinDragKey,
      onReorder: (keys: string[]) => {
        pinOrderPending.current = keys;
        setPinOrderDraft(keys);
      },
      onEntryDragStart: (entry: PersonalBandPinnedEntry) => {
        setPinDragKey(entry.key);
        const meta = {
          repo: entry.repo,
          sessions: entry.sessions,
          pinKeys: entry.pinKeys,
        };
        pinDragMetaRef.current = meta;
        setPinDragMeta(meta);
      },
      onEntryDrag: (event: MouseEvent | TouchEvent | PointerEvent) => {
        if ("clientX" in event)
          updateLaneDropHover(event.clientX, event.clientY);
      },
      onEntryDragEnd: commitPinReorder,
      onEntryClickCapture: (event: React.MouseEvent) => {
        if (!pinJustDragged.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  };

  return {
    sidebarScrollRef,
    savedRepoOrder,
    repoOrderDraft,
    repoDrag: {
      repoKey: repoDragKey,
      move: moveDraggedRepo,
      start: startRepoDrag,
      finish: finishRepoDrag,
      swallowClick: swallowRepoDragClick,
    },
    handleRepoAutoScroll,
    stopRepoAutoScroll,
    pins,
    replacePins: setPins,
    pinOrderDraft,
    pinDragMeta,
    laneDropHover,
    sessionPinState,
    workspacePinState,
    togglePinKey,
    togglePinnedKeys,
    createPinnedDrag,
  };
}
