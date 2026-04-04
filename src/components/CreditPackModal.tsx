import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";

export const CREDIT_PACKS = [
  {
    id: "25" as const,
    credits: 25,
    price_cents: 1500,
    label: "$15",
    per_credit: "$0.60 / credit",
    per_workflow: "~$1.80 / page",
    badge: null,
  },
  {
    id: "60" as const,
    credits: 60,
    price_cents: 3500,
    label: "$35",
    per_credit: "$0.58 / credit",
    per_workflow: "~$1.75 / page",
    badge: "Popular",
  },
  {
    id: "150" as const,
    credits: 150,
    price_cents: 8200,
    label: "$82",
    per_credit: "$0.55 / credit",
    per_workflow: "~$1.65 / page",
    badge: "Best value",
  },
] as const;

export type CreditPackId = typeof CREDIT_PACKS[number]["id"];

interface Props {
  onClose: () => void;
  onPurchase: (pack: typeof CREDIT_PACKS[number]) => Promise<void>;
}

export default function CreditPackModal({ onClose, onPurchase }: Props) {
  const [selected, setSelected] = useState<CreditPackId | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedPack = CREDIT_PACKS.find(p => p.id === selected);

  const handleBuy = async () => {
    if (!selectedPack) return;
    setLoading(true);
    try {
      await onPurchase(selectedPack);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-sm rounded-xl bg-background border shadow-xl p-6 space-y-5">
        <button
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="font-semibold text-base">Buy More Credits</h2>
        </div>

        <p className="text-xs text-muted-foreground">
          Purchased credits never expire and are used after your monthly allocation runs out.
          Your subscription renews at 60 credits on the 1st.
        </p>

        <div className="space-y-2">
          {CREDIT_PACKS.map(pack => (
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
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{pack.credits} credits</span>
                  {pack.badge && (
                    <span className="text-xs font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                      {pack.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {pack.per_credit} · {pack.per_workflow}
                </p>
              </div>
              <span className="text-base font-bold">{pack.label}</span>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={!selected || loading}
            onClick={handleBuy}
          >
            {loading
              ? "Processing…"
              : selectedPack
                ? `Buy ${selectedPack.credits} credits for ${selectedPack.label}`
                : "Select a pack"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Secure payment via Stripe · Credits added instantly after payment
          </p>
        </div>
      </div>
    </div>
  );
}
