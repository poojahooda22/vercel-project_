// The three backend services. Ports are fixed by each service's own listen():
//   3000 upload service, 3001 request handler, 3002 this frontend.
export const UPLOAD_SERVICE =
  process.env.NEXT_PUBLIC_UPLOAD_SERVICE ?? "http://localhost:3000";

export const REQUEST_HANDLER_HOST =
  process.env.NEXT_PUBLIC_REQUEST_HANDLER_HOST ?? "localhost:3001";

// Local deployments are served over plain http on *.localhost; production ones sit
// behind Caddy's wildcard certificate. The scheme has to follow the host rather than
// be a literal — an https dashboard emitting http links makes every "Visit" click a
// cleartext first hop that Caddy then has to redirect, and no environment variable
// can correct a hardcoded scheme.
//
// Derived from the host rather than shipped as its own NEXT_PUBLIC_* build arg: the
// two can never legitimately disagree, so a second variable would only add a way to
// build an image whose links are wrong.
const HOST_IS_LOCAL = /^(localhost|127\.0\.0\.1)(:|$)/.test(REQUEST_HANDLER_HOST);

// A deployment is served from its own subdomain root. The "/index.html" suffix
// this used to carry was a workaround for the handler 404ing on "/", which it
// no longer does.
export function deployedUrl(id: string): string {
  return `${HOST_IS_LOCAL ? "http" : "https"}://${id}.${REQUEST_HANDLER_HOST}/`;
}
