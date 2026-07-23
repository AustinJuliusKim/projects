// CloudWatch RUM (Growth Plan §10): first-party frontend error + performance
// telemetry — the canary can't see client-side breakage. Config-dormant like
// the other integrations: without VITE_RUM_MONITOR_ID at build time the
// condition below is statically false, Vite dead-code-eliminates the dynamic
// import, and nothing RUM-related ships in the bundle. Cookies stay off —
// "no tracking" is a feature; this is error/perf telemetry, not analytics
// (business analytics ride the event lake).
export function initRum() {
  if (!import.meta.env.VITE_RUM_MONITOR_ID) return;
  const region = import.meta.env.VITE_RUM_REGION || "us-west-2";
  import("aws-rum-web")
    .then(({ AwsRum }) => {
      new AwsRum(import.meta.env.VITE_RUM_MONITOR_ID, "1.0.0", region, {
        identityPoolId: import.meta.env.VITE_RUM_IDENTITY_POOL_ID,
        guestRoleArn: import.meta.env.VITE_RUM_GUEST_ROLE_ARN || undefined,
        endpoint: `https://dataplane.rum.${region}.amazonaws.com`,
        telemetries: ["errors", "performance"],
        allowCookies: false,
        enableXRay: false,
        sessionSampleRate: 1,
      });
    })
    .catch(() => {}); // best-effort — RUM must never block the app
}
