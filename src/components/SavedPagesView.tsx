import { useState } from "react";
import { BookMarked } from "lucide-react";
import { SavedPagesList } from "@/components/SavedPagesList";
import GeneratedPageView from "@/components/GeneratedPageView";
import { useBusinessProfiles } from "@/hooks/useBusinessProfiles";
import type { SavedPage } from "@/hooks/useSavedPages";
import type { ContentGap } from "@/lib/nlp-types";

type ViewingPage = SavedPage & { businessName: string; website?: string; gbpCategory: string; address: string; phone?: string };

export default function SavedPagesView() {
  const { data: businesses = [] } = useBusinessProfiles();
  const [viewing, setViewing] = useState<ViewingPage | null>(null);

  const handleOpen = (page: SavedPage) => {
    const b = businesses.find(b => b.id === page.business_id);
    setViewing({
      ...page,
      businessName: b?.business_name ?? "",
      website: b?.website ?? undefined,
      gbpCategory: b?.gbp_category ?? "",
      address: b?.address ?? "",
      phone: b?.phone ?? undefined,
    });
  };

  if (viewing) {
    const b = businesses.find(b => b.id === viewing.business_id);
    return (
      <GeneratedPageView
        keyword={viewing.keyword}
        location={viewing.location}
        mode={viewing.mode as "generate" | "reoptimize"}
        isNew={false}
        contentHtml={viewing.content_html}
        schemaJson={viewing.schema_json ?? ""}
        pageTitle={viewing.page_title ?? ""}
        contentGaps={(viewing.content_gaps as ContentGap[] | null) ?? []}
        tokenUsage={{}}
        costBreakdown={{}}
        businessId={viewing.business_id ?? ""}
        businessName={viewing.businessName}
        website={viewing.website}
        gbpCategory={viewing.gbpCategory}
        address={viewing.address}
        phone={viewing.phone}
        initialScore={viewing.composite_score ?? null}
        savedPageId={viewing.id}
        initialSocialPosts={(viewing.social_posts as { gbp: string[] } | null) ?? null}
        differentiators={b?.differentiators as unknown[] | undefined}
        detected_icp={b?.detected_icp}
        onBack={() => setViewing(null)}
        onNewPage={() => setViewing(null)}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
          <BookMarked className="w-6 h-6 text-accent" />
          Saved Pages
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          All your generated local SEO pages in one place.
        </p>
      </div>

      <SavedPagesList
        businesses={businesses.map(b => ({ id: b.id, business_name: b.business_name }))}
        onOpen={handleOpen}
      />
    </div>
  );
}
