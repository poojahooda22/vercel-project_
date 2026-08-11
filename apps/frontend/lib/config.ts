// The three backend services. Ports are fixed by each service's own listen():
//   3000 upload service, 3001 request handler, 3002 this frontend.
export const UPLOAD_SERVICE =
  process.env.NEXT_PUBLIC_UPLOAD_SERVICE ?? "http://localhost:3000";

export const REQUEST_HANDLER_HOST =
  process.env.NEXT_PUBLIC_REQUEST_HANDLER_HOST ?? "localhost:3001";

// A deployment is served from its own subdomain root. The "/index.html" suffix
// this used to carry was a workaround for the handler 404ing on "/", which it
// no longer does.
export function deployedUrl(id: string): string {
  return `http://${id}.${REQUEST_HANDLER_HOST}/`;
}
