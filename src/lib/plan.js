// Single source of truth for the user's plan info.
// Placeholder until a real plans/profiles table is wired up — swap this
// for a Supabase query (or a usePlan() hook around one) when ready.
export const PLAN = {
  tier: 'Free',
  features: [
    'Up to 5 documents',
    'Basic search',
    'Community support',
  ],
};
