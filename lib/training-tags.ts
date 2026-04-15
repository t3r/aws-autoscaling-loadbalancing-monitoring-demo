/**
 * Default tags for the demo stack (stack-level + `cdk.Tags` on launched resources).
 * Single source of truth for tests and `AutoscalingDemoStack`.
 */
export const AUTOSCALING_DEMO_TRAINING_TAGS: Record<string, string> = {
  't3r:training': 'cloudops',
  't3r:purpose': 'training',
};
