# Night Bloom — design notes

## Art direction

The poster takes a quiet editorial approach: a deep ink field gives the page a night-time stillness, while a cropped, abstract botanical construction grows upward through the lower half. Leaf-green stems and leaves establish a calm structure; an orchid-purple geometric flower supplies the focal burst. All illustration is native SVG geometry, so the work remains original and self-contained.

## Hierarchy

“Night Bloom” is the largest element and sits in the upper-middle field with generous open space. “17 October” follows immediately below at the next largest scale. The venue, “Riverside Makers Hall,” is placed near the base, followed by the supporting admission message, “Free entry.” This makes the intended reading order clear: event name, date, venue, then admission.

## Palette

- Ink `#101828` provides the background.
- Moon `#F8F5EC` carries the required event text and fine highlights.
- Orchid `#8B5CF6` forms the bloom and a small rule accent.
- Leaf `#2E7D5B` forms stems and foliage.

## Accessibility and delivery

The SVG uses a `1200 × 1600` canvas and includes a programmatic `<title>` and `<desc>` via `aria-labelledby`. Event information is native text rather than embedded in imagery, and the principal moon-on-ink typography uses readable, generously sized text. The botanical motif is marked decorative with `aria-hidden="true"`, leaving the title, description, and text content to communicate all essential information. The file has no external images, fonts, scripts, or network assets; it relies only on inline SVG shapes and generic system font fallbacks.
