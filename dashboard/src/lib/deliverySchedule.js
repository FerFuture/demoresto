export const ALL_WEEKDAY_VALUES = [0, 1, 2, 3, 4, 5, 6];

export const WEEKDAY_OPTIONS = [
  { value: 1, label: "Lun" },
  { value: 2, label: "Mar" },
  { value: 3, label: "Mié" },
  { value: 4, label: "Jue" },
  { value: 5, label: "Vie" },
  { value: 6, label: "Sáb" },
  { value: 0, label: "Dom" }
];

const DAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado"
];

export function deliveryMayLoginToday(weekdays) {
  if (weekdays == null) return true;
  if (!Array.isArray(weekdays) || weekdays.length === 0) return false;
  const today = new Date().getDay();
  return weekdays.includes(today);
}

export function formatAllowedWeekdaysSentence(weekdays) {
  if (weekdays == null) return "todos los días";
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    return "ninguno (cuenta sin días habilitados)";
  }
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  return sorted.map((d) => DAY_NAMES[d] ?? `día ${d}`).join(", ");
}

export function deliveryWeekdaysToDb(role, selectedSorted) {
  if (role !== "delivery") return null;
  const set = new Set(selectedSorted);
  if (set.size === 0) return [];
  if (ALL_WEEKDAY_VALUES.every((d) => set.has(d))) return null;
  return ALL_WEEKDAY_VALUES.filter((d) => set.has(d));
}

export function deliveryWeekdaysFromDb(dbValue) {
  if (dbValue == null || !Array.isArray(dbValue)) return [...ALL_WEEKDAY_VALUES];
  if (dbValue.length === 0) return [];
  return ALL_WEEKDAY_VALUES.filter((d) => dbValue.includes(d));
}
