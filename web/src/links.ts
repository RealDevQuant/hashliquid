// Outside links shown in the header and footer. Leave one empty and its link stays hidden.
export const LINKS = {
  x: '',      // e.g. 'https://x.com/hashliquid'
  chart: '',  // e.g. a Dexscreener or Birdeye page
}

/** Fills every <a data-link="…"> on the page, or leaves it hidden when the address isn't set. */
export function wireLinks() {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-link]'))) {
    const href = LINKS[a.dataset.link as keyof typeof LINKS]
    if (href) { a.href = href; a.hidden = false }
  }
}
