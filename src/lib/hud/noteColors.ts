/** PT4's note colour labels, by `notes.id_color` (0 = none). */
export const NOTE_COLORS: { id: number; name: string; hex: string }[] = [
  { id: 1, name: "Yellow", hex: "#facc15" },
  { id: 2, name: "Green", hex: "#22c55e" },
  { id: 3, name: "Cyan", hex: "#06b6d4" },
  { id: 4, name: "Blue", hex: "#3b82f6" },
  { id: 5, name: "Indigo", hex: "#6366f1" },
  { id: 6, name: "Purple", hex: "#a855f7" },
  { id: 7, name: "Red", hex: "#ef4444" },
  { id: 8, name: "Orange", hex: "#f97316" },
];

export function noteColor(id: number) {
  return NOTE_COLORS.find((c) => c.id === id);
}
