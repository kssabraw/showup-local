import { useState, useRef, useEffect } from "react";
import { MapPin, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface LocationOption {
  name: string;
  code: number;
}

interface Props {
  value: string;         // the committed location string (validated)
  inputValue: string;   // the raw text input (may be unvalidated)
  onSelect: (loc: LocationOption) => void;
  onInputChange: (raw: string) => void;
  onClear: () => void;
  disabled?: boolean;
  label?: string;
}

export function LocationAutocomplete({
  value,
  inputValue,
  onSelect,
  onInputChange,
  onClear,
  disabled = false,
  label = "Area",
}: Props) {
  const [suggestions, setSuggestions] = useState<LocationOption[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleInput = (raw: string) => {
    onInputChange(raw);
    setShowSuggestions(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (raw.length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from("location")
          .select("location_name, location_code")
          .ilike("location_name", `%${raw}%`)
          .limit(8);
        setSuggestions(
          (data ?? []).map((r) => ({ name: r.location_name, code: r.location_code })),
        );
      } finally {
        setLoading(false);
      }
    }, 200);
  };

  const handleSelect = (loc: LocationOption) => {
    setSuggestions([]);
    setShowSuggestions(false);
    onSelect(loc);
  };

  return (
    <div className="space-y-2" ref={containerRef}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
        <input
          type="text"
          value={inputValue}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && suggestions.length > 0) handleSelect(suggestions[0]);
          }}
          disabled={disabled}
          placeholder="Search locations…"
          className={`w-full bg-background border rounded-lg pl-9 pr-8 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${
            value ? "border-green-500" : "border-input"
          }`}
        />
        {value && !disabled && (
          <button
            type="button"
            onMouseDown={onClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        )}
        {loading && !value && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        )}
        {showSuggestions && suggestions.length > 0 && (
          <ul className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-56 overflow-y-auto">
            {suggestions.map((loc) => (
              <li
                key={loc.code}
                onMouseDown={() => handleSelect(loc)}
                className="px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
              >
                {loc.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {inputValue && !value && (
        <p className="text-xs text-amber-500">Select a location from the dropdown to continue</p>
      )}
    </div>
  );
}
