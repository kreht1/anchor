// Applied before first paint so a saved theme never flashes the other one.
window.ANCHOR_THEMES = [
  { id: 'anchor', name: 'Anchor White', family: 'soft', mood: 'Signature', tone: 'light', blurb: 'Warm paper white, ink black, one molten accent. The house style.' },
  { id: 'dark', tone: 'dark', name: 'Neon Deck', family: 'square', mood: 'Bold', blurb: 'Pure black, hard offset shadows, neon suits.' },
  { id: 'light', tone: 'light', name: 'Paper Deck', family: 'square', mood: 'Bold', blurb: 'The deck in daylight: white card stock, ink edges.' },
  { id: 'obsidian', tone: 'dark', name: 'Obsidian & Gold', family: 'soft', mood: 'Premium', blurb: 'Black lacquer, champagne gold, engraved serif.' },
  { id: 'swiss', tone: 'light', name: 'Swiss Grid', family: 'flat', mood: 'Professional', blurb: 'Paper, ink and one signal colour on a modular grid.' },
  { id: 'frost', tone: 'dark', name: 'Nordic Frost', family: 'soft', mood: 'Calm', blurb: 'Slate night, ice blue and a faint aurora.' },
  { id: 'rose', tone: 'light', name: 'Rosé Atelier', family: 'soft', mood: 'Elegant', blurb: 'Blush, champagne and mauve with italic serif titles.' },
  { id: 'sakura', tone: 'light', name: 'Sakura Mochi', family: 'soft', mood: 'Cute', blurb: 'Pastel candy, sticker shadows, polka dots.' },
  { id: 'bento', tone: 'light', name: 'Bento Pop', family: 'soft', mood: 'Playful', blurb: 'Cream, thick ink outlines, candy-coloured blocks.' },
  { id: 'synth', tone: 'dark', name: "Synthwave '84", family: 'soft', mood: 'Retro', blurb: 'Sunset gradient, neon grid floor, chrome titles.' },
  { id: 'phosphor', tone: 'dark', name: 'Phosphor', family: 'square', mood: 'Hacker', blurb: 'Green CRT glow, scanlines, monospace everything.' },
  { id: 'dragon', tone: 'dark', name: 'Dragonbone', family: 'square', mood: 'Fantasy', blurb: 'Weathered stone, bone and amber, carved small caps.' },
];
window.applyAnchorTheme = function (id, el) {
  if (id === 'axios') id = 'anchor';  // saved before the rename
  const t = window.ANCHOR_THEMES.find(x => x.id === id) || window.ANCHOR_THEMES[0];
  const root = el || document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.family = t.family;
  root.dataset.tone = t.tone || 'dark';
  return t;
};
try { window.applyAnchorTheme(new URLSearchParams(location.search).get('theme') || localStorage.getItem('mc-theme') || 'anchor'); } catch (e) { window.applyAnchorTheme('anchor'); }  // ?theme=<id> previews a theme without saving it
