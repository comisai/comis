// Web layer -- REST API, SSE streaming, and static file serving for the web dashboard

export { createRestApi, ActivityRingBuffer, subscribeActivityBuffer } from "./rest-api.js";
export type { RestApiDeps, ActivityEntry } from "./rest-api.js";

export { createSseEndpoint } from "./sse-endpoint.js";
export type { SseEndpointDeps } from "./sse-endpoint.js";

export { createStaticMiddleware } from "./static-middleware.js";

export { createMediaRoutes } from "./media-routes.js";
export type { MediaRoutesDeps } from "./media-routes.js";
