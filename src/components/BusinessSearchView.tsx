import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Building2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import GBPConfirmation from "@/components/GBPConfirmation";

interface PlaceSuggestion {
  place_id: string;
  name: string;
  address: string;
  description: string;
}

export interface BusinessDetails {
  place_id: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  website: string;
  logo: string;
  photo: string;
  category: string;
  categories: string[];
  types: string[];
  rating: number | null;
  review_count: number | null;
  latitude: number | null;
  longitude: number | null;
  hours: string[] | null;
  google_maps_uri: string | null;
}

interface BusinessSearchViewProps {
  onConfirm: (business: BusinessDetails) => void;
  onBack: () => void;
}

const BusinessSearchView = ({ onConfirm, onBack }: BusinessSearchViewProps) => {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [selectedBusiness, setSelectedBusiness] = useState<BusinessDetails | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const searchPlaces = useCallback(async (input: string) => {
    if (input.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-places", {
        body: { action: "autocomplete", input },
      });
      if (error) throw error;
      setSuggestions(data.suggestions || []);
      setShowDropdown(true);
    } catch (err) {
      console.error("Autocomplete error:", err);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (value: string) => {
    setQuery(value);
    setSelectedBusiness(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchPlaces(value), 300);
  };

  const handleSelect = async (suggestion: PlaceSuggestion) => {
    setShowDropdown(false);
    setQuery(suggestion.name);
    setDetailsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-places", {
        body: { action: "details", place_id: suggestion.place_id },
      });
      if (error) throw error;
      setSelectedBusiness(data.details);
    } catch (err) {
      console.error("Details error:", err);
    } finally {
      setDetailsLoading(false);
    }
  };

  const handleSearchAgain = () => {
    setSelectedBusiness(null);
    setQuery("");
    setSuggestions([]);
  };

  if (selectedBusiness) {
    return (
      <GBPConfirmation
        business={selectedBusiness}
        onConfirm={() => onConfirm(selectedBusiness)}
        onSearchAgain={handleSearchAgain}
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          ← Back to Dashboard
        </button>
        <h1 className="text-2xl font-display font-bold text-foreground">
          Find Your Business
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Search for your Google Business Profile to get started.
        </p>
      </div>

      <div
        ref={wrapperRef}
        className="bg-card rounded-xl border border-border p-6 space-y-4"
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setShowDropdown(true)}
            placeholder="Search your business name..."
            className="pl-9 pr-9"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
          )}
        </div>

        {showDropdown && suggestions.length > 0 && (
          <div className="border border-border rounded-lg bg-popover shadow-md overflow-hidden">
            {suggestions.map((s) => (
              <button
                key={s.place_id}
                onClick={() => handleSelect(s)}
                className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
              >
                <Building2 className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {s.name}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.address}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {query.length >= 2 && !loading && suggestions.length === 0 && showDropdown && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No businesses found. Try a different search term.
          </p>
        )}

        {detailsLoading && (
          <div className="flex items-center justify-center gap-2 py-8">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
            <span className="text-sm text-muted-foreground">
              Loading business details...
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default BusinessSearchView;
