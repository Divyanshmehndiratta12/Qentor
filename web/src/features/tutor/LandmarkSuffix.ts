/**
 * The Guide embeds a second view of the Tutor's conversation beside the Lab's own Tutor. Both show the same analysis cards, so the same
 * named regions (the actions section, each scrollable table) would be on the page twice, and a screen-reader user could not tell a landmark from
 * its twin. The embedded view passes a suffix (" (in the Guide)") and every landmark name in the Tutor's components appends it, so each
 * name on the page is unique. The default is empty: the Lab's Tutor keeps the names it always had.
 */
import { createContext } from 'react'

export const LandmarkSuffix = createContext('')
