const STEPS = ["Add business", "Generate page", "Add to website"] as const;

interface Props {
  current: 1 | 2 | 3;
}

export function StepIndicator({ current }: Props) {
  return (
    <div className="flex items-center">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} className="flex items-center flex-1 last:flex-none">
            <div
              className={`flex items-center gap-1.5 shrink-0 ${
                active
                  ? "text-foreground"
                  : done
                  ? "text-muted-foreground"
                  : "text-muted-foreground/35"
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  done
                    ? "bg-green-500 text-white"
                    : active
                    ? "bg-accent text-accent-foreground"
                    : "border-2 border-border"
                }`}
              >
                {done ? "✓" : n}
              </div>
              <span className="text-xs whitespace-nowrap">{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-3 ${done ? "bg-green-500/30" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
