import {
  MapPin,
  Phone,
  Globe,
  Star,
  Tag,
  Clock,
  MessageSquare,
  CheckCircle2,
  RotateCcw,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BusinessDetails } from "@/components/BusinessSearchView";

interface GBPConfirmationProps {
  business: BusinessDetails;
  onConfirm: () => void;
  onSearchAgain: () => void;
}

const InfoRow = ({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) => {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground break-words">{value}</p>
      </div>
    </div>
  );
};

const GBPConfirmation = ({ business, onConfirm, onSearchAgain }: GBPConfirmationProps) => {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">
          Confirm Your Business
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Make sure these details match your Google Business Profile.
        </p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        {/* Business Name + Logo + Rating Header */}
        <div className="flex items-start gap-4">
          {(business.logo || business.photo) && (
            <img
              src={business.logo || business.photo}
              alt={`${business.name} logo`}
              className="w-14 h-14 rounded-lg object-cover border border-border flex-shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-lg font-display font-bold text-foreground">
                {business.name}
              </h2>
              {business.rating != null && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <Star className="w-4 h-4 text-warning fill-warning" />
                  <span className="text-sm font-semibold text-foreground">
                    {business.rating}
                  </span>
                  {business.review_count != null && (
                    <span className="text-xs text-muted-foreground">
                      ({business.review_count})
                    </span>
                  )}
                </div>
              )}
            </div>
            {business.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {business.description}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <InfoRow icon={MapPin} label="Address" value={business.address} />
          <InfoRow icon={Phone} label="Phone" value={business.phone} />
          <InfoRow icon={Globe} label="Website" value={business.website} />
          <InfoRow icon={Tag} label="Primary Category" value={business.category} />
          {business.categories && business.categories.length > 0 && (
            <div className="flex items-start gap-3">
              <Tag className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Additional Categories</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {business.categories.map((cat, i) => (
                    <span
                      key={i}
                      className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded-md"
                    >
                      {cat}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Hours */}
        {business.hours && business.hours.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Business Hours</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-6">
              {business.hours.map((h, i) => (
                <p key={i} className="text-xs text-foreground">
                  {h}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={onSearchAgain}
          className="flex-1"
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          Search Again
        </Button>
        <Button
          onClick={onConfirm}
          className="flex-1 bg-accent text-accent-foreground hover:opacity-90"
        >
          <CheckCircle2 className="w-4 h-4 mr-2" />
          Confirm & Continue
        </Button>
      </div>
    </div>
  );
};

export default GBPConfirmation;
