import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Newspaper, X } from "lucide-react";

export const PR_PACKS = [
  {
    id: "1" as const,
    quantity: 1,
    price_cents: 6000,
    label: "$60",
    per_unit: "$60 / press release",
    badge: null,
  },
  {
    id: "3" as const,
    quantity: 3,
    price_cents: 15900,
    label: "$159",
    per_unit: "$53 / press release",
    badge: "Best value",
  },
] as const;

export type PRPackId = typeof PR_PACKS[number]["id"];

interface Props {
  onClose: () => void;
  onPurchase: (pack: typeof PR_PACKS[number]) => Promise<void>;
}

export default function PressReleasePackModal({ onClose, onPurchase }: Props) {
  const [selected, setSelected] = useState<PRPackId | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedPack = PR_PACKS.find((p) => p.id === selected);

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
          <Newspaper className="w-5 h-5 text-primary" />
          <h2 className="font-semibold text-base">Press Release Syndication</h2>
        </div>

        <p className="text-xs text-muted-foreground">
          Each press release is professionally syndicated across news outlets. Credits never
          expire — use them any time.
        </p>

        <div className="space-y-2">
          {PR_PACKS.map((pack) => (
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
                  <span className="font-semibold text-sm">
                    {pack.quantity} press release{pack.quantity > 1 ? "s" : ""}
                  </span>
                  {pack.badge && (
                    <span className="text-xs font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                      {pack.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{pack.per_unit}</p>
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
              ? `Buy ${selectedPack.quantity === 1 ? "1 press release" : `${selectedPack.quantity} press releases`} for ${selectedPack.label}`
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
