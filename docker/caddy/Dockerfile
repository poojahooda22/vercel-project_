# Caddy with the Cloudflare DNS plugin compiled in.
#
# The stock caddy image cannot issue a WILDCARD certificate. Let's Encrypt will
# only issue *.example.com via the DNS-01 challenge — their docs are explicit that
# HTTP-01 "cannot be used to issue wildcard certificates" — and DNS-01 means Caddy
# must create a TXT record, which needs a provider plugin. Caddy plugins are
# compiled in, not loaded at runtime, so this image exists.
#
# Only needed in production. Local dev uses plain http:// and no certificates.

FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
