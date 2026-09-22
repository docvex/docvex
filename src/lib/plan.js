// Single source of truth for the user's plan info.
// Placeholder until a real plans/profiles table is wired up — swap this
// for a Supabase query (or a usePlan() hook around one) when ready.
// The monthly AI allowance a project's usage is measured against — tokens sent
// to the model plus tokens generated (get_project_ai_usage). Read by the title
// bar's AI usage meter and the Overview's AI gauges.
export const AI_MONTHLY_TOKENS = 750000;

export const PLAN = {
  tier: 'Free',
  features: [
    'Up to 5 documents',
    'Basic search',
    'Community support',
  ],
};
