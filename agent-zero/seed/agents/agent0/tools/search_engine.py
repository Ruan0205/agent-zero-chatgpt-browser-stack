"""Search with the configured SearXNG and a bounded public-web fallback.

The local SearXNG instance may return an empty result set when all upstream
engines are suspended/CAPTCHA-blocked. An empty string falsely looks like a
successful search to the agent; surface a real result or an explicit failure.
"""

from __future__ import annotations

from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup
from tools.search_engine import SearchEngine as BaseSearchEngine


def parse_bing_results(html: str, limit: int = 5) -> list[tuple[str, str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    results: list[tuple[str, str, str]] = []
    for item in soup.select("li.b_algo"):
        heading = item.select_one("h2 a[href]")
        if heading is None:
            continue
        url = str(heading.get("href") or "").strip()
        if urlparse(url).scheme not in {"http", "https"}:
            continue
        title = heading.get_text(" ", strip=True)
        if not title:
            continue
        snippet_node = item.select_one(".b_caption p") or item.select_one("p")
        snippet = snippet_node.get_text(" ", strip=True) if snippet_node else ""
        results.append((title, url, snippet))
        if len(results) >= limit:
            break
    return results


async def fetch_bing_results(question: str) -> list[tuple[str, str, str]]:
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            "https://www.bing.com/search",
            params={"q": question},
            headers={"User-Agent": "Mozilla/5.0 (compatible; AgentZeroSearch/1.0)"},
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            return parse_bing_results(await response.text())


class SearchEngine(BaseSearchEngine):
    async def searxng_search(self, question: str) -> str:
        primary = ""
        try:
            primary = await super().searxng_search(question)
        except Exception as exc:
            primary = f"SearXNG indisponível: {type(exc).__name__}: {exc}"
        if primary.strip() and not primary.startswith("Search Engine search failed:"):
            return primary

        try:
            results = await fetch_bing_results(question)
            if results:
                return "\n\n".join(
                    f"{title}\n{url}\n{snippet}" for title, url, snippet in results
                )
            failure = "fallback Bing sem resultados interpretáveis"
        except (aiohttp.ClientError, TimeoutError, RuntimeError) as exc:
            failure = f"fallback Bing indisponível: {type(exc).__name__}: {exc}"
        return f"Pesquisa sem resultados. SearXNG: {primary or 'vazio'}. {failure}."
