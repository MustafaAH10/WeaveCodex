# Night Bloom poster — design notes

## Concept and palette

The poster pairs quiet editorial typography with an abstract botanical bloom. A large moon-coloured disc creates an atmospheric field behind the flower, while the sweeping stem and simplified leaves give the composition a clear upward movement. The design uses only the specified palette: ink `#101828` for the ground and flower centre, moon `#F8F5EC` for the disc and type, orchid `#8B5CF6` for petals and accents, and leaf `#2E7D5B` for the stem and leaves.

## Hierarchy

“Night Bloom” is the dominant two-line element at the upper left. The date is the next-largest event detail in the lower-left information block, followed by venue and admission. This separates the factual information from the botanical artwork while retaining a natural reading path from title to event details.

## Accessibility

The SVG has descriptive `<title>` and `<desc>` elements connected with `aria-labelledby`. All event facts are live SVG text rather than embedded imagery. The key text uses large sizes (192px event name, 61px date, 33px venue, and 27px admission) with high-contrast moon-on-ink treatment; the small supporting lines are secondary rather than essential event information. The file is self-contained and uses no external images, fonts, scripts, or network assets.
