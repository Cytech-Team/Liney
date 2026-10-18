#!/usr/bin/env python3
"""Generate self-hosted, theme-aware GitHub star charts from dated stargazers.

Requires only Python stdlib and GITHUB_TOKEN. Never invents historical data.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape

API = 'https://api.github.com'


def read_json(url: str, token: str):
    request = Request(url, headers={
        'Accept': 'application/vnd.github.star+json',
        'Authorization': f'Bearer {token}',
        'User-Agent': 'self-hosted-star-history/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response), response.headers.get('Link', '')


def fetch_stars(repo: str, token: str):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('Invalid owner/repository identifier')
    meta, _ = read_json(f'{API}/repos/{repo}', token)
    if meta.get('full_name', '').casefold() != repo.casefold():
        raise ValueError('Repository identity mismatch')
    total = meta['stargazers_count']
    dates = []
    url = f'{API}/repos/{repo}/stargazers?per_page=100'
    seen = set()
    while url:
        if url in seen or len(seen) > 5000:
            raise RuntimeError('Pagination loop or unexpectedly large star history')
        seen.add(url)
        records, links = read_json(url, token)
        if not isinstance(records, list):
            raise RuntimeError('GitHub stargazer API did not return a list')
        for record in records:
            if 'starred_at' not in record:
                raise RuntimeError('GitHub returned undated stars: refusing to fabricate chart')
            dates.append(dt.datetime.fromisoformat(record['starred_at'].replace('Z', '+00:00')).date())
        next_links = re.findall(r'<(https://api\.github\.com/[^>]+)>;\s*rel="next"', links)
        url = next_links[0] if next_links else None
    if len(dates) != total:
        raise RuntimeError(f'Count mismatch: {len(dates)} dated stars vs {total} stars; retry later')
    return sorted(dates)


def svg(repo: str, dates: list[dt.date], theme: str) -> str:
    dark = theme == 'dark'
    bg, panel = ('#0d1117', '#161b22') if dark else ('#ffffff', '#f6f8fa')
    fg, muted, grid = ('#f0f6fc', '#8b949e', '#30363d') if dark else ('#1f2328', '#656d76', '#d8dee4')
    accent, fill = ('#58a6ff', '#58a6ff') if dark else ('#0969da', '#0969da')
    w, h, left, right, top, bottom = 1100, 420, 78, 1034, 104, 334
    xs, ys = right-left, bottom-top
    # Stable output: scheduled runs don't create commits just because a day passed.
    latest_star = dates[-1] if dates else None
    grouped = collections.Counter(dates)
    first = (dates[0] - dt.timedelta(days=1)) if dates else dt.date(2000, 1, 1)
    last = (dates[-1] + dt.timedelta(days=1)) if dates else dt.date(2000, 1, 2)
    span = max(1, (last - first).days)
    ymax = max(1, len(dates))
    x = lambda day: left + (day - first).days * xs / span
    y = lambda value: bottom - value * ys / ymax
    path = [f'M {x(first):.1f},{y(0):.1f}']
    count = 0
    for day, added in sorted(grouped.items()):
        path.append(f'L {x(day):.1f},{y(count):.1f}')
        count += added
        path.append(f'L {x(day):.1f},{y(count):.1f}')
    path.append(f'L {x(last):.1f},{y(count):.1f}')
    shape = ' '.join(path)
    area = shape + f' L {right},{bottom} L {left},{bottom} Z'
    def e(s): return escape(str(s), {'"': '&quot;'})
    axis = []
    for i in range(5 if dates else 0):
        value = ymax * i / 4
        yy = y(value)
        axis.append(f'<line x1="{left}" y1="{yy:.1f}" x2="{right}" y2="{yy:.1f}" stroke="{grid}" stroke-width="1" />')
        axis.append(f'<text x="{left-13}" y="{yy+5:.1f}" text-anchor="end" fill="{muted}" font-size="15">{int(value) if value.is_integer() else f"{value:g}"}</text>')
    for i in range(5 if dates else 0):
        when = first + dt.timedelta(days=round(span * i / 4))
        xx = x(when)
        axis.append(f'<text x="{xx:.1f}" y="{bottom+29}" text-anchor="middle" fill="{muted}" font-size="15">{when:%b %Y}</text>')
    more = (f'<circle cx="{x(dates[-1]):.1f}" cy="{y(len(dates)):.1f}" r="5" fill="{accent}" />' if dates else
            f'<text x="{(left+right)//2}" y="{top+110}" text-anchor="middle" fill="{muted}" font-size="21">No stars yet</text>')
    title = f'{repo} · Star History'
    explanation = (f'{len(dates)} current stargazers, latest star {latest_star.isoformat() if latest_star else "none"}. ' +
                   'Dated using GitHub starred_at; unstars are not historically recoverable.')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{e(title)}">
<title>{e(title)}</title><desc>{e(explanation)}</desc>
<rect width="{w}" height="{h}" rx="18" fill="{bg}" />
<rect x="18" y="18" width="{w-36}" height="{h-36}" rx="14" fill="{panel}" stroke="{grid}" />
<g font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif">
<text x="{left}" y="64" fill="{fg}" font-size="26" font-weight="700">{e(repo)} · Stars</text>
<text x="{right}" y="64" text-anchor="end" fill="{accent}" font-size="24" font-weight="700">{len(dates):,} stars</text>
{''.join(axis)}
<path d="{area}" fill="{fill}" fill-opacity="0.10" />
<path d="{shape}" fill="none" stroke="{accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
{more}
<text x="{left}" y="{h-32}" fill="{muted}" font-size="13">GitHub stargazer timestamps · current stars only · generated from GitHub API</text>
</g></svg>
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY'))
    parser.add_argument('--output-dir', default='assets')
    args = parser.parse_args()
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if not token or not args.repo:
        parser.error('GITHUB_TOKEN and --repo (or GITHUB_REPOSITORY) are required')
    dates = fetch_stars(args.repo, token)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    for theme in ('light', 'dark'):
        target = out / f'star-history-{theme}.svg'
        data = svg(args.repo, dates, theme).encode('utf-8')
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
        print(f'{target}: {len(dates)} dated stars')


if __name__ == '__main__':
    try:
        main()
    except (HTTPError, URLError, ValueError, RuntimeError) as exc:
        print(f'Star History generation failed; keeping existing SVGs: {exc}', file=sys.stderr)
        sys.exit(1)
