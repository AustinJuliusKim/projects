// Pure routing logic for the choices-webapp preview edge router, tested via
// `node --test` (see router.test.mjs).
//
// IMPORTANT: this file is NOT what gets deployed. Lambda@Edge functions
// cannot use environment variables at all (confirmed against AWS docs:
// "Restrictions on Lambda@Edge" -> "Lambda features"), and CloudFormation
// can only template deploy-time parameter values (including the NoEcho
// OriginVerifySecret, which must never be committed to this public repo)
// into an *inline* Lambda Code.ZipFile/InlineCode property -- it has no way
// to substitute values into a CodeUri-zipped file's contents, since that zip
// is built and uploaded before CloudFormation resolves any parameters. So
// ../edge-preview-router.yaml carries a second, hand-synced copy of this
// exact logic inline (with config values baked in via Fn::Sub) as the
// actually-deployed code. Keep both copies in sync on any logic change --
// this file is the one covered by tests, the inline copy is the one that
// runs.

/**
 * Routes a CloudFront origin-request event to the choices-webapp preview
 * stack's own origins when the Host header matches the preview alias;
 * every other Host passes through unchanged (prod path unaffected).
 *
 * @param {object} request - event.Records[0].cf.request (mutated in place, also returned)
 * @param {object} config
 * @param {string} config.previewHost - e.g. preview.choices.austinjuliuskim.com
 * @param {string} config.apiDomain - preview stack's Lambda Function URL domain (no scheme/path)
 * @param {string} config.apiSecret - preview stack's OriginVerifySecret (sent as x-origin-verify)
 * @param {string} config.s3Domain - preview stack's SiteBucket regional REST domain
 * @param {string} config.s3Secret - preview stack's OriginVerifySecret (sent as Referer -- S3's
 *   one native bucket-policy condition key for this; see apps/choices-webapp/template.yaml's
 *   PreviewSiteBucketPolicy for why this is a custom origin, not an S3-type origin with OAC/OAI)
 * @returns {object} the (possibly mutated) request
 */
export function routeRequest(request, config) {
  const hostHeader =
    request.headers.host && request.headers.host[0] && request.headers.host[0].value;
  if (hostHeader !== config.previewHost) {
    return request; // not the preview alias -- no-op, prod path unaffected
  }

  const isApi = request.uri.startsWith("/api") || request.uri.startsWith("/j/");

  if (isApi) {
    request.origin = {
      custom: {
        domainName: config.apiDomain,
        port: 443,
        protocol: "https",
        path: "",
        sslProtocols: ["TLSv1.2"],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: config.apiSecret
          ? { "x-origin-verify": [{ key: "x-origin-verify", value: config.apiSecret }] }
          : {},
      },
    };
    request.headers.host = [{ key: "host", value: config.apiDomain }];
    return request;
  }

  // SPA/static path: strip the cache-key prefix SpaRewriteFunction added
  // (apps/choices-webapp/template.yaml) before routing to preview's bucket.
  request.uri = request.uri.replace(/^\/__preview/, "") || "/";
  request.origin = {
    custom: {
      domainName: config.s3Domain,
      port: 443,
      protocol: "https",
      path: "",
      sslProtocols: ["TLSv1.2"],
      readTimeout: 30,
      keepaliveTimeout: 5,
      customHeaders: config.s3Secret
        ? { referer: [{ key: "Referer", value: config.s3Secret }] }
        : {},
    },
  };
  request.headers.host = [{ key: "host", value: config.s3Domain }];
  return request;
}
