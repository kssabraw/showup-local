"""
url_filter.py — Broad pre-filter for business website URLs.

Drops URLs that are clearly NOT service/location pages before sending
the remainder to an AI classifier. Three categories of drops:

  1. JUNK      — admin, legal, auth, feeds, media files
  2. EDITORIAL — blog prefixes, news, resources, guides
  3. BLOG SLUG — slug-level signals: numbers, gerunds, question words,
                 articles, contractions, negative-framing words, etc.

Usage:
    python url_filter.py urls.txt          # one URL per line
    python url_filter.py urls.txt --debug  # show drop reasons
    cat urls.txt | python url_filter.py -  # stdin
"""

import re
import sys
import urllib.parse
from typing import Tuple

# ── 1. Junk / admin / legal / media ──────────────────────────────────────────
JUNK_SEGMENTS = {
    # Auth & admin
    'login', 'logout', 'register', 'signup', 'sign-up', 'sign-in',
    'admin', 'dashboard', 'portal', 'wp-admin', 'wp-json', 'wp-content',
    'account', 'profile', 'my-account',
    # Legal / policy
    'privacy', 'privacy-policy', 'terms', 'terms-of-service', 'terms-of-use',
    'disclaimer', 'accessibility', 'cookie-policy', 'gdpr', 'legal',
    'refund', 'refund-policy', 'shipping', 'returns',
    # Navigation / utility
    'sitemap', 'search', 'rss', 'feed', 'feeds', 'cdn',
    'cart', 'checkout', 'basket', 'wishlist',
    'tag', 'tags', 'category', 'categories', 'archive', 'archives',
    'author', 'authors', 'page',
    # Careers
    'careers', 'jobs', 'job', 'hiring', 'work-with-us', 'work-for-us',
    'join-us', 'join-our-team', 'open-positions',
}

# ── 2. Editorial section prefixes ────────────────────────────────────────────
EDITORIAL_SEGMENTS = {
    'blog', 'blogs', 'news', 'newsroom', 'press', 'press-room',
    'articles', 'article', 'post', 'posts',
    'insights', 'insight', 'thought-leadership',
    'resources', 'resource', 'resource-center',
    'guides', 'guide', 'ebooks', 'ebook', 'whitepapers', 'whitepaper',
    'case-studies', 'case-study', 'success-stories', 'success-story',
    'tips', 'tutorials', 'tutorial', 'how-to', 'how-tos',
    'podcast', 'podcasts', 'webinar', 'webinars', 'videos', 'video',
    'events', 'event', 'conference', 'conferences',
    'newsletter', 'newsletters', 'updates', 'announcements',
    'stories', 'story', 'learn', 'learning', 'education',
    'library', 'knowledge-base', 'kb', 'faq', 'faqs',
    'forum', 'forums', 'community', 'discussions',
    'media', 'media-center', 'press-releases',
}

# ── 3a. Slug lead words (first hyphen-word signals blog) ─────────────────────
BLOG_LEAD_WORDS = {
    # Question / interrogative
    'how', 'why', 'what', 'when', 'where', 'who', 'which', 'whether',
    # Modal / auxiliary verbs
    'is', 'are', 'was', 'were', 'will', 'would', 'can', 'could',
    'should', 'do', 'does', 'did', 'may', 'might',
    # Articles (editorial openers: "The Complete Guide...", "A New Approach...")
    'the', 'an',
    # Contractions without apostrophes
    'dont', 'cant', 'wont', 'isnt', 'arent', 'wasnt', 'didnt',
    'shouldnt', 'couldnt', 'wouldnt', 'havent', 'hasnt', 'hadnt',
    # Gerunds that open editorial content
    'building', 'creating', 'running', 'growing', 'managing', 'making',
    'finding', 'getting', 'using', 'choosing', 'comparing', 'picking',
    'becoming', 'turning', 'writing', 'reading', 'sending', 'moving',
    'setting', 'taking', 'giving', 'keeping', 'understanding', 'learning',
    'navigating', 'protecting', 'avoiding', 'preparing', 'addressing',
    'implementing', 'evaluating', 'identifying', 'recognising', 'recognizing',
    'overcoming', 'preventing', 'handling', 'clarifying', 'simplifying',
    'optimizing', 'leveraging', 'streamlining', 'maximizing', 'minimizing',
    # Action verbs that open blog/news titles
    'get', 'find', 'make', 'learn', 'discover', 'explore', 'understand',
    'read', 'see', 'check', 'avoid', 'stop', 'start', 'build', 'improve',
    'increase', 'boost', 'reduce', 'save', 'use', 'try', 'need', 'want',
    'become', 'grow', 'achieve', 'master', 'fix', 'solve', 'tackle', 'beat',
    'secure', 'protect', 'configure', 'integrate', 'automate', 'migrate',
    'deploy', 'troubleshoot', 'setup', 'upgrade', 'enable', 'disable',
}

# ── 3b. Mid-slug words that signal sentence structure ────────────────────────
BLOG_MID_WORDS = {
    # Prepositions / conjunctions / articles
    'in', 'the', 'for', 'with', 'of', 'and', 'or', 'to', 'an', 'by',
    'from', 'at', 'on', 'as', 'into', 'over', 'about',
    # Auxiliary / linking verbs
    'is', 'are', 'was', 'were', 'has', 'have', 'had',
    # Possessive / personal pronouns
    'your', 'our', 'their', 'my', 'its',
    # Third-person present verbs (sentence structure)
    'needs', 'takes', 'makes', 'gets', 'helps', 'keeps', 'shows',
    'means', 'works', 'comes', 'goes', 'lets', 'gives', 'puts',
    'sets', 'runs',
    # Month names (dated content)
    'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december',
}

# ── 3c. Anywhere-in-slug words that tilt toward blog ─────────────────────────
BLOG_ANYWHERE = {
    # Superlatives / list openers
    'best', 'top', 'worst', 'greatest', 'ultimate', 'complete',
    # Negative-framing (problem / failure content)
    'failures', 'failure', 'problems', 'problem', 'challenges', 'challenge',
    'risks', 'risk', 'myths', 'myth', 'mistakes', 'mistake',
    'dangers', 'danger', 'pitfalls', 'pitfall', 'warnings', 'warning',
    'misconceptions', 'misconception', 'stereotypes', 'stereotype',
    'issues', 'issue',
    # News / announcement verbs (press releases)
    'secures', 'achieves', 'wins', 'launches', 'announces', 'expands',
    'hires', 'partners', 'joins', 'receives', 'earns', 'reveals',
    'unveils', 'named', 'recognized', 'awarded', 'ranked', 'acquires',
    'raises', 'signs',
    # Editorial adjectives
    'new', 'latest', 'modern', 'upcoming', 'future', 'emerging',
    'innovative', 'revolutionary', 'groundbreaking', 'game',
    # List / tip words
    'tips', 'ways', 'reasons', 'steps', 'things', 'signs', 'ideas',
    'questions', 'examples', 'facts', 'benefits', 'types', 'differences',
    # Version / release words (software updates = blog)
    'update', 'updates', 'release', 'version', 'patch', 'rollout',
}

# ── File extensions to always drop ───────────────────────────────────────────
MEDIA_EXT = re.compile(
    r'\.(jpg|jpeg|png|gif|pdf|css|js|ico|svg|zip|xml|mp4|mp3|webp|woff|ttf)$',
    re.I
)


def _words(slug: str):
    """Split a hyphen/underscore slug into words, dropping single-char tokens."""
    return [w for w in re.split(r'[-_]', slug.lower()) if len(w) > 1]


def classify(url: str) -> Tuple[str, str]:
    """
    Returns (verdict, reason):
      verdict = 'keep' | 'drop'
      reason  = human-readable explanation
    """
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower().rstrip('/')
    segments = [s for s in path.split('/') if s]
    first = segments[0] if segments else ''
    leaf = segments[-1] if segments else ''

    # ── Media / file ─────────────────────────────────────────────────────────
    if MEDIA_EXT.search(path):
        return 'drop', 'media file'

    # ── Junk segments ────────────────────────────────────────────────────────
    if first in JUNK_SEGMENTS:
        return 'drop', f'junk segment: /{first}/'
    if any(s in JUNK_SEGMENTS for s in segments):
        matched = next(s for s in segments if s in JUNK_SEGMENTS)
        return 'drop', f'junk segment: /{matched}/'

    # ── Editorial section prefix ─────────────────────────────────────────────
    if first in EDITORIAL_SEGMENTS:
        return 'drop', f'editorial prefix: /{first}/'

    # ── Slug-level blog signals (applied to the leaf segment) ────────────────
    words = _words(leaf)
    if not words:
        return 'keep', 'homepage or root'

    # Leading digit in ANY segment (e.g. /4-frequently-visited-sites/, /5-reasons-why/...)
    for seg in segments:
        seg_words = _words(seg)
        if seg_words and seg_words[0].isdigit():
            return 'drop', f'segment starts with number: {seg_words[0]}'

    # 4-digit year anywhere (dated post)
    for w in words:
        if re.match(r'^(19|20)\d{2}$', w):
            return 'drop', f'year in slug: {w}'

    # "vs" anywhere — comparison articles (windows-vs-mac, managed-it-vs-break-fix)
    if 'vs' in words:
        return 'drop', 'comparison slug: "vs"'

    # Blog lead word (first word)
    if words[0] in BLOG_LEAD_WORDS:
        return 'drop', f'blog lead word: "{words[0]}"'

    # Mid-slug function/sentence words (3+ word slugs only)
    if len(words) >= 3:
        for w in words[1:]:
            if w in BLOG_MID_WORDS:
                return 'drop', f'sentence-structure word mid-slug: "{w}"'

    # Anywhere words (4+ word slugs)
    if len(words) >= 4:
        for w in words:
            if w in BLOG_ANYWHERE:
                return 'drop', f'blog keyword anywhere: "{w}"'

    # Very long slug (7+ words — almost always blog)
    if len(words) >= 7:
        return 'drop', f'slug too long ({len(words)} words)'

    return 'keep', ''


def filter_urls(urls: list, debug: bool = False) -> list:
    kept = []
    for url in urls:
        url = url.strip()
        if not url:
            continue
        verdict, reason = classify(url)
        if verdict == 'keep':
            kept.append(url)
        elif debug:
            print(f'  DROP  {reason:<45}  {url}', file=sys.stderr)
    return kept


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Pre-filter business website URLs')
    parser.add_argument('file', help='File of URLs (one per line), or - for stdin')
    parser.add_argument('--debug', action='store_true', help='Print drop reasons to stderr')
    args = parser.parse_args()

    src = sys.stdin if args.file == '-' else open(args.file)
    urls = src.readlines()
    if args.file != '-':
        src.close()

    kept = filter_urls(urls, debug=args.debug)
    for u in kept:
        print(u)

    if args.debug:
        total = len([u for u in urls if u.strip()])
        print(f'\n  Kept {len(kept)}/{total} URLs', file=sys.stderr)
