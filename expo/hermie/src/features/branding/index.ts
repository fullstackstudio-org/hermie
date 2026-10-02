/**
 * The team's own look, as a service decides it (ADR-0025, part 2).
 *
 * Pure, and deliberately not a store: the name is read from the bootstrap on
 * every render and the two defaults are applied once, to a reader who has
 * chosen nothing.
 */
export {
  accentOrBrand,
  applyBranding,
  brandAccent,
  brandName,
  brandTheme,
  featureOn,
  setDefaultAccent,
  type BrandingTarget
} from './branding'
