import { useEffect, useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import { es } from "date-fns/locale";
import { format, isValid, parse } from "date-fns";

function parseLocalDateKey(key) {
  if (!key || typeof key !== "string") return undefined;
  const d = parse(key.trim(), "yyyy-MM-dd", new Date());
  return isValid(d) ? d : undefined;
}

export default function OrdersDateRangeCalendar({ dateFrom, dateTo, onRangeChange }) {
  const [monthsShown, setMonthsShown] = useState(1);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setMonthsShown(mq.matches ? 2 : 1);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const selected = useMemo(() => {
    const from = parseLocalDateKey(dateFrom);
    const to = parseLocalDateKey(dateTo);
    if (!from && !to) return undefined;
    return { from: from || undefined, to: to || undefined };
  }, [dateFrom, dateTo]);

  const defaultMonth = useMemo(() => {
    return selected?.from || selected?.to || new Date();
  }, [selected]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-300">Rango de fechas</span>
        <p className="text-xs text-slate-500">
          {dateFrom && dateTo ? (
            <>
              Desde{" "}
              <span className="font-medium text-slate-200">
                {format(parseLocalDateKey(dateFrom), "d MMM yyyy", { locale: es })}
              </span>{" "}
              hasta{" "}
              <span className="font-medium text-slate-200">
                {format(parseLocalDateKey(dateTo), "d MMM yyyy", { locale: es })}
              </span>
            </>
          ) : (
            "Elegí fechas en el calendario o usá los selectores de mes."
          )}
        </p>
      </div>
      <div
        className="orders-date-range-picker overflow-x-auto rounded-xl border border-slate-700 bg-slate-950/90 p-3 sm:p-4"
        style={{
          ["--rdp-accent-color"]: "rgb(52 211 153)",
          ["--rdp-accent-background-color"]: "rgba(52, 211, 153, 0.14)",
          ["--rdp-range_start-color"]: "rgb(15 23 42)",
          ["--rdp-range_end-color"]: "rgb(15 23 42)"
        }}
      >
        <DayPicker
          mode="range"
          locale={es}
          captionLayout="dropdown"
          fromYear={new Date().getFullYear() - 3}
          toYear={new Date().getFullYear() + 1}
          numberOfMonths={monthsShown}
          defaultMonth={defaultMonth}
          selected={selected}
          onSelect={(range) => {
            if (!range?.from) {
              onRangeChange("", "");
              return;
            }
            const fromStr = format(range.from, "yyyy-MM-dd");
            if (!range.to) {
              onRangeChange(fromStr, fromStr);
              return;
            }
            onRangeChange(fromStr, format(range.to, "yyyy-MM-dd"));
          }}
          classNames={{
            root: "mx-auto font-sans text-slate-100",
            months: "flex flex-wrap justify-center gap-6 sm:gap-8",
            month: "space-y-3",
            month_caption: "flex justify-center pt-1 text-sm font-medium text-slate-200",
            nav: "hidden",
            dropdowns:
              "flex w-full flex-wrap items-center justify-center gap-2 text-xs text-slate-200 [&_select]:rounded-md [&_select]:border [&_select]:border-slate-600 [&_select]:bg-slate-900 [&_select]:px-2 [&_select]:py-1",
            weekdays: "flex gap-1",
            weekday: "w-10 text-center text-[11px] font-medium uppercase text-slate-500",
            week: "mt-1 flex gap-1",
            day: "relative p-0 text-center",
            day_button:
              "inline-flex size-10 items-center justify-center rounded-full text-sm text-slate-100 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          }}
          modifiersClassNames={{
            today: "text-emerald-300"
          }}
        />
      </div>
      <button
        type="button"
        onClick={() => onRangeChange("", "")}
        className="text-xs text-slate-500 underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
      >
        Quitar filtro de fechas
      </button>
    </div>
  );
}
