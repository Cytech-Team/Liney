import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Message } from "../data/mock";

export type TimelineRooms = Record<string, Message[]>;
export type TimelineUpdate = TimelineRooms | ((current: TimelineRooms) => TimelineRooms);

type TimelineState = {
  rooms: TimelineRooms;
};

export const timelineStore = createStore<TimelineState>(() => ({
  rooms: {},
}));

export function getTimelineRooms(): TimelineRooms {
  return timelineStore.getState().rooms;
}

export function getTimelineRoom(chatId: string): Message[] | undefined {
  return timelineStore.getState().rooms[chatId];
}

export function setTimelineRooms(update: TimelineUpdate): void {
  timelineStore.setState((state) => {
    const next = typeof update === "function" ? update(state.rooms) : update;
    return next === state.rooms ? state : { rooms: next };
  });
}

export function clearTimeline(): void {
  const current = timelineStore.getState().rooms;
  if (Object.keys(current).length === 0) return;
  timelineStore.setState({ rooms: {} });
}

export function replaceTimelineRoom(chatId: string, messages: Message[]): void {
  timelineStore.setState((state) => {
    if (state.rooms[chatId] === messages) return state;
    return { rooms: { ...state.rooms, [chatId]: messages } };
  });
}

export function updateTimelineRoom(
  chatId: string,
  updater: (messages: Message[]) => Message[],
): void {
  timelineStore.setState((state) => {
    const current = state.rooms[chatId] ?? [];
    const next = updater(current);
    if (next === current) return state;
    return { rooms: { ...state.rooms, [chatId]: next } };
  });
}

export function useTimelineRoom(chatId: string): Message[] | undefined {
  return useStore(timelineStore, (state) => state.rooms[chatId]);
}

export function compactTimelineRooms(
  activeChatId: string,
  maxRooms: number,
  activeLimit: number,
  backgroundLimit: number,
): void {
  timelineStore.setState((state) => {
    const keys = Object.keys(state.rooms);
    if (keys.length === 0) return state;

    const keep: string[] = [];
    if (activeChatId && state.rooms[activeChatId]) keep.push(activeChatId);
    for (let index = keys.length - 1; index >= 0 && keep.length < maxRooms; index -= 1) {
      const key = keys[index];
      if (!keep.includes(key)) keep.push(key);
    }

    let changed = keep.length !== keys.length;
    const next: TimelineRooms = {};
    for (const key of keep) {
      const current = state.rooms[key];
      const max = key === activeChatId ? activeLimit : backgroundLimit;
      const trimmed = current.length > max ? current.slice(-max) : current;
      if (trimmed !== current) changed = true;
      next[key] = trimmed;
    }
    return changed ? { rooms: next } : state;
  });
}
