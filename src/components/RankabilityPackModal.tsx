import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MapPin, X } from "lucide-react";

export const RANKABILITY_PACKS = [
  {
    id: "5" as const,
    checks: 5,
    price_cents: 500,
    label: "$5.00",
    per_check: "$1.00 / check",
    badge: null,
  },
  {
    id: "10" as const,
    checks: 10,
    price_cents: 800,
    label: "$8.00",
    per_check: "$0.80 / check",
    badge: "20% off",
  },
  {
    id: "20" as const,
    checks: 20,
    price_cents: 1400,
    label: "$14.00",
    per_check: "$0.70 / check",
    badge: "Best value",
  },
] as const;

export type PackId = typeof RANKABILITY_PACKS[number]["id"];

interface Props {
  onClose: () => void;
  /** Called with the selected pack — stub until Stripe is wired up */
  onPurchase: (pack: typeof RANKABILITY_PACKS[number]) => Promise<void>;
}

export default function RankabilityPackModal({ onClose, onPurchase }: Props) {
  const [selected, setSelected] = useState<PackId | null>(null);
  const [loading, setLoading] = useState(false);

  const handleBuy = async () => {
    const pack = RANKABILITY_PACKS.find(p => p.id === selected);
    if (!pack) return;
    setLoading(true);
    try {
      await onPurchase(pack);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-sm rounded-xl bg-background border shadow-xl p-6 space-y-5">
        {/* Header */}
        <button
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-primary" />
          <h2 className="font-semibold text-base">Buy More Map Pack Checks</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          You've used all your checks for this month. Purchased checks never expire and roll over month to month.
        </p>

        {/* Pack cards */}
        <div className="space-y-2">
          {RANKABILITY_PACKS.map(pack => (
            <button
              key={pack.id}
              onClick={() => setSelected(pack.id)}
              className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                selected === pack.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/40"
              }`}
            >
              <div>
                <span className="font-semibold text-sm">{pack.checks} checks</span>
                {pack.badge && (
                  <span className="ml-2 text-xs font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                    {pack.badge}
                  </span>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">{pack.per_check}</p>
              </div>
              <span className="text-base font-bold">{pack.label}</span>
            </button>
          ))}
        </div>

        {/* CTA */}
        <Button
          className="w-full"
          disabled={!selected || loading}
          onClick={handleBuy}
        >
          {loading ? "Processing…" : selected ? `Buy ${RANKABILITY_PACKS.find(p => p.id === selected)?.checks} checks` : "Select a pack"}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Secure payment via Stripe
        </p>
      </div>
    </div>
  );
}
